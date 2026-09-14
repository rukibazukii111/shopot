const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const DEFAULT_SETTINGS = {
  model: 'turbo', language: 'ru', mode: 'natural', context: '',
  autoCopy: true, autoPaste: true, keepAudio: false, microphoneId: 'default',
};
const INITIAL_DICTIONARY = ['Whisper', 'GitHub', 'iOS', 'iPhone', 'Reels', 'TikTok', 'YouTube', 'VPN']
  .map(word => ({id: crypto.randomUUID(), word, aliases: []}));

function validateSettings(input) {
  if (!input || typeof input !== 'object') throw new Error('Некорректные настройки');
  const result = {...DEFAULT_SETTINGS};
  for (const [key, values] of Object.entries({model: ['small', 'turbo', 'large-v3'], language: ['ru', 'en', 'auto'], mode: ['natural', 'minimal', 'raw']})) {
    if (!values.includes(input[key] ?? result[key])) throw new Error('Некорректное значение: ' + key);
    result[key] = input[key] ?? result[key];
  }
  for (const key of ['autoCopy', 'autoPaste', 'keepAudio']) {
    if (key in input && typeof input[key] !== 'boolean') throw new Error('Некорректное значение: ' + key);
    result[key] = input[key] ?? result[key];
  }
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
    if (!Array.isArray(this.data.history)) throw new Error('Повреждён формат истории');
  }
  save() {
    const temp = this.file + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.data, null, 2), {mode: 0o600});
    fs.renameSync(temp, this.file);
  }
  setSettings(settings) { this.data.settings = validateSettings(settings); this.save(); return this.data.settings; }
  setDictionary(entries) { this.data.dictionary = validateDictionary(entries); this.save(); return this.data.dictionary; }
  addHistory(entry) { this.data.history.unshift(entry); this.save(); return entry; }
}

module.exports = {Store, validateSettings, validateDictionary, DEFAULT_SETTINGS};
