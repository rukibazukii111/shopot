const {app, BrowserWindow, ipcMain, dialog, clipboard, globalShortcut, session, Tray, Menu, nativeImage, powerSaveBlocker, screen, systemPreferences} = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const crypto = require('node:crypto');
const {Store} = require('./store.cjs');
const {Worker} = require('./worker.cjs');
const {PasteService} = require('./paste.cjs');
const {createNativeBackend} = require('./native-input.cjs');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SHOPOT_DATA_DIR || (app.isPackaged ? path.join(app.getPath('appData'), 'Shopot') : path.join(root, '.local')));
app.setPath('userData', dataDir);
const audioDir = path.join(dataDir, 'audio');
const uiUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
const widgetUrl = pathToFileURL(path.join(root, 'renderer', 'widget.html')).href;
const shortcut = 'CommandOrControl+Shift+Space';
let window, widget, tray, worker, store, paste, capture, busy = false, blocker, quitting = false, engineError = null;
let hotkeyRegistered = false;
let nativeAvailable = false;
let widgetTimer, activeTranscription, job = 0;
let widgetState = {phase: 'requesting', shortcut: process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl⇧Space'};

function send(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== uiUrl) throw new Error('Недопустимый источник команды');
}
function ipc(name, handler) { ipcMain.handle(name, (event, value) => { trusted(event); return handler(value); }); }
function pastePermission() { return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false); }
function snapshot() { return {...store.data, engine: worker.status, engineError, busy, hotkeyRegistered, nativeAvailable, pastePermission: pastePermission(), platform: process.platform}; }
function modelId(id) { if (!['small', 'turbo', 'large-v3'].includes(id)) throw new Error('Неизвестная модель'); return id; }
function textValue(value) { if (typeof value !== 'string' || value.length > 200000) throw new Error('Недопустимый текст'); return value; }
function entryFor(id) { const entry = store.data.history.find(e => e.id === id); if (!entry) throw new Error('Запись не найдена'); return entry; }
function audioFor(entry) {
  if (!entry.audioFile || !/^[a-f0-9-]+\.(wav|webm|mp3|m4a|ogg|flac|mp4)$/i.test(entry.audioFile)) return null;
  return path.join(audioDir, entry.audioFile);
}
function pendingFor(id) {
  const entry = store.data.pendingRecordings.find(e => e.id === id);
  if (!entry) throw new Error('Незавершённая запись не найдена');
  return entry;
}
function forgetRecording(audioFile) {
  store.data.pendingRecordings = store.data.pendingRecordings.filter(e => e.audioFile !== audioFile);
  store.save();
}
function setBusy(value) {
  busy = value;
  if (value && blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  else if (!value && blocker !== undefined && !capture) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}
function updateTray(label = 'Шёпот') { if (tray) tray.setToolTip(label); }
function hideWidget() { clearTimeout(widgetTimer); widget?.hide(); }
function showWidget(value, show = true) {
  clearTimeout(widgetTimer);
  widgetState = {...widgetState, ...value};
  if (!widget || widget.isDestroyed()) return;
  widget.webContents.send('widget-state', widgetState);
  if (show && !widget.isVisible()) {
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
    widget.setPosition(Math.round(area.x + (area.width - 384) / 2), area.y + area.height - 138);
    widget.showInactive();
  }
  if (show && ['success', 'error', 'canceled'].includes(value.phase)) widgetTimer = setTimeout(hideWidget, 3000);
}
function finishCapture(value) {
  const previous = capture; capture = null;
  if (previous?.target) paste.release(previous.target);
  globalShortcut.unregister('Escape'); setBusy(busy); updateTray();
  hideWidget();
  if (previous?.global) showWidget(value, value.phase === 'error');
}
function beginCapture(global = false) {
  if (busy || capture) throw new Error('Дождись завершения текущей операции');
  if (!worker.status) throw new Error('Движок ещё запускается. Попробуй через несколько секунд.');
  if (!worker.status.models?.find(m => m.id === store.data.settings.model)?.installed) throw new Error('Сначала скачай модель в Шёпоте');
  capture = {id: crypto.randomUUID(), global, target: global ? paste.capture() : null, phase: 'requesting',
    settings: structuredClone(store.data.settings), dictionary: structuredClone(store.data.dictionary)};
  if (blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  globalShortcut.register('Escape', () => { hideWidget(); send('cancel-recording'); });
  if (global) showWidget({phase: 'requesting', elapsed: 0, level: 0, message: '', hint: ''});
  return {id: capture.id, settings: capture.settings};
}
function toggleGlobalRecording() {
  if (capture) {
    if (['requesting', 'recording'].includes(capture.phase)) {
      capture.phase = 'stopping'; hideWidget(); send('toggle-recording');
    }
    return;
  }
  try { send('toggle-recording', beginCapture(true)); }
  catch (error) { showWidget({phase: 'error', message: error.message, hint: 'Открой Шёпот, чтобы продолжить', elapsed: 0}); }
}
function createWidget() {
  widget = new BrowserWindow({width: 384, height: 110, show: false, frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: true, focusable: false, resizable: false, maximizable: false, minimizable: false, hasShadow: false,
    webPreferences: {preload: path.join(__dirname, 'widget-preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, backgroundThrottling: false}});
  widget.setAlwaysOnTop(true, 'floating');
  if (process.platform === 'darwin') widget.setVisibleOnAllWorkspaces(true, {visibleOnFullScreen: true});
  widget.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  widget.webContents.on('will-navigate', (event, url) => { if (url !== widgetUrl) event.preventDefault(); });
  widget.on('close', event => { if (!quitting) { event.preventDefault(); widget.hide(); } });
  widget.loadURL(widgetUrl);
  const trustedWidget = event => event.sender === widget.webContents && event.senderFrame?.url === widgetUrl;
  ipcMain.handle('widget-boot', event => { if (!trustedWidget(event)) throw new Error('Недопустимый источник'); return widgetState; });
  ipcMain.on('widget-action', (event, action) => {
    if (!trustedWidget(event)) return;
    if (action === 'stop' && capture?.phase === 'recording') toggleGlobalRecording();
    if (action === 'cancel' && capture) { hideWidget(); send('cancel-recording'); }
    if (action === 'hide' && !capture) widget.hide();
    if (action === 'open') { window.show(); window.focus(); widget.hide(); }
  });
}
function createWindow() {
  window = new BrowserWindow({width: 1240, height: 850, minWidth: 1000, minHeight: 720,
    title: 'Шёпот — локальная диктовка', backgroundColor: '#f6f7f9', autoHideMenuBar: true, icon: path.join(root, 'renderer', 'app-icon.png'),
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, spellcheck: false}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => {
    ++job; worker?.restart(); busy = false;
    finishCapture({phase: 'error', message: 'Окно записи перезапустилось', hint: 'Повтори диктовку'});
    window.reload();
  });
  window.on('close', event => { if (!quitting && tray) { event.preventDefault(); window.hide(); } });
  window.webContents.once('did-finish-load', createWidget);
  window.loadURL(uiUrl);
}

async function runTranscription(filePath, source, recordingSession = null, retry = false) {
  const currentJob = ++job;
  const audioFile = path.basename(filePath);
  const task = {canceled: false}; activeTranscription = task;
  let completed = false, canceled = false;
  setBusy(true);
  const settings = recordingSession?.settings || structuredClone(store.data.settings);
  const dictionary = recordingSession?.dictionary || structuredClone(store.data.dictionary);
  if (recordingSession) {
    recordingSession.phase = 'transcribing';
    if (recordingSession.global) { hideWidget(); showWidget({phase: 'transcribing', message: '', level: 0}, false); }
  }
  try {
    // Journal before inference: a worker/app crash must leave audio available for retry.
    if (!store.data.pendingRecordings.some(e => e.audioFile === audioFile)) {
      store.data.pendingRecordings.push({id: crypto.randomUUID(), audioFile, source, createdAt: new Date().toISOString()});
      store.save();
    }
    const result = await worker.request('transcribe', {audioFile, ...settings, dictionary});
    if (currentJob !== job) { canceled = task.canceled; return {canceled: true}; }
    if (result.noSpeech) {
      completed = true;
      if (recordingSession) finishCapture({phase: 'error', message: 'Речь не обнаружена', hint: 'Попробуй говорить ближе к микрофону'});
      return {noSpeech: true};
    }
    const entry = {id: crypto.randomUUID(), createdAt: new Date().toISOString(), source,
      mode: settings.mode, ...result, audioFile: settings.keepAudio ? path.basename(filePath) : null};
    store.addHistory(entry);
    completed = true;
    const delivery = await paste.deliver(entry.text, {autoCopy: settings.autoCopy,
      autoPaste: Boolean(recordingSession?.global && settings.autoPaste), target: recordingSession?.target}, () => currentJob === job);
    send('snapshot', snapshot());
    if (recordingSession && currentJob === job) finishCapture({phase: delivery.pasted || ['saved', 'copied'].includes(delivery.code) ? 'success' : 'error', message: delivery.message, hint: delivery.pasted ? 'Можно продолжать писать' : 'Текст доступен в истории'});
    return {entry, ...delivery};
  } catch (error) {
    if (currentJob !== job) { canceled = task.canceled; return {canceled: true}; }
    if (recordingSession) finishCapture({phase: 'error', message: 'Не удалось распознать запись', hint: 'Аудио сохранено. Повтори распознавание в Шёпоте.'});
    throw error;
  } finally {
    if (activeTranscription === task) activeTranscription = null;
    if (completed || (canceled && !retry)) forgetRecording(audioFile);
    const retained = [...store.data.history, ...store.data.pendingRecordings].some(e => e.audioFile === audioFile);
    if (!retained && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    if (currentJob === job) setBusy(false);
    send('snapshot', snapshot());
  }
}

if (!app.requestSingleInstanceLock()) { app.quit(); }
else {
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(() => {
    fs.mkdirSync(audioDir, {recursive: true});
    try { store = new Store(dataDir); }
    catch (error) { dialog.showErrorBox('Шёпот', error.message); app.quit(); return; }
    // Recover interrupted captures, including files saved just before a crash.
    const retained = new Set(store.data.history.map(e => e.audioFile).filter(Boolean));
    const previousPending = JSON.stringify(store.data.pendingRecordings);
    store.data.pendingRecordings = store.data.pendingRecordings.filter(e => {
      const file = audioFor(e); return file && fs.existsSync(file) && !retained.has(e.audioFile);
    });
    const pending = new Set(store.data.pendingRecordings.map(e => e.audioFile));
    for (const name of fs.readdirSync(audioDir)) {
      if (/^[a-f0-9-]+\.(webm|wav|mp3|m4a|ogg|flac|mp4)$/i.test(name) && !retained.has(name) && !pending.has(name)) {
        const stat = fs.statSync(path.join(audioDir, name));
        if (stat.isFile()) store.data.pendingRecordings.push({id: crypto.randomUUID(), audioFile: name, source: 'Незавершённая запись', createdAt: stat.mtime.toISOString()});
      }
    }
    if (JSON.stringify(store.data.pendingRecordings) !== previousPending) store.save();
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === window?.webContents && contents.getURL() === uiUrl && permission === 'media' &&
        !details.mediaTypes?.includes('video'));
    });
    session.defaultSession.setPermissionCheckHandler((contents, permission) => contents === window?.webContents && contents.getURL() === uiUrl && permission === 'media');
    // The renderer has no reason to contact the network. Downloads live in the worker.
    session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']}, (_, callback) => callback({cancel: true}));
    let native;
    try { native = createNativeBackend(); nativeAvailable = true; } catch (error) { console.error('Автовставка недоступна:', error.message); }
    paste = new PasteService({clipboard, native});
    createWindow();
    worker = new Worker({root, dataDir, resourcesPath: process.resourcesPath, packaged: app.isPackaged});
    worker.on('ready', status => { engineError = null; send('engine', {status}); });
    worker.on('progress', event => {
      send('progress', event);
      if (capture?.global && capture.phase === 'transcribing') showWidget({phase: 'transcribing', message: event.message || 'Распознаю на устройстве'}, false);
    });
    worker.on('offline', error => { engineError = error; send('engine', {error}); });
    try { worker.start(); } catch (error) { engineError = error.message; }

    // NativeImage supports PNG reliably on all desktop targets; generated asset is bundled.
    const trayPath = path.join(root, 'renderer', 'tray.png');
    if (fs.existsSync(trayPath)) {
      tray = new Tray(nativeImage.createFromPath(trayPath));
      tray.setToolTip('Шёпот — локальная диктовка');
      tray.setContextMenu(Menu.buildFromTemplate([
        {label: 'Открыть Шёпот', click: () => { window.show(); window.focus(); }},
        {label: 'Начать / закончить диктовку', click: toggleGlobalRecording},
        {type: 'separator'}, {label: 'Выйти', click: () => { quitting = true; app.quit(); }},
      ]));
      tray.on('click', () => { window.show(); window.focus(); });
    }
    hotkeyRegistered = globalShortcut.register(shortcut, toggleGlobalRecording);
    ipc('begin-recording', () => beginCapture());
    ipcMain.on('capture-update', (event, value) => {
      trusted(event);
      if (!capture || value?.id !== capture.id) return;
      if (['error', 'canceled'].includes(value.phase)) {
        finishCapture({phase: value.phase, message: value.phase === 'canceled' ? 'Запись отменена' : 'Микрофон недоступен', hint: String(value.message || '').slice(0, 240)});
      } else if ((value.phase === 'recording' && ['requesting', 'recording'].includes(capture.phase)) ||
                 (value.phase === 'stopping' && ['recording', 'stopping'].includes(capture.phase))) {
        capture.phase = value.phase;
        if (value.phase === 'stopping') hideWidget();
        if (capture.global) showWidget({phase: value.phase, message: '', elapsed: Math.max(0, Math.min(900, Number(value.elapsed) || 0)), level: Math.max(0, Math.min(1, Number(value.level) || 0))}, value.phase === 'recording');
        updateTray(value.phase === 'recording' ? 'Шёпот — идёт запись. Escape: отмена' : 'Шёпот — распознаю запись. Escape: отмена');
      }
    });

    ipc('boot', snapshot);
    ipc('paste-permission', () => {
      if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
      return pastePermission();
    });
    ipc('settings', value => store.setSettings(value));
    ipc('dictionary', value => store.setDictionary(value));
    ipc('download', async id => {
      if (busy || capture) throw new Error('Дождись завершения текущей операции');
      const currentJob = ++job;
      setBusy(true);
      try {
        const status = await worker.request('download', {model: modelId(id)});
        worker.status = status; send('engine', {status}); return status;
      } finally { if (currentJob === job) setBusy(false); }
    });
    ipc('cancel', () => {
      if (activeTranscription) activeTranscription.canceled = true;
      ++job;
      if (busy) { worker.restart(); send('engine', {status: null}); }
      busy = false; finishCapture({phase: 'canceled', message: 'Операция отменена', hint: 'Микрофон выключен'});
      return true;
    });
    ipc('transcribe', async value => {
      if (busy) throw new Error('Распознавание уже запущено');
      if (!capture || capture.id !== value?.id) throw new Error('Эта запись уже завершена или отменена');
      const audio = value.audio;
      if (!(audio instanceof Uint8Array) || !audio.length || audio.length > 100 * 1024 * 1024) throw new Error('Недопустимая аудиозапись');
      const file = path.join(audioDir, crypto.randomUUID() + '.webm');
      fs.writeFileSync(file, audio, {mode: 0o600});
      return runTranscription(file, 'Микрофон', capture);
    });
    ipc('import-audio', async () => {
      if (busy || capture) throw new Error('Дождись завершения записи');
      let importJob = ++job;
      setBusy(true);
      try {
        const result = await dialog.showOpenDialog(window, {title: 'Распознать аудиофайл', properties: ['openFile'],
          filters: [{name: 'Аудио и видео', extensions: ['wav', 'mp3', 'm4a', 'webm', 'ogg', 'flac', 'mp4']}]});
        if (result.canceled) return {canceled: true};
        const original = result.filePaths[0];
        if (fs.statSync(original).size > 100 * 1024 * 1024) throw new Error('Выбери файл до 100 МБ');
        const extension = path.extname(original).toLowerCase();
        if (!['.wav', '.mp3', '.m4a', '.webm', '.ogg', '.flac', '.mp4'].includes(extension)) throw new Error('Этот формат пока не поддерживается');
        const local = path.join(audioDir, crypto.randomUUID() + extension);
        fs.copyFileSync(original, local);
        importJob = job + 1;
        return await runTranscription(local, path.basename(original));
      } finally { if (importJob === job) setBusy(false); }
    });
    ipc('retry-recording', id => {
      if (busy || capture) throw new Error('Дождись завершения текущей операции');
      const entry = pendingFor(id), file = audioFor(entry);
      if (!file || !fs.existsSync(file)) throw new Error('Аудиозапись не найдена');
      return runTranscription(file, entry.source, null, true);
    });
    ipc('delete-recording', async id => {
      if (busy || capture) throw new Error('Дождись завершения текущей операции');
      const entry = pendingFor(id);
      const answer = await dialog.showMessageBox(window, {type: 'question', message: 'Удалить незавершённую запись?',
        detail: 'Аудио будет удалено с этого компьютера.', buttons: ['Оставить', 'Удалить'], defaultId: 0, cancelId: 0});
      if (answer.response !== 1) return false;
      if (busy || capture) throw new Error('Дождись завершения текущей операции');
      const file = audioFor(entry); if (file && fs.existsSync(file)) fs.unlinkSync(file);
      forgetRecording(entry.audioFile); send('snapshot', snapshot()); return true;
    });
    ipc('copy', async value => { await clipboard.writeText(textValue(value)); return true; });
    ipc('save-text', async value => {
      const text = textValue(value);
      const result = await dialog.showSaveDialog(window, {defaultPath: 'Диктовка.txt', filters: [{name: 'Текст', extensions: ['txt']}]});
      if (result.canceled) return false;
      fs.writeFileSync(result.filePath, text, 'utf8'); return true;
    });
    ipc('update-entry', value => { const entry = entryFor(value.id); entry.text = textValue(value.text); store.save(); return entry; });
    ipc('delete-entry', async id => {
      const entry = entryFor(id);
      const answer = await dialog.showMessageBox(window, {type: 'question', message: 'Удалить эту диктовку?',
        detail: 'Текст и сохранённая аудиозапись будут удалены с этого компьютера.', buttons: ['Оставить', 'Удалить'], defaultId: 0, cancelId: 0});
      if (answer.response !== 1) return false;
      store.data.history = store.data.history.filter(e => e.id !== id); store.save();
      const audio = audioFor(entry); if (audio && fs.existsSync(audio)) fs.unlinkSync(audio);
      return true;
    });
    ipc('read-audio', id => { const file = audioFor(entryFor(id)); return file && fs.existsSync(file) ? fs.readFileSync(file) : null; });
  });
}
app.on('activate', () => { if (window) window.show(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { clearTimeout(widgetTimer); globalShortcut.unregisterAll(); worker?.stop(); if (capture?.target) paste?.release(capture.target); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
