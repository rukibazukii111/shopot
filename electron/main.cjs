const {app, BrowserWindow, ipcMain, dialog, clipboard, desktopCapturer, globalShortcut, session, shell, Tray, Menu, nativeImage, nativeTheme, powerSaveBlocker, screen, systemPreferences} = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {pathToFileURL} = require('node:url');
const crypto = require('node:crypto');
const {Store, MODEL_IDS, settingsFor, validateSettings, expiredHistory} = require('./store.cjs');
const {Worker} = require('./worker.cjs');
const {PasteService, clipboardText} = require('./paste.cjs');
const {createNativeBackend} = require('./native-input.cjs');
const {suggestCorrections} = require('./corrections.cjs');
const {exportText} = require('./export.cjs');
const {MicWatcher, meetingTurns, meetingText, summaryPrompt} = require('./meetings.cjs');
const {createJournal, errorFields, timestamp} = require('./log.cjs');
const {systemName, issueUrl} = require('./report.cjs');

const root = path.resolve(__dirname, '..');
// From package.json rather than app.getVersion(), which reports Electron's version when main.cjs is loaded by a test harness.
const appVersion = require('../package.json').version;
const dataDir = path.resolve(process.env.SHOPOT_DATA_DIR || (app.isPackaged ? path.join(app.getPath('appData'), 'Shopot') : path.join(root, '.local')));
app.setPath('userData', dataDir);
// Diagnostics for bug reports. Only named fields go in (log.cjs): never pass it text, a file name or a whole object.
const journal = createJournal({dir: path.join(dataDir, 'logs')});
const launchedAt = Date.now();
let engineStartedAt = 0;
const audioDir = path.join(dataDir, 'audio');
const uiUrl = pathToFileURL(path.join(root, 'renderer', 'index.html')).href;
const widgetUrl = pathToFileURL(path.join(root, 'renderer', 'widget.html')).href;
const shortcut = 'CommandOrControl+Shift+Space';
// `--hidden` starts in the tray without opening the window: for autostart and for smoke tests on a desktop in use.
const startHidden = process.argv.includes('--hidden');
let window, widget, tray, worker, store, paste, capture, busy = false, blocker, quitting = false, engineError = null;
let hotkeyRegistered = false;
let nativeAvailable = false, nativeBackend = null;
// Holding the hotkey longer than this makes it push-to-talk: letting go ends the recording.
const HOLD_MS = 450;
let hold = null;
let widgetTimer, activeTranscription, downloading = false, job = 0, pruneTimer;
// Calls are recorded on Windows only for now: that is where Electron captures system audio (WASAPI loopback).
const MEETINGS = process.platform === 'win32';
const MEETING_CHUNK_MS = (Number(process.env.SHOPOT_MEETING_CHUNK_SECONDS) || 300) * 1000;
const MIC_POLL_MS = Number(process.env.SHOPOT_MIC_POLL_MS) || 4000;
// History past its retention period goes at start and then once a day (PRD 6.20).
const HISTORY_PRUNE_MS = Number(process.env.SHOPOT_HISTORY_PRUNE_MS) || 864e5;
const WINDOW_GONE = 'Окно записи перезапустилось';
let meeting = null, offer = null, offerTimer, meetingClock, micWatcher = null, meetingQueue = Promise.resolve();
let widgetState = {phase: 'requesting', shortcut: process.platform === 'darwin' ? '⌘⇧Space' : 'Ctrl⇧Space'};

function send(channel, value) { if (window && !window.isDestroyed()) window.webContents.send(channel, value); }
function trusted(event) {
  if (event.sender !== window?.webContents || event.senderFrame?.url !== uiUrl) throw new Error('Недопустимый источник команды');
}
function ipc(name, handler) {
  ipcMain.handle(name, async (event, value) => {
    trusted(event);
    try { return await handler(value); }
    catch (error) { if (!error?.journaled) journal.write('ipc-error', {channel: name, ...errorFields(error)}); throw error; }
  });
}
// A cancel reaches main up to three ways (Escape, the widget, the window); the first one, while the work is live, is journaled
// with the stage it interrupted. «Отменить» in the window and a second hotkey press while the microphone opens stop the
// capture before they cancel it, so a stopped capture counts at its stage before the stop.
function journalCancel() {
  const phase = downloading ? 'download' : activeTranscription ? 'transcribing' : capture?.stoppedFrom ?? capture?.phase;
  if (!phase || capture?.cancelJournaled) return;
  if (capture) capture.cancelJournaled = true;
  journal.write('cancel', {phase});
}
// A failure outside any command: its type, system code and first frame in our code, never its message.
function journalMainError(origin, error) { const {kind, code, at} = errorFields(error); journal.write('main-error', {origin, kind, code, at}); }
function startEngine() { engineStartedAt = Date.now(); journal.write('engine-start'); worker.start(); }
function restartEngine(cause) { journal.write('engine-restart', {cause}); engineStartedAt = Date.now(); worker.restart(); }
function engineFields(status) {
  const formatter = status?.formatter;
  return {models: (status?.models || []).filter(m => m.installed).map(m => `${m.id}@${String(m.revision || '').slice(0, 12)}`),
    threads: status?.threads, device: status?.device, compute: status?.computeType,
    formatter: !formatter?.supported ? 'unsupported' : formatter.installed ? 'installed' : 'absent', startup: (Date.now() - engineStartedAt) / 1000};
}
// Timings and the outcome of one recognition, picked field by field: the result also holds the text.
// `wait` is the request's time outside the engine's job: mostly the queue (a preload still loading, a call chunk).
function resultFields(result, requestSeconds) {
  const load = Number(result.loadElapsed) || 0, format = Number(result.formatElapsed) || 0;
  return {model: result.model, device: result.device, formatting: result.formatting, audio: result.duration,
    wait: Number.isFinite(result.elapsed) ? Math.max(0, requestSeconds - result.elapsed) : undefined,
    load: result.loadElapsed, format: result.formatElapsed, total: result.elapsed,
    transcribe: Number.isFinite(result.elapsed) ? Math.max(0, result.elapsed - load - format) : undefined,
    memoryMb: Number.isFinite(result.memoryPeak) ? Math.round(result.memoryPeak / 2 ** 20) : undefined};
}
function recordsLabel(count) {
  const tail = count % 10, tens = count % 100;
  return tail === 1 && tens !== 11 ? 'запись' : tail >= 2 && tail <= 4 && (tens < 12 || tens > 14) ? 'записи' : 'записей';
}
function pastePermission() { return process.platform !== 'darwin' || systemPreferences.isTrustedAccessibilityClient(false); }
function meetingState() { return meeting ? {app: meeting.app?.name ?? null, startedAt: meeting.startedAt, stopping: meeting.stopping} : null; }
function snapshot() { return {...store.data, engine: worker.status, engineError, busy, hotkeyRegistered, nativeAvailable, pastePermission: pastePermission(), platform: process.platform, totalMemory: os.totalmem(), meeting: meetingState(), meetingsSupported: MEETINGS}; }
function modelId(id) { if (!MODEL_IDS.includes(id)) throw new Error('Неизвестная модель'); return id; }
function textValue(value) { if (typeof value !== 'string' || value.length > 200000) throw new Error('Недопустимый текст'); return value; }
function entryFor(id) { const entry = store.data.history.find(e => e.id === id); if (!entry) throw new Error('Запись не найдена'); return entry; }
// A file system failure as a plain message for the window; its code still reaches the journal through ipc().
// The stack starts at the caller, so the journal tells a failed read from a failed write.
function fileError(message, error) {
  const failure = Object.assign(new Error(message), {code: error?.code});
  Error.captureStackTrace(failure, fileError);
  return failure;
}
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
// Removes history past its retention period with the audio no other entry keeps, and the journal's old lines.
// Pending recordings are not history: they stay whatever their age (PRD 6.22).
function pruneHistory(trigger) {
  const days = store.data.settings.historyDays;
  if (!days) return 0;
  journal.pruneOlderThan(days);
  const removed = store.pruneHistory(days);
  const kept = new Set([...store.data.history, ...store.data.pendingRecordings].map(e => e.audioFile).filter(Boolean));
  for (const entry of removed) {
    const file = audioFor(entry);
    // A file another program holds stays; the next start lists it as a pending recording the user can delete.
    if (file && !kept.has(entry.audioFile)) try { fs.rmSync(file, {force: true}); } catch {}
  }
  if (!removed.length) return 0;
  journal.write('history-prune', {trigger, days, removed: removed.length});
  // At start there is no window or engine yet: the window reads the history when it boots.
  if (window && !window.isDestroyed()) send('snapshot', snapshot());
  return removed.length;
}
// The start and the daily run have no window to tell; a failure goes to the journal and the next run tries again.
function prunePeriodically(trigger) {
  try { pruneHistory(trigger); }
  catch (error) { const {kind, code, at} = errorFields(error); journal.write('history-prune', {trigger, kind, code, at}); }
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
  globalShortcut.register('Escape', () => { journalCancel(); hideWidget(); send('cancel-recording'); });
  if (global) showWidget({phase: 'requesting', elapsed: 0, level: 0, message: '', hint: '', holding: false});
  return {id: capture.id, settings: capture.settings};
}
function toggleGlobalRecording() {
  if (capture) {
    // While the keys are still down, another trigger is the held key repeating, not a second press.
    if (hold) return;
    if (['requesting', 'recording'].includes(capture.phase)) {
      capture.stoppedFrom = capture.phase; capture.phase = 'stopping'; releaseEscape(); hideWidget(); send('toggle-recording');
    }
    return;
  }
  try { send('toggle-recording', beginCapture(true)); watchHotkeyHold(); }
  catch (error) {
    journal.write('command-error', {command: 'hotkey', ...errorFields(error)});
    showWidget({phase: 'error', message: error.message, hint: 'Открой Шёпот, чтобы продолжить', elapsed: 0});
  }
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
  journal.write('meeting-start', {app: app?.name, appId: app?.id, trigger: app ? 'offer' : 'manual'});
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
async function transcribeMeetingChunk(current, file, offset, index) {
  for (const channel of ['left', 'right']) {
    const started = Date.now();
    for (let attempt = 1; ; attempt++) {
      try {
        const result = await worker.request('transcribe', {audioFile: path.basename(file), channel, model: current.settings.model,
          language: current.settings.language, mode: 'natural', formatting: 'off', voiceCommands: false, removeFillers: current.settings.removeFillers,
          context: current.settings.context, dictionary: current.dictionary, snippets: []});
        current.cues[channel].push(...(result.cues || []).map(cue => ({...cue, start: cue.start + offset, end: cue.end + offset})));
        journal.write('meeting-chunk', {index, channel, result: 'ok', attempts: attempt, transcribe: (Date.now() - started) / 1000});
        break;
      } catch (error) {
        // A dictation's cancel or an engine restart can take this request down with it: try again, a few times.
        if (attempt >= 4) { journal.write('meeting-chunk', {index, channel, result: 'fail', attempts: attempt, kind: errorFields(error).kind}); return false; }
        await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
      }
    }
  }
  return true;
}
// `kind` is the type of the window's recording error; its message (`problem`) is for the widget only.
async function finishMeeting(current, problem, kind) {
  await meetingQueue;
  clearInterval(meetingClock);
  if (meeting === current) meeting = null;
  const turns = meetingTurns(current.cues.left, current.cues.right);
  const duration = (Date.now() - current.startedAt) / 1000;
  const report = {duration, turns: turns.length, chunks: current.files.length, failed: current.failed,
    problem: !problem ? undefined : problem === WINDOW_GONE ? 'window-gone' : 'renderer', kind};
  try {
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
  } catch (error) {
    // A full disk, or store.json held by an antivirus or a sync tool: the code and the failing call, never the path.
    const {code, at} = errorFields(error);
    journal.write('meeting-finish', {...report, result: 'error', code, at});
    throw error;
  }
  journal.write('meeting-finish', {...report, result: turns.length ? 'saved' : 'empty'});
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
  widget.webContents.on('render-process-gone', (event, details) => journal.write('render-gone', {window: 'widget', reason: details?.reason, exitCode: details?.exitCode}));
  widget.on('close', event => { if (!quitting) { event.preventDefault(); widget.hide(); } });
  widget.loadURL(widgetUrl);
  const trustedWidget = event => event.sender === widget.webContents && event.senderFrame?.url === widgetUrl;
  ipcMain.handle('widget-boot', event => { if (!trustedWidget(event)) throw new Error('Недопустимый источник'); return widgetState; });
  ipcMain.on('widget-action', (event, action) => {
    if (!trustedWidget(event)) return;
    if (action === 'stop' && capture?.phase === 'recording') toggleGlobalRecording();
    if (action === 'stop' && meeting && !capture) stopMeeting();
    if (action === 'cancel' && capture) { journalCancel(); hideWidget(); send('cancel-recording'); }
    if (action === 'hide' && !capture) { if (meeting) meeting.hidden = true; widget.hide(); }
    if (action === 'meeting-record' && offer) {
      try { startMeeting(offer); }
      catch (error) {
        journal.write('command-error', {command: 'meeting-record', ...errorFields(error)});
        showWidget({phase: 'error', message: error.message, hint: 'Открой Шёпот, чтобы продолжить'});
      }
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
  // Shown once the first frame is painted: no empty frame, and nothing on screen before it is ready.
  window = new BrowserWindow({width: 1240, height: 850, minWidth: 1000, minHeight: 720, show: false,
    title: 'Шёпот', backgroundColor: '#07080a', autoHideMenuBar: true, icon: path.join(root, 'renderer', 'app-icon.png'),
    webPreferences: {preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, backgroundThrottling: false, spellcheck: false}});
  window.webContents.setWindowOpenHandler(() => ({action: 'deny'}));
  window.webContents.on('will-navigate', (event, url) => { if (url !== uiUrl) event.preventDefault(); });
  window.webContents.on('render-process-gone', (event, details) => {
    journal.write('render-gone', {window: 'main', reason: details?.reason, exitCode: details?.exitCode});
    ++job; if (worker) restartEngine('window-gone'); busy = false;
    // A call being recorded keeps what reached the engine so far.
    if (meeting) finishMeeting(meeting, WINDOW_GONE).catch(() => {});
    finishCapture({phase: 'error', message: WINDOW_GONE, hint: 'Повтори диктовку'});
    window.reload();
  });
  window.once('ready-to-show', () => { if (!startHidden) window.show(); });
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
  // `source` is never journaled: for an imported file it is the user's file name.
  const report = {result: 'error', model: settings.model, language: settings.language, mode: settings.mode,
    formattingRequested: settings.formatting, translate: settings.translate};
  if (recordingSession) Object.assign(report, {trigger: recordingSession.global ? 'hotkey' : 'window', record: recordingSession.record,
    app: recordingSession.app?.name, appId: recordingSession.app?.id, profile: recordingSession.app?.profile});
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
    const requested = performance.now();
    const result = await worker.request('transcribe', {audioFile, ...settings, dictionary, snippets});
    if (currentJob !== job) { canceled = task.canceled; report.result = 'canceled'; return {canceled: true}; }
    Object.assign(report, resultFields(result, (performance.now() - requested) / 1000));
    // Only a dictation sends a preload (beginCapture); for a file or a retry it would be a canceled dictation's.
    if (recordingSession) report.preload = result.preloadElapsed;
    if (result.noSpeech) {
      completed = true; report.result = 'no-speech';
      if (recordingSession) finishCapture({phase: 'error', message: 'Речь не обнаружена', hint: 'Попробуй говорить ближе к микрофону'});
      return {noSpeech: true};
    }
    // History shows loadElapsed as a part of the recognition time («из них загрузка модели»); the preload ran
    // while the user spoke, outside that time, so its seconds stay in the journal.
    const {preloadElapsed, ...recognized} = result;
    const entry = {id: crypto.randomUUID(), createdAt: new Date().toISOString(), source,
      mode: settings.mode, ...recognized, audioFile: settings.keepAudio ? path.basename(filePath) : null, app: recordingSession?.app ?? null};
    store.addHistory(entry);
    completed = true;
    const pasteStarted = performance.now();
    const delivery = await paste.deliver(entry.text, {autoCopy: settings.autoCopy,
      autoPaste: Boolean(recordingSession?.global && settings.autoPaste), target: recordingSession?.target}, () => currentJob === job);
    Object.assign(report, {result: 'ok', paste: delivery.code, pasteTime: (performance.now() - pasteStarted) / 1000});
    // Kept for diagnosing why auto-paste did not happen on a user's machine.
    entry.delivery = delivery.code; store.save();
    send('snapshot', snapshot());
    if (recordingSession && currentJob === job) finishCapture({phase: delivery.pasted || ['saved', 'copied'].includes(delivery.code) ? 'success' : 'error', message: delivery.message, hint: delivery.pasted ? 'Можно продолжать писать' : 'Текст доступен в истории'});
    return {entry, ...delivery};
  } catch (error) {
    if (currentJob !== job) { canceled = task.canceled; report.result = 'canceled'; return {canceled: true}; }
    Object.assign(report, errorFields(error));
    if (error && typeof error === 'object') error.journaled = true;
    if (recordingSession) finishCapture({phase: 'error', message: 'Не удалось распознать запись', hint: 'Аудио сохранено. Повтори распознавание в Шёпоте.'});
    throw error;
  } finally {
    journal.write(retry ? 'retry' : recordingSession ? 'dictation' : 'file', report);
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
  // The same system version as in «Сообщить о проблеме»: on macOS os.release() is the Darwin kernel's.
  journal.write('app-start', {version: appVersion, electron: process.versions.electron, os: process.getSystemVersion(), platform: process.platform,
    arch: process.arch, memoryGb: Math.round(os.totalmem() / 2 ** 30), packaged: app.isPackaged, hidden: startHidden,
    // A non-ASCII or spaced path to the data folder is a common cause of install-specific failures; the path itself stays out.
    dataDirNonAscii: /[^\x20-\x7e]/.test(dataDir), dataDirSpace: /\s/.test(dataDir)});
  // Observers only: Electron keeps its own handling (an uncaught exception shows its error dialog and the app
  // keeps running; a rejection only warns).
  process.on('uncaughtExceptionMonitor', (error, origin) => journalMainError(origin, error));
  process.on('unhandledRejection', reason => {
    journalMainError('unhandledRejection', reason);
    console.error('Unhandled rejection:', reason);
  });
  app.on('second-instance', () => { window?.show(); window?.focus(); });
  app.whenReady().then(() => {
    // The interface is dark only; this also darkens the native title bar and dialogs.
    nativeTheme.themeSource = 'dark';
    fs.mkdirSync(audioDir, {recursive: true});
    try { store = new Store(dataDir); }
    catch (error) { journalMainError('store', error); dialog.showErrorBox('Шёпот', error.message); app.quit(); return; }
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
    prunePeriodically('start');
    pruneTimer = setInterval(() => prunePeriodically('daily'), HISTORY_PRUNE_MS);
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
    worker.on('ready', status => { engineError = null; journal.write('engine-ready', engineFields(status)); send('engine', {status}); });
    worker.on('progress', event => {
      send('progress', event);
      if (capture?.global && capture.phase === 'transcribing') showWidget({phase: 'transcribing', message: event.message || 'Распознаю на устройстве'}, false);
    });
    worker.on('offline', (error, info = {}) => { engineError = error; journal.write('engine-offline', info); send('engine', {error}); });
    try { startEngine(); } catch (error) { engineError = error.message; journal.write('engine-offline', {cause: 'missing'}); }

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
        // A failure comes with its type (a denied or busy microphone, a recorder error, an empty recording); a cancel
        // by the user comes without one. The message stays out.
        if (value.phase === 'canceled' && value.kind === undefined) journalCancel();
        else journal.write('capture-error', {phase: capture.phase, kind: value.kind});
        finishCapture({phase: value.phase, message: value.phase === 'canceled' ? 'Запись отменена' : 'Микрофон недоступен', hint: String(value.message || '').slice(0, 240)});
      } else if ((value.phase === 'recording' && ['requesting', 'recording'].includes(capture.phase)) ||
                 (value.phase === 'stopping' && ['recording', 'stopping'].includes(capture.phase))) {
        // A microphone that went away stops the recording; what was recorded is still recognized.
        if (value.kind !== undefined) journal.write('capture-error', {phase: capture.phase, kind: value.kind});
        if (value.phase === 'stopping') capture.stoppedFrom ??= capture.phase;
        capture.phase = value.phase;
        capture.record = Math.max(0, Math.min(900, Number(value.elapsed) || 0));
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
    // A shorter retention period asks first when it would remove entries; «Оставить» keeps the old period.
    ipc('settings', async value => {
      const next = validateSettings(value), before = store.data.settings.historyDays;
      const shorter = Boolean(next.historyDays) && (!before || next.historyDays < before);
      const count = shorter ? expiredHistory(store.data.history, next.historyDays).length : 0;
      if (count) {
        const answer = await dialog.showMessageBox(window, {type: 'question', message: `Удалить ${count} ${recordsLabel(count)} старше ${next.historyDays} дней?`,
          detail: 'Текст и сохранённое аудио будут удалены с этого компьютера. Незавершённые записи останутся.',
          buttons: ['Оставить', 'Удалить'], defaultId: 0, cancelId: 0});
        if (answer.response !== 1) return store.data.settings;
      }
      const saved = store.setSettings(next);
      if (shorter) {
        try { pruneHistory('setting'); } catch (error) { throw fileError('Не удалось удалить старые записи', error); }
      }
      return saved;
    });
    ipc('dictionary', value => store.setDictionary(value));
    ipc('snippets', value => store.setSnippets(value));
    ipc('profiles', value => store.setProfiles(value));
    ipc('download', async id => {
      if (busy || capture) throw new Error('Дождись завершения текущей операции');
      const currentJob = ++job, started = Date.now(), report = {model: id, result: 'error'};
      setBusy(true); downloading = true;
      try {
        // 'formatter' is the optional layout model (llama.cpp runtime + Qwen), downloaded and verified by the engine.
        const status = id === 'formatter' ? await worker.request('download-formatter')
          : await worker.request('download', {model: modelId(id)});
        worker.status = status; send('engine', {status}); report.result = 'ok'; return status;
      } catch (error) {
        if (currentJob !== job) report.result = 'canceled'; else Object.assign(report, errorFields(error));
        if (error && typeof error === 'object') error.journaled = true;
        throw error;
      } finally {
        journal.write('download', {...report, elapsed: (Date.now() - started) / 1000});
        downloading = false; if (currentJob === job) setBusy(false);
      }
    });
    ipc('cancel', () => {
      journalCancel();
      if (activeTranscription) activeTranscription.canceled = true;
      ++job;
      // A download can only be interrupted by killing the engine; transcription stops cooperatively.
      if (downloading) { restartEngine('download-canceled'); send('engine', {status: null}); }
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
      const current = meeting, record = {file, ok: false}, index = current.files.length;
      current.files.push(record);
      // One engine request at a time, in recording order, while the call goes on.
      meetingQueue = meetingQueue.then(async () => { record.ok = await transcribeMeetingChunk(current, file, offset, index); if (!record.ok) current.failed++; });
      return true;
    });
    ipc('meeting-done', value => {
      if (!meeting || value?.id !== meeting.id) return false;
      const current = meeting;
      current.stopping = true; clearTimeout(current.endTimer);
      finishMeeting(current, value.error ? String(value.error).slice(0, 200) : '', value.kind).catch(error => console.error('Созвон не сохранён:', error));
      return true;
    });
    ipc('copy-summary', async id => {
      const entry = entryFor(id);
      await clipboard.writeText(clipboardText(summaryPrompt(entry.text, entry.meeting?.app)));
      return true;
    });
    // The journal and «Сообщить о проблеме» (PRD 6.27). The window passes nothing: main knows the folder and builds the link.
    ipc('journal-open', async () => {
      try { fs.mkdirSync(journal.dir, {recursive: true}); } catch (error) { throw fileError('Не удалось открыть папку журнала', error); }
      if (await shell.openPath(journal.dir)) throw new Error('Не удалось открыть папку журнала');
      return true;
    });
    ipc('journal-save', async () => {
      const name = `Шёпот-журнал-${timestamp(new Date()).slice(0, 10)}.txt`;
      const result = await dialog.showSaveDialog(window, {defaultPath: path.join(app.getPath('downloads'), name), filters: [{name: 'Текст', extensions: ['txt']}]});
      if (result.canceled) return false;
      let text;
      try { text = journal.read(); } catch (error) { throw fileError('Не удалось прочитать журнал', error); }
      try { fs.writeFileSync(result.filePath, text, 'utf8'); } catch (error) { throw fileError('Не удалось сохранить журнал. Выбери другую папку', error); }
      return true;
    });
    ipc('report-problem', async () => {
      const link = issueUrl({version: appVersion, system: systemName(process.platform, process.getSystemVersion()), arch: process.arch});
      try { await shell.openExternal(link); return true; }
      catch { clipboard.writeText(link); return false; }
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
    journal.write('app-ready', {hotkey: hotkeyRegistered, native: nativeAvailable, meetings: MEETINGS});
  });
}
app.on('activate', () => { if (window) window.show(); });
app.on('before-quit', () => { quitting = true; });
app.on('will-quit', () => { journal.write('quit', {uptime: (Date.now() - launchedAt) / 1000}); clearTimeout(widgetTimer); clearInterval(pruneTimer); micWatcher?.stop(); globalShortcut.unregisterAll(); worker?.stop(); if (capture?.target) paste?.release(capture.target); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
