const {app, BrowserWindow, ipcMain, dialog, clipboard, desktopCapturer, globalShortcut, session, Tray, Menu, nativeImage, nativeTheme, powerSaveBlocker, screen, systemPreferences} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const crypto = require('node:crypto');
const {Store, MODEL_IDS, settingsFor} = require('./store.cjs');
const {Worker} = require('./worker.cjs');
const {PasteService, clipboardText} = require('./paste.cjs');
const {createNativeBackend} = require('./native-input.cjs');
const {suggestCorrections} = require('./corrections.cjs');
const {exportText} = require('./export.cjs');
const {MicWatcher, meetingTurns, meetingText, summaryPrompt} = require('./meetings.cjs');

const root = path.resolve(__dirname, '..');
const dataDir = path.resolve(process.env.SHOPOT_DATA_DIR || (app.isPackaged ? path.join(app.getPath('appData'), 'Shopot') : path.join(root, '.local')));
app.setPath('userData', dataDir);
const audioDir = path.join(dataDir, 'audio');
const uiUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
const widgetUrl = pathToFileURL(path.join(root, 'renderer', 'widget.html')).href;
const shortcut = 'CommandOrControl+Shift+Space';
let window, widget, tray, worker, store, paste, capture, busy = false, blocker, quitting = false, engineError = null;
let hotkeyRegistered = false;
let nativeAvailable = false, nativeBackend = null;
// Holding the hotkey longer than this makes it push-to-talk: letting go ends the recording.
const HOLD_MS = 450;
let hold = null;
let widgetTimer, activeTranscription, downloading = false, job = 0;
// Calls are recorded on Windows only for now: that is where Electron captures system audio (WASAPI loopback).
const MEETINGS = process.platform === 'win32';
const MEETING_CHUNK_MS = (Number(process.env.SHOPOT_MEETING_CHUNK_SECONDS) || 300) * 1000;
const MIC_POLL_MS = Number(process.env.SHOPOT_MIC_POLL_MS) || 4000;
let meeting = null, offer = null, offerTimer, meetingClock, micWatcher = null, meetingQueue = Promise.resolve();
let widgetState = {phase: 'requesting', shortcut: process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl⇧Space'};

function send(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== uiUrl) throw new Error('Недопустимый источник команды');
}
function ipc(name, handler) { ipcMain.handle(name, (event, value) => { trusted(event); return handler(value); }); }
function pastePermission() { return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false); }
function meetingState() { return meeting ? {app: meeting.app?.name ?? null, startedAt: meeting.startedAt, stopping: meeting.stopping} : null; }
function snapshot() { return {...store.data, engine: worker.status, engineError, busy, hotkeyRegistered, nativeAvailable, pastePermission: pastePermission(), platform: process.platform, totalMemory: os.totalmem(), meeting: meetingState(), meetingsSupported: MEETINGS}; }
function modelId(id) { if (!MODEL_IDS.includes(id)) throw new Error('Неизвестная модель'); return id; }
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
  else if (!value && blocker !== undefined && !capture && !meeting) { powerSaveBlocker.stop(blocker); blocker = undefined; }
}
function updateTray(label = 'Шёпот') { if (tray) tray.setToolTip(label); }
// Escape is taken from other apps only while the microphone is live; after that it belongs to the user again.
function releaseEscape() { globalShortcut.unregister('Escape'); }
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
function stopWatchingHold() { if (hold) { clearInterval(hold.timer); hold = null; } }
// After the hotkey starts a recording, watch whether it is still held. A short press keeps the
// recording going until the next press; a long hold ends it when the keys are released.
function watchHotkeyHold() {
  stopWatchingHold();
  if (!nativeBackend?.hotkeyDown) return;
  const startedAt = Date.now();
  const current = hold = {holding: false, timer: setInterval(() => {
    let down = false;
    try { down = nativeBackend.hotkeyDown(); } catch { down = false; }
    const held = Date.now() - startedAt;
    if (down) {
      if (!current.holding && held >= HOLD_MS) { current.holding = true; showWidget({holding: true}, capture?.phase === 'recording'); }
      return;
    }
    stopWatchingHold();
    if (current.holding && capture?.global && ['requesting', 'recording'].includes(capture.phase)) toggleGlobalRecording();
  }, 40)};
}
function finishCapture(value) {
  stopWatchingHold();
  const previous = capture; capture = null;
  if (previous?.target) paste.release(previous.target);
  releaseEscape(); setBusy(busy); updateTray();
  hideWidget();
  if (previous?.global) showWidget(value, value.phase === 'error');
}
function beginCapture(global = false) {
  if (busy || capture) throw new Error('Дождись завершения текущей операции');
  if (!worker.status) throw new Error('Движок ещё запускается. Попробуй через несколько секунд.');
  if (!worker.status.models?.find(m => m.id === store.data.settings.model)?.installed) throw new Error('Сначала скачай модель в Шёпоте');
  const target = global ? paste.capture() : null;
  // The app that had focus decides this dictation's text settings (its profile, if any).
  capture = {id: crypto.randomUUID(), global, target, phase: 'requesting',
    settings: settingsFor(structuredClone(store.data.settings), store.data.profiles, target?.app),
    dictionary: structuredClone(store.data.dictionary), snippets: structuredClone(store.data.snippets),
    app: target?.app ? {id: target.app.id, name: target.app.name, profile: store.data.profiles.some(p => p.app === target.app.id)} : null};
  // Load the model while the user speaks instead of after they stop.
  worker.notify('preload', {model: capture.settings.model, formatting: capture.settings.formatting});
  if (blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  globalShortcut.register('Escape', () => { hideWidget(); send('cancel-recording'); });
  if (global) showWidget({phase: 'requesting', elapsed: 0, level: 0, message: '', hint: '', holding: false});
  return {id: capture.id, settings: capture.settings};
}
function toggleGlobalRecording() {
  if (capture) {
    // While the keys are still down, another trigger is the held key repeating, not a second press.
    if (hold) return;
    if (['requesting', 'recording'].includes(capture.phase)) {
      capture.phase = 'stopping'; releaseEscape(); hideWidget(); send('toggle-recording');
    }
    return;
  }
  try { send('toggle-recording', beginCapture(true)); watchHotkeyHold(); }
  catch (error) { showWidget({phase: 'error', message: error.message, hint: 'Открой Шёпот, чтобы продолжить', elapsed: 0}); }
}

// --- Calls: noticed by microphone use, recorded as two channels, transcribed in chunks while they go on ---
function dismissOffer() { clearTimeout(offerTimer); if (offer) { offer = null; if (!capture && !meeting) hideWidget(); } }
function offerMeeting(user) {
  const settings = store.data.settings;
  if (meeting || capture || !settings.meetingOffers || settings.meetingIgnore.some(app => app.id === user.id)) return;
  offer = user;
  showWidget({phase: 'meeting-offer', message: `Созвон в ${user.name}. Записать?`, elapsed: 0, level: 0, hint: '', holding: false});
  clearTimeout(offerTimer);
  offerTimer = setTimeout(() => { if (offer === user) dismissOffer(); }, 20000);
}
function meetingWidget() {
  // A dictation during a call owns the widget until it is done.
  if (!meeting || capture) return;
  showWidget({phase: meeting.stopping ? 'meeting-finishing' : 'meeting', elapsed: (Date.now() - meeting.startedAt) / 1000, level: 0,
    message: meeting.stopping ? 'Собираю расшифровку созвона' : meeting.app ? `Созвон · ${meeting.app.name}` : 'Запись созвона'}, !meeting.hidden);
}
function startMeeting(app) {
  if (!MEETINGS) throw new Error('Запись созвонов пока доступна только на Windows');
  if (meeting) throw new Error('Созвон уже записывается');
  if (capture) throw new Error('Дождись конца диктовки');
  if (!worker.status?.models?.find(m => m.id === store.data.settings.model)?.installed) throw new Error('Сначала скачай модель в Шёпоте');
  dismissOffer();
  meeting = {id: crypto.randomUUID(), app: app ? {id: app.id, name: app.name} : null, startedAt: Date.now(), stopping: false, hidden: false,
    cues: {left: [], right: []}, files: [], failed: 0, settings: structuredClone(store.data.settings), dictionary: structuredClone(store.data.dictionary)};
  if (blocker === undefined) blocker = powerSaveBlocker.start('prevent-app-suspension');
  send('meeting-record', {id: meeting.id, chunkMs: MEETING_CHUNK_MS});
  clearInterval(meetingClock); meetingClock = setInterval(meetingWidget, 1000);
  meetingWidget(); updateTray('Шёпот — идёт запись созвона'); send('snapshot', snapshot());
  return meetingState();
}
function stopMeeting() {
  if (!meeting || meeting.stopping) return;
  meeting.stopping = true; clearTimeout(meeting.endTimer);
  send('meeting-finish', {id: meeting.id});
  meetingWidget(); send('snapshot', snapshot());
}
// Each chunk is transcribed channel by channel: left is the microphone (the user), right the other side.
async function transcribeMeetingChunk(current, file, offset) {
  for (const channel of ['left', 'right']) {
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await worker.request('transcribe', {audioFile: path.basename(file), channel, model: current.settings.model,
          language: current.settings.language, mode: 'natural', formatting: 'off', voiceCommands: false, removeFillers: current.settings.removeFillers,
          context: current.settings.context, dictionary: current.dictionary, snippets: []});
        current.cues[channel].push(...(result.cues || []).map(cue => ({...cue, start: cue.start + offset, end: cue.end + offset})));
        break;
      } catch (error) {
        // A dictation's cancel or an engine restart can take this request down with it: try again, a few times.
        if (attempt >= 4) { console.error('Кусок созвона не распознан:', error.message); return false; }
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  return true;
}
async function finishMeeting(current, problem) {
  await meetingQueue;
  clearInterval(meetingClock);
  if (meeting === current) meeting = null;
  const turns = meetingTurns(current.cues.left, current.cues.right);
  const duration = (Date.now() - current.startedAt) / 1000;
  if (turns.length) {
    const text = meetingText(turns);
    store.addHistory({id: crypto.randomUUID(), createdAt: new Date(current.startedAt).toISOString(), source: current.app ? `Созвон · ${current.app.name}` : 'Созвон',
      mode: 'natural', text, rawText: text, words: [], duration, elapsed: 0, model: current.settings.model, replacements: [], audioFile: null, app: null,
      cues: [...current.cues.left, ...current.cues.right].sort((a, b) => a.start - b.start),
      meeting: {app: current.app?.name ?? null, turns: turns.length, failedChunks: current.failed}});
  }
  // Transcribed chunks are not needed any more (after a crash they come back as recordings to retry).
  // A chunk the engine could not transcribe stays as an unfinished recording, like a failed dictation.
  for (const [index, {file, ok}] of current.files.entries()) {
    if (ok) { if (fs.existsSync(file)) fs.unlinkSync(file); }
    else store.data.pendingRecordings.push({id: crypto.randomUUID(), audioFile: path.basename(file), source: `Созвон, часть ${index + 1}`, createdAt: new Date().toISOString()});
  }
  store.save();
  setBusy(busy); updateTray(); send('snapshot', snapshot());
  const failed = current.failed ? ` Не распознано кусков: ${current.failed}.` : '';
  showWidget(turns.length ? {phase: 'success', message: 'Расшифровка созвона готова', hint: `Она в истории Шёпота.${failed}`}
    : {phase: 'error', message: problem || 'В записи созвона нет речи', hint: problem ? 'Проверь доступ к звуку и микрофону' : 'Ничего не сохранено'}, true);
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
    if (action === 'stop' && meeting && !capture) stopMeeting();
    if (action === 'cancel' && capture) { hideWidget(); send('cancel-recording'); }
    if (action === 'hide' && !capture) { if (meeting) meeting.hidden = true; widget.hide(); }
    if (action === 'meeting-record' && offer) {
      try { startMeeting(offer); } catch (error) { showWidget({phase: 'error', message: error.message, hint: 'Открой Шёпот, чтобы продолжить'}); }
    }
    if (action === 'meeting-ignore' && offer) {
      store.setSettings({...store.data.settings, meetingIgnore: [...store.data.settings.meetingIgnore, {id: offer.id, name: offer.name}]});
      dismissOffer(); send('snapshot', snapshot());
    }
    if (action === 'meeting-dismiss') dismissOffer();
    if (action === 'open') { window.show(); window.focus(); widget.hide(); }
  });
}
function createWindow() {
  window = new BrowserWindow({width: 1240, height: 850, minWidth: 1000, minHeight: 720,
    title: 'Шёпот', backgroundColor: '#07080a', autoHideMenuBar: true, icon: path.join(root, 'renderer', 'app-icon.png'),
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, spellcheck: false}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  window.webContents.on('render-process-gone', () => {
    ++job; worker?.restart(); busy = false;
    // A call being recorded keeps what reached the engine so far.
    if (meeting) finishMeeting(meeting, 'Окно записи перезапустилось').catch(() => {});
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
  const snippets = (recordingSession?.snippets || structuredClone(store.data.snippets)).map(({trigger, text}) => ({trigger, text}));
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
    const result = await worker.request('transcribe', {audioFile, ...settings, dictionary, snippets});
    if (currentJob !== job) { canceled = task.canceled; return {canceled: true}; }
    if (result.noSpeech) {
      completed = true;
      if (recordingSession) finishCapture({phase: 'error', message: 'Речь не обнаружена', hint: 'Попробуй говорить ближе к микрофону'});
      return {noSpeech: true};
    }
    const entry = {id: crypto.randomUUID(), createdAt: new Date().toISOString(), source,
      mode: settings.mode, ...result, audioFile: settings.keepAudio ? path.basename(filePath) : null, app: recordingSession?.app ?? null};
    store.addHistory(entry);
    completed = true;
    const delivery = await paste.deliver(entry.text, {autoCopy: settings.autoCopy,
      autoPaste: Boolean(recordingSession?.global && settings.autoPaste), target: recordingSession?.target}, () => currentJob === job);
    // Kept for diagnosing why auto-paste did not happen on a user's machine.
    entry.delivery = delivery.code; store.save();
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
    // The interface is dark only; this also darkens the native title bar and dialogs.
    nativeTheme.themeSource = 'dark';
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
    try { native = createNativeBackend(); nativeAvailable = true; nativeBackend = native; } catch (error) { console.error('Автовставка недоступна:', error.message); }
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
        if (value.phase === 'stopping') { releaseEscape(); hideWidget(); }
        if (capture.global) showWidget({phase: value.phase, message: '', elapsed: Math.max(0, Math.min(900, Number(value.elapsed) || 0)), level: Math.max(0, Math.min(1, Number(value.level) || 0))}, value.phase === 'recording');
        updateTray(value.phase === 'recording' ? 'Шёпот — идёт запись. Escape: отмена' : 'Шёпот — распознаю запись');
      }
    });

    ipc('boot', snapshot);
    ipc('paste-permission', () => {
      if (process.platform === 'darwin') systemPreferences.isTrustedAccessibilityClient(true);
      return pastePermission();
    });
    ipc('settings', value => store.setSettings(value));
    ipc('dictionary', value => store.setDictionary(value));
    ipc('snippets', value => store.setSnippets(value));
    ipc('profiles', value => store.setProfiles(value));
    ipc('download', async id => {
      if (busy || capture) throw new Error('Дождись завершения текущей операции');
      const currentJob = ++job;
      setBusy(true); downloading = true;
      try {
        // 'formatter' is the optional layout model (llama.cpp runtime + Qwen), downloaded and verified by the engine.
        const status = id === 'formatter' ? await worker.request('download-formatter')
          : await worker.request('download', {model: modelId(id)});
        worker.status = status; send('engine', {status}); return status;
      } finally { downloading = false; if (currentJob === job) setBusy(false); }
    });
    ipc('cancel', () => {
      if (activeTranscription) activeTranscription.canceled = true;
      ++job;
      // A download can only be interrupted by killing the engine; transcription stops cooperatively.
      if (downloading) { worker.restart(); send('engine', {status: null}); }
      else if (busy) worker.cancel();
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
    ipc('copy', async value => { await clipboard.writeText(clipboardText(textValue(value))); return true; });
    ipc('save-text', async value => {
      const text = textValue(value?.text);
      const entry = value?.id ? entryFor(value.id) : null;
      // A transcribed file suggests its own name; subtitles are offered when the words have timing.
      const fromFile = entry && !['Микрофон', 'Незавершённая запись'].includes(entry.source);
      const filters = [{name: 'Текст', extensions: ['txt']}, {name: 'Markdown', extensions: ['md']},
        ...(entry?.cues?.length ? [{name: 'Субтитры SRT', extensions: ['srt']}] : [])];
      const result = await dialog.showSaveDialog(window, {defaultPath: `${fromFile ? path.parse(entry.source).name : 'Диктовка'}.txt`, filters});
      if (result.canceled) return false;
      const format = path.extname(result.filePath).slice(1).toLowerCase();
      fs.writeFileSync(result.filePath, exportText(['md', 'srt'].includes(format) ? format : 'txt', entry, text), 'utf8');
      return path.basename(result.filePath);
    });
    ipc('update-entry', value => {
      const entry = entryFor(value.id), before = entry.text;
      entry.text = textValue(value.text); store.save();
      // The user's own fix of a misheard word is a dictionary entry waiting to happen.
      return {entry, suggestions: suggestCorrections(before, entry.text, store.data.dictionary)};
    });
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
    ipc('meeting-start', () => startMeeting(null));
    ipc('meeting-stop', () => { stopMeeting(); return true; });
    ipc('meeting-chunk', value => {
      if (!meeting || value?.id !== meeting.id) throw new Error('Запись созвона уже завершена');
      const audio = value.audio, offset = Number(value.offset);
      if (!(audio instanceof Uint8Array) || !audio.length || audio.length > 200 * 1024 * 1024) throw new Error('Недопустимая аудиозапись');
      if (!Number.isFinite(offset) || offset < 0 || offset > 24 * 3600) throw new Error('Недопустимое время куска');
      const file = path.join(audioDir, crypto.randomUUID() + '.webm');
      fs.writeFileSync(file, audio, {mode: 0o600});
      const current = meeting, record = {file, ok: false};
      current.files.push(record);
      // One engine request at a time, in recording order, while the call goes on.
      meetingQueue = meetingQueue.then(async () => { record.ok = await transcribeMeetingChunk(current, file, offset); if (!record.ok) current.failed++; });
      return true;
    });
    ipc('meeting-done', value => {
      if (!meeting || value?.id !== meeting.id) return false;
      const current = meeting;
      current.stopping = true; clearTimeout(current.endTimer);
      finishMeeting(current, value.error ? String(value.error).slice(0, 200) : '').catch(error => console.error('Созвон не сохранён:', error));
      return true;
    });
    ipc('copy-summary', async id => {
      const entry = entryFor(id);
      await clipboard.writeText(clipboardText(summaryPrompt(entry.text, entry.meeting?.app)));
      return true;
    });
    if (MEETINGS) {
      // System audio for a call being recorded, and only for the main window: Chromium needs a screen source
      // with it, and the page stops that video track at once.
      session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
        if (!meeting || request.frame?.url !== uiUrl) { callback({}); return; }
        desktopCapturer.getSources({types: ['screen']}).then(sources => callback(sources[0] ? {video: sources[0], audio: 'loopback'} : {}), () => callback({}));
      });
    }
    if (MEETINGS && native?.micUsers) {
      micWatcher = new MicWatcher(() => native.micUsers(), MIC_POLL_MS);
      micWatcher.on('start', user => { if (meeting?.app?.id === user.id) clearTimeout(meeting.endTimer); else offerMeeting(user); });
      micWatcher.on('stop', user => {
        if (offer?.id === user.id) dismissOffer();
        // The call app let go of the microphone: the call is over, unless it picks it up again right away.
        if (meeting?.app?.id === user.id && !meeting.stopping) { clearTimeout(meeting.endTimer); meeting.endTimer = setTimeout(stopMeeting, MIC_POLL_MS * 2.5); }
      });
      micWatcher.start();
    }
  });
}
app.on('activate', () => { if (window) window.show(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { clearTimeout(widgetTimer); micWatcher?.stop(); globalShortcut.unregisterAll(); worker?.stop(); if (capture?.target) paste?.release(capture.target); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
