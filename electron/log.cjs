const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {MODEL_IDS, LANGUAGES, MODES, FORMATTING} = require('./store.cjs');
const {DELIVERY_CODES} = require('./paste.cjs');

// The diagnostic journal (PRD 6.27). It must never hold what the user said or typed: every event has a
// schema, and a field is written only when its value passes its type. Free text is admitted in one place,
// `message`, and only for errors the engine marks as expected (its own fixed Russian messages).
const TOKEN = /^[A-Za-z0-9._:@+-]{1,64}$/;
const NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._+&()-]{0,63}$/u;
const sec = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1e6 ? String(Math.round(value * 100) / 100) : undefined;
const int = value => Number.isInteger(value) && Math.abs(value) <= 1e13 ? String(value) : undefined;
const bool = value => typeof value === 'boolean' ? String(value) : undefined;
const token = value => typeof value === 'string' && TOKEN.test(value) ? value : undefined;
const tokens = value => Array.isArray(value) && value.length <= 16 && value.every(item => token(item)) ? value.join(',') || 'none' : undefined;
const name = value => typeof value === 'string' && NAME.test(value) ? value : undefined;
const oneOf = values => value => values.includes(value) ? value : undefined;
const MESSAGE = Symbol('message');

const ERROR = {kind: token, code: token, expected: bool, message: MESSAGE, at: token};
const PHASE = oneOf(['requesting', 'recording', 'stopping', 'transcribing', 'download', 'idle']);
const TRANSCRIPTION = {
  result: oneOf(['ok', 'no-speech', 'error', 'canceled']), trigger: oneOf(['hotkey', 'window']),
  model: oneOf(MODEL_IDS), device: token, language: oneOf(LANGUAGES), mode: oneOf(MODES),
  formattingRequested: oneOf(FORMATTING), formatting: oneOf(FORMATTING), translate: bool,
  record: sec, audio: sec, preload: sec, wait: sec, load: sec, transcribe: sec, format: sec, total: sec, pasteTime: sec, memoryMb: int,
  paste: oneOf(DELIVERY_CODES), app: name, appId: token, profile: bool, ...ERROR,
};
const EVENTS = {
  'app-start': {version: token, electron: token, os: token, platform: token, arch: token, memoryGb: int,
    packaged: bool, hidden: bool, dataDirNonAscii: bool, dataDirSpace: bool},
  'app-ready': {hotkey: bool, native: bool, meetings: bool},
  'engine-start': {},
  'engine-ready': {models: tokens, threads: int, device: token, compute: token,
    formatter: oneOf(['installed', 'absent', 'unsupported']), startup: sec},
  'engine-offline': {cause: oneOf(['missing', 'spawn-error', 'exit', 'timeout']), exitCode: int, signal: token, errno: token},
  'engine-restart': {cause: oneOf(['window-gone', 'download-canceled'])},
  dictation: TRANSCRIPTION, file: TRANSCRIPTION, retry: TRANSCRIPTION,
  cancel: {phase: PHASE},
  'capture-error': {phase: PHASE, kind: token},
  'meeting-start': {app: name, appId: token, trigger: oneOf(['offer', 'manual'])},
  'meeting-chunk': {index: int, channel: oneOf(['left', 'right']), result: oneOf(['ok', 'fail']), attempts: int, transcribe: sec, kind: token},
  // `kind` is the window's recording error; `code` and `at` are a failed save's; `attempts` counts the quick tries.
  'meeting-finish': {duration: sec, turns: int, chunks: int, failed: int, result: oneOf(['saved', 'empty', 'error']), attempts: int,
    problem: oneOf(['window-gone', 'renderer']), kind: token, code: token, at: token},
  // A transcript whose save failed at the end of its call: saved later (`waited` seconds after; `delete` is a try made when
  // another unsaved one is deleted), or failing again at «Повторить» or at a quit, where `choice` is the answer to the warning.
  'meeting-save': {result: oneOf(['saved', 'error']), trigger: oneOf(['finish', 'timer', 'button', 'delete', 'quit']), waited: sec,
    choice: oneOf(['stay', 'quit']), code: token, at: token},
  download: {model: oneOf([...MODEL_IDS, 'formatter']), result: oneOf(['ok', 'error', 'canceled']), elapsed: sec, ...ERROR},
  'ipc-error': {channel: token, ...ERROR},
  // What main refuses outside a window command: a dictation by the hotkey or the tray, a call from the widget's offer.
  'command-error': {command: oneOf(['hotkey', 'meeting-record']), ...ERROR},
  // Node's two ways out for an error no code caught, and `store`: store.json failed to load at start, so the app quits.
  // `recovery`: the unfinished recordings found at start could not be saved; the app goes on with them in memory.
  'main-error': {origin: oneOf(['uncaughtException', 'unhandledRejection', 'store', 'recovery']), kind: token, code: token, at: token},
  'render-gone': {window: oneOf(['main', 'widget']), reason: token, exitCode: int},
  quit: {uptime: sec},
};

function timestamp(date) {
  const pad = (value, width = 2) => String(value).padStart(width, '0');
  const offset = -date.getTimezoneOffset(), sign = offset >= 0 ? '+' : '-';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:` +
    `${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}${sign}${pad(Math.floor(Math.abs(offset) / 60))}:${pad(Math.abs(offset) % 60)}`;
}

// What an error may tell the journal: its type, a system code (ENOENT) and the first frame in our code.
// The message is kept only for the engine's own expected errors; any other message can quote user data.
function errorFields(error) {
  if (!error || typeof error !== 'object') return {kind: typeof error, expected: false};
  const fields = {kind: String(error.kind || error.name || 'Error'), expected: error.expected === true};
  if (typeof error.code === 'string' || Number.isInteger(error.code)) fields.code = String(error.code);
  if (error.engine === true && error.expected === true) fields.message = String(error.message);
  const at = /electron[\\/]([\w-]+\.cjs):(\d+)/.exec(String(error.stack || ''));
  if (at) fields.at = `${at[1]}:${at[2]}`;
  return fields;
}

function createJournal({dir, home = os.homedir(), now = () => new Date(), platform = process.platform, maxBytes = 5 * 1024 * 1024, keep = 3}) {
  const files = Array.from({length: keep}, (_, index) => path.join(dir, index ? `shopot.${index}.log` : 'shopot.log'));
  // The user's home folder (often their real name) becomes ~, in either slash style; Windows paths ignore case.
  const escape = part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const homePattern = home && new RegExp(home.split(/[\\/]+/).filter(Boolean).map(escape).join('[\\\\/]+')
    .replace(/^/, home.startsWith('/') ? '/' : '') + '(?![\\p{L}\\p{N}])', platform === 'win32' ? 'giu' : 'gu');
  let size = null;

  function message(value) {
    if (typeof value !== 'string') return undefined;
    let text = homePattern ? value.replace(homePattern, '~') : value;
    text = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ').replace(/"/g, "'").replace(/\s+/g, ' ').trim().slice(0, 200);
    return text || undefined;
  }
  function format(event, fields) {
    const schema = EVENTS[event], parts = [timestamp(now()), event], rejected = [];
    for (const [key, type] of Object.entries(schema)) {
      if (fields[key] === undefined || fields[key] === null) continue;
      const value = type === MESSAGE ? (fields.expected === true ? message(fields[key]) : undefined) : type(fields[key]);
      if (value === undefined) { rejected.push(key); continue; }
      parts.push(`${key}=${type === MESSAGE || /\s/.test(value) ? `"${value}"` : value}`);
    }
    for (const key of Object.keys(fields)) if (!(key in schema) && TOKEN.test(key)) rejected.push(key);
    if (rejected.length) parts.push(`rejected=${rejected.join(',')}`);
    return parts.join(' ') + '\n';
  }
  // shopot.log moves aside first: while another program holds it open (Windows), the rotation stops before
  // any older part is touched. A rename replaces its target, so the oldest part goes only when the next takes its place.
  function rotate() {
    const aside = `${files[0]}.rotating`;
    fs.renameSync(files[0], aside);
    try {
      for (let index = files.length - 1; index > 1; index--) if (fs.existsSync(files[index - 1])) fs.renameSync(files[index - 1], files[index]);
      fs.renameSync(aside, files[1]);
    } catch (error) { fs.renameSync(aside, files[0]); throw error; }
    size = 0;
  }
  // Never throws: a full disk or a locked file must not stop a dictation.
  function write(event, fields = {}) {
    try {
      if (!Object.hasOwn(EVENTS, event)) return false;
      const line = format(event, fields), bytes = Buffer.byteLength(line);
      if (size === null) { fs.mkdirSync(dir, {recursive: true}); size = fs.existsSync(files[0]) ? fs.statSync(files[0]).size : 0; }
      if (size > 0 && size + bytes > maxBytes) rotate();
      fs.appendFileSync(files[0], line, 'utf8');
      size += bytes;
      return true;
    } catch { size = null; return false; }
  }
  // Follows the history retention period: no line older than `days` days stays in any file.
  function pruneOlderThan(days) {
    if (!(typeof days === 'number' && Number.isFinite(days) && days > 0)) return;
    const cutoff = now().getTime() - days * 864e5;
    for (const file of files) {
      try {
        if (!fs.existsSync(file)) continue;
        const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
        const kept = lines.filter(line => Date.parse(line.slice(0, line.indexOf(' '))) >= cutoff);
        if (kept.length === lines.length) continue;
        if (!kept.length) { fs.rmSync(file, {force: true}); continue; }
        fs.writeFileSync(file + '.tmp', kept.join('\n') + '\n', 'utf8');
        fs.renameSync(file + '.tmp', file);
      } catch {
        // A locked file keeps its old lines until the next prune; its pruned copy does not stay behind.
        try { fs.rmSync(file + '.tmp', {force: true}); } catch {}
      }
    }
    size = null;
  }
  // The whole journal as one text, oldest line first: shopot.2.log, shopot.1.log, then shopot.log.
  // Synchronous on purpose, so no write or rotation lands between the parts. Unlike write, it throws.
  function read() {
    let text = '';
    for (const file of [...files].reverse()) {
      if (!fs.existsSync(file)) continue;
      const part = fs.readFileSync(file, 'utf8');
      text += part && !part.endsWith('\n') ? `${part}\n` : part;
    }
    return text;
  }
  return {write, read, pruneOlderThan, dir};
}

module.exports = {createJournal, timestamp, errorFields};
