const test = require('node:test');
const assert = require('node:assert/strict');
const {summaryAvailable, summaryPrompt} = require('../electron/summary.cjs');

const dictation = seconds => ({source: 'Микрофон', duration: seconds, text: 'Заметка'});

test('long recordings get the summary button, short dictations do not', () => {
  assert.equal(summaryAvailable(dictation(30)), false);
  assert.equal(summaryAvailable(dictation(120)), false);
  assert.equal(summaryAvailable(dictation(121)), true);
  assert.equal(summaryAvailable({source: 'Микрофон', text: 'x'}), false);
  assert.equal(summaryAvailable({source: 'Незавершённая запись', duration: 30}), false);
  assert.equal(summaryAvailable({source: 'Незавершённая запись', duration: 150}), true);
  assert.equal(summaryAvailable({source: 'голосовое.ogg', duration: 5}), true);
  assert.equal(summaryAvailable({source: 'Созвон, часть 2', duration: 20}), true);
  assert.equal(summaryAvailable({source: 'Созвон · Discord', duration: 30, meeting: {app: 'Discord'}}), true);
});

test('the request names what kind of recording it is', () => {
  assert.match(summaryPrompt({source: 'Созвон · Discord', meeting: {app: 'Discord'}, text: '[00:00] Я: Привет'}),
    /^Сделай краткое резюме созвона \(Discord\).*«Я» — это я.*\n\n\[00:00\] Я: Привет$/s);
  assert.equal(summaryPrompt({source: 'Созвон', meeting: {}, text: 'т'}).startsWith('Сделай краткое резюме созвона: '), true);
  assert.equal(summaryPrompt({source: 'лекция.mp3', duration: 5, text: 'Текст'}),
    'Сделай краткое резюме записи «лекция.mp3»: главные темы, принятые решения, задачи с ответственными и сроками, открытые вопросы.\n\nТекст');
  assert.equal(summaryPrompt(dictation(150)),
    'Сделай краткое резюме моей надиктованной заметки: главные мысли, решения, задачи и сроки, открытые вопросы.\n\nЗаметка');
  assert.match(summaryPrompt({source: 'Незавершённая запись', duration: 150, text: 'т'}), /^Сделай краткое резюме моей надиктованной заметки/);
});
