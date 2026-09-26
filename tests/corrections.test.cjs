const {test} = require('node:test');
const assert = require('node:assert/strict');
const {suggestCorrections} = require('../electron/corrections.cjs');

test('a corrected phrase becomes a dictionary suggestion', () => {
  assert.deepEqual(suggestCorrections('Открой локал сенд, пожалуйста.', 'Открой LocalSend, пожалуйста.'), [{word: 'LocalSend', alias: 'локал сенд'}]);
  assert.deepEqual(suggestCorrections('Залей на гитхаб и скинь в телегу.', 'Залей на GitHub и скинь в Telegram.'),
    [{word: 'GitHub', alias: 'гитхаб'}, {word: 'Telegram', alias: 'телегу'}]);
});

test('an unusual spelling is suggested as a word, a capital at a sentence start is not', () => {
  assert.deepEqual(suggestCorrections('Купил iphone.', 'Купил iPhone.'), [{word: 'iPhone'}]);
  assert.deepEqual(suggestCorrections('привет, как дела', 'Привет, как дела'), []);
});

test('punctuation, numbers, insertions and rewrites are not corrections', () => {
  assert.deepEqual(suggestCorrections('Привет как дела', 'Привет, как дела?'), []);
  assert.deepEqual(suggestCorrections('Купи пять яблок.', 'Купи 5 яблок.'), []);
  assert.deepEqual(suggestCorrections('Купи яблок.', 'Купи зелёных яблок.'), []);
  assert.deepEqual(suggestCorrections('Раз два три четыре пять.', 'Совсем другой текст из пяти слов.'), []);
});

test('what the dictionary already knows is not suggested again', () => {
  const dictionary = [{word: 'GitHub', aliases: ['гитхаб']}, {word: 'iPhone', aliases: []}];
  assert.deepEqual(suggestCorrections('Залей на гитхаб.', 'Залей на GitHub.', dictionary), []);
  assert.deepEqual(suggestCorrections('Залей на гит хаб.', 'Залей на GitHub.', dictionary), [{word: 'GitHub', alias: 'гит хаб'}]);
  assert.deepEqual(suggestCorrections('Купил iphone.', 'Купил iPhone.', dictionary), []);
});

test('at most three suggestions, without repeats', () => {
  const before = 'раз альфа два альфа три бета четыре гамма пять дельта';
  const after = 'раз Alpha два Alpha три Beta четыре Gamma пять Delta';
  assert.deepEqual(suggestCorrections(before, after).map(s => s.word), ['Alpha', 'Beta', 'Gamma']);
});
