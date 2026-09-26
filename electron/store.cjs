const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = {
  model: 'gigaam', language: 'ru', mode: 'natural', context: '',
  autoCopy: true, autoPaste: true, keepAudio: false, microphoneId: 'default', formatting: 'rules', removeFillers: true,
  voiceCommands: true, meetingOffers: true, meetingIgnore: [], translate: false,
};
const MODEL_IDS = ['gigaam', 'small', 'turbo', 'large-v3'];
const RUSSIAN_ONLY = ['gigaam'];
// Whisper models that can translate speech into English (turbo cannot).
const TRANSLATING = ['small', 'large-v3'];
const FORMATTING = ['rules', 'off', 'llm'];
const INITIAL_DICTIONARY = ['Whisper', 'GitHub', 'iOS', 'iPhone', 'Reels', 'TikTok', 'YouTube', 'VPN']
  .map(word => ({id: crypto.randomUUID(), word, aliases: []}));

function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Некорректные настройки');
  const result = {...DEFAULT_SETTINGS};
  for (const [key, values] of Object.entries({model: MODEL_IDS, language: ['ru', 'en', 'auto'], mode: ['natural', 'minimal', 'raw'], formatting: FORMATTING})) {
    if (!values.includes(input[key] ?? result[key])) throw new Error('Некорректное значение: ' + key);
    result[key] = input[key] ?? result[key];
  }
  for (const key of ['autoCopy', 'autoPaste', 'keepAudio', 'removeFillers', 'voiceCommands', 'meetingOffers', 'translate']) {
    if (key in input && typeof input[key] !== 'boolean') throw new Error('Некорректное значение: ' + key);
    result[key] = input[key] ?? result[key];
  }
  if (RUSSIAN_ONLY.includes(result.model) && result.language !== 'ru') {
    throw new Error('GigaAM распознаёт только русский. Для других языков выбери Whisper в разделе «Модели».');
  }
  if (result.translate && !TRANSLATING.includes(result.model)) {
    throw new Error('Перевод на английский работает с моделями «Лёгкая» и «Полная».');
  }
  // Apps whose microphone use should not suggest recording a call (games, voice notes).
  const ignore = input.meetingIgnore ?? [];
  if (!Array.isArray(ignore) || ignore.length > 50) throw new Error('Некорректное значение: meetingIgnore');
  result.meetingIgnore = ignore.map(app => ({id: String(app?.id ?? '').toLowerCase().slice(0, 300), name: String(app?.name ?? '').slice(0, 80)}))
    .filter((app, index, all) => app.id && all.findIndex(other => other.id === app.id) === index);
  result.context = String(input.context ?? '').slice(0, 200);
  result.microphoneId = String(input.microphoneId ?? 'default').slice(0, 256);
  return result;
}

function validateDictionary(input) {
  if (!Array.isArray(input) || input.length > 100) throw new Error('В словаре можно хранить до 100 слов');
  const words = new Set();
  return input.map(entry => {
    const word = String(entry.word ?? '').trim();
    if (!word || word.length > 80 || /[\r\n]/.test(word)) throw new Error('Слово должно содержать от 1 до 80 символов');
    const folded = word.toLocaleLowerCase();
    if (words.has(folded)) throw new Error('Это слово уже есть в словаре');
    words.add(folded);
    if (!Array.isArray(entry.aliases) || entry.aliases.length > 10) throw new Error('Можно задать до 10 вариантов замены');
    const aliases = entry.aliases.map(a => String(a).trim()).filter(Boolean);
    if (aliases.some(a => a.length > 80 || /[\r\n]/.test(a))) throw new Error('Слишком длинный вариант замены');
    return {id: /^[a-zA-Z0-9-]{1,64}$/.test(entry.id ?? '') ? entry.id : crypto.randomUUID(), word, aliases};
  });
}

// Spoken phrases are compared without case, «ё» and punctuation, as the engine matches them.
function foldPhrase(text) { return text.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }

function validateSnippets(input) {
  if (!Array.isArray(input) || input.length > 50) throw new Error('Можно сохранить до 50 сниппетов');
  const triggers = new Set();
  return input.map(entry => {
    const trigger = String(entry?.trigger ?? '').trim().replace(/\s+/g, ' ');
    if (trigger.length < 2 || trigger.length > 60) throw new Error('Фраза должна содержать от 2 до 60 символов');
    const folded = foldPhrase(trigger);
    if (!folded) throw new Error('Во фразе должны быть слова');
    if (triggers.has(folded)) throw new Error('Такая фраза уже есть');
    triggers.add(folded);
    const text = String(entry?.text ?? '').replace(/\r\n?/g, '\n');
    if (!text.trim() || text.length > 4000) throw new Error('Текст сниппета должен содержать от 1 до 4000 символов');
    return {id: /^[a-zA-Z0-9-]{1,64}$/.test(entry.id ?? '') ? entry.id : crypto.randomUUID(), trigger, text};
  });
}

// Per-app text settings: null means "as in the general settings".
function validateProfiles(input) {
  if (!Array.isArray(input) || input.length > 30) throw new Error('Можно настроить до 30 приложений');
  const apps = new Set();
  return input.map(entry => {
    const app = String(entry?.app ?? '').trim().toLowerCase();
    if (!app || app.length > 200 || /[\r\n]/.test(app)) throw new Error('Некорректное приложение');
    if (apps.has(app)) throw new Error('Это приложение уже настроено');
    apps.add(app);
    const mode = entry.mode ?? null, formatting = entry.formatting ?? null;
    if (mode !== null && !['natural', 'minimal', 'raw'].includes(mode)) throw new Error('Некорректный режим текста');
    if (formatting !== null && !FORMATTING.includes(formatting)) throw new Error('Некорректное оформление');
    if ('dropFinalPeriod' in entry && typeof entry.dropFinalPeriod !== 'boolean') throw new Error('Некорректное значение: dropFinalPeriod');
    return {app, name: String(entry.name ?? '').trim().slice(0, 80) || app, mode, formatting, dropFinalPeriod: Boolean(entry.dropFinalPeriod)};
  });
}

// Settings for one dictation into `app`: that app's own choices win over the general ones.
function settingsFor(settings, profiles, app) {
  const profile = app?.id && profiles.find(p => p.app === app.id);
  if (!profile) return settings;
  return {...settings, ...(profile.mode && {mode: profile.mode}), ...(profile.formatting && {formatting: profile.formatting}),
    dropFinalPeriod: profile.dropFinalPeriod};
}

class Store {
  constructor(root) {
    this.root = root;
    fs.mkdirSync(root, {recursive: true});
    this.file = path.join(root, 'store.json');
    let state;
    if (fs.existsSync(this.file)) {
      try { state = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
      catch { throw new Error('Не удалось прочитать историю. Файл store.json сохранён без изменений.'); }
    }
    this.data = state ?? {version: 1, settings: DEFAULT_SETTINGS, dictionary: INITIAL_DICTIONARY, history: []};
    this.data.settings = validateSettings(this.data.settings);
    this.data.dictionary = validateDictionary(this.data.dictionary);
    this.data.snippets = validateSnippets(this.data.snippets ?? []);
    this.data.profiles = validateProfiles(this.data.profiles ?? []);
    if (!Array.isArray(this.data.history)) throw new Error('Повреждён формат истории');
    this.data.pendingRecordings ??= [];
    if (!Array.isArray(this.data.pendingRecordings)) throw new Error('Повреждён список незавершённых записей');
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), {mode: 0o600});
    fs.renameSync(temp, this.file);
  }
  setSettings(settings) { this.data.settings = validateSettings(settings); this.save(); return this.data.settings; }
  setDictionary(entries) { this.data.dictionary = validateDictionary(entries); this.save(); return this.data.dictionary; }
  setSnippets(entries) { this.data.snippets = validateSnippets(entries); this.save(); return this.data.snippets; }
  setProfiles(entries) { this.data.profiles = validateProfiles(entries); this.save(); return this.data.profiles; }
  addHistory(entry) { this.data.history.unshift(entry); this.save(); return entry; }
}

module.exports = {Store, validateSettings, validateDictionary, validateSnippets, validateProfiles, settingsFor, DEFAULT_SETTINGS, MODEL_IDS};
