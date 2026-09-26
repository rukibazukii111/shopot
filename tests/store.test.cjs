const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {Store, validateDictionary, validateSettings, validateSnippets, validateProfiles, settingsFor} = require('../electron/store.cjs');

test('saved corrections and original transcription survive reopening', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-store-'));
  try {
    const store = new Store(root);
    store.addHistory({id: 'record1', rawText: 'локал сенд', text: 'LocalSend'});
    store.setSettings({...store.data.settings, keepAudio: true, mode: 'raw'});
    const reopened = new Store(root);
    assert.equal(reopened.data.history[0].rawText, 'локал сенд');
    assert.equal(reopened.data.history[0].text, 'LocalSend');
    assert.equal(reopened.data.settings.mode, 'raw');
    assert.equal(reopened.data.settings.keepAudio, true);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('corrupted history is preserved instead of silently overwritten', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-corrupt-'));
  try {
    fs.writeFileSync(path.join(root, 'store.json'), '{broken');
    assert.throws(() => new Store(root), /store.json/);
    assert.equal(fs.readFileSync(path.join(root, 'store.json'), 'utf8'), '{broken');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('model ids and modes cannot be arbitrary strings', () => {
  assert.throws(() => validateSettings({model: '../../secret'}));
  assert.throws(() => validateSettings({mode: 'rewrite'}));
  assert.throws(() => validateSettings({keepAudio: 'false'}));
  assert.throws(() => validateSettings({autoPaste: 'false'}));
  assert.throws(() => validateSettings({formatting: 'rewrite'}));
  assert.throws(() => validateSettings({removeFillers: 'yes'}));
  assert.equal(validateSettings({}).removeFillers, true);
  assert.throws(() => validateSettings({voiceCommands: 'yes'}));
  assert.equal(validateSettings({}).voiceCommands, true);
  // Only Whisper small and large-v3 translate into English.
  assert.equal(validateSettings({}).translate, false);
  assert.equal(validateSettings({model: 'small', translate: true}).translate, true);
  assert.throws(() => validateSettings({model: 'turbo', translate: true}), /Лёгкая/);
  assert.throws(() => validateSettings({model: 'gigaam', translate: true}), /Лёгкая/);
  assert.equal(validateSettings({}).formatting, 'rules');
  assert.equal(validateSettings({formatting: 'llm'}).formatting, 'llm');
  assert.equal(validateSettings({model: 'large-v3', autoCopy: false}).autoPaste, true);
});
test('Russian-only GigaAM is the default and cannot be combined with other languages', () => {
  assert.equal(validateSettings({}).model, 'gigaam');
  assert.throws(() => validateSettings({model: 'gigaam', language: 'en'}), /только русский/);
  assert.throws(() => validateSettings({model: 'gigaam', language: 'auto'}), /только русский/);
  assert.equal(validateSettings({model: 'turbo', language: 'en'}).language, 'en');
});
test('dictionary rejects duplicates and bounded invalid inputs', () => {
  assert.throws(() => validateDictionary([{word: 'iOS', aliases: []}, {word: 'ios', aliases: []}]), /уже/);
  assert.throws(() => validateDictionary([{word: 'a', aliases: ['b'.repeat(81)]}]));
  assert.equal(validateDictionary([{word: 'LocalSend', aliases: ['локал сенд']}])[0].word, 'LocalSend');
});
test('snippets are bounded, unique by their spoken form and keep their text as written', () => {
  const [snippet] = validateSnippets([{trigger: '  Моя   почта ', text: 'ivan@example.com\r\nВторая строка'}]);
  assert.equal(snippet.trigger, 'Моя почта');
  assert.equal(snippet.text, 'ivan@example.com\nВторая строка');
  assert.throws(() => validateSnippets([{trigger: 'моя почта', text: 'a'}, {trigger: 'Моя, почта', text: 'b'}]), /уже есть/);
  assert.throws(() => validateSnippets([{trigger: 'ещё раз', text: 'a'}, {trigger: 'еще раз', text: 'b'}]), /уже есть/);
  assert.throws(() => validateSnippets([{trigger: 'а', text: 'x'}]), /от 2 до 60/);
  assert.throws(() => validateSnippets([{trigger: '...', text: 'x'}]), /слова/);
  assert.throws(() => validateSnippets([{trigger: 'фраза', text: '   '}]), /от 1 до 4000/);
  assert.throws(() => validateSnippets([{trigger: 'фраза', text: 'x'.repeat(4001)}]), /от 1 до 4000/);
  assert.throws(() => validateSnippets(Array.from({length: 51}, (_, i) => ({trigger: `фраза ${i}`, text: 'x'}))), /50/);
  assert.throws(() => validateSnippets('x'));
});
test('stores from older versions open with an empty snippet list', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-snippets-'));
  try {
    fs.writeFileSync(path.join(root, 'store.json'), JSON.stringify({version: 1, settings: {}, dictionary: [], history: []}));
    const store = new Store(root);
    assert.deepEqual(store.data.snippets, []);
    store.setSnippets([{trigger: 'моя почта', text: 'ivan@example.com'}]);
    assert.equal(new Store(root).data.snippets[0].text, 'ivan@example.com');
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});
test('per-app profiles override only what they set, for the app that had focus', () => {
  const profiles = validateProfiles([{app: 'Telegram.exe', name: 'Telegram', mode: 'minimal', dropFinalPeriod: true}, {app: 'code.exe', name: 'VS Code', formatting: 'off'}]);
  assert.deepEqual(profiles[0], {app: 'telegram.exe', name: 'Telegram', mode: 'minimal', formatting: null, dropFinalPeriod: true});
  const settings = validateSettings({});
  assert.deepEqual(settingsFor(settings, profiles, {id: 'telegram.exe', name: 'Telegram'}), {...settings, mode: 'minimal', dropFinalPeriod: true});
  assert.deepEqual(settingsFor(settings, profiles, {id: 'code.exe'}), {...settings, formatting: 'off', dropFinalPeriod: false});
  assert.equal(settingsFor(settings, profiles, {id: 'chrome.exe'}), settings);
  assert.equal(settingsFor(settings, profiles, null), settings);
  assert.throws(() => validateProfiles([{app: 'a.exe'}, {app: 'A.EXE'}]), /уже настроено/);
  assert.throws(() => validateProfiles([{app: 'a.exe', mode: 'rewrite'}]), /режим/);
  assert.throws(() => validateProfiles([{app: 'a.exe', formatting: 'fancy'}]), /оформление/);
  assert.throws(() => validateProfiles([{app: 'a.exe', dropFinalPeriod: 'yes'}]));
  assert.throws(() => validateProfiles([{app: ''}]), /приложение/);
  assert.throws(() => validateProfiles(Array.from({length: 31}, (_, i) => ({app: `app${i}.exe`}))), /30/);
});
