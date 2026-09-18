const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {Store, validateDictionary, validateSettings} = require('../electron/store.cjs');

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
