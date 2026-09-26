const {test} = require('node:test');
const assert = require('node:assert/strict');
const {exportText, toSrt, toMarkdown, srtTime} = require('../electron/export.cjs');

test('SubRip: numbered cues, comma milliseconds, two lines at most', () => {
  assert.equal(srtTime(3725.5), '01:02:05,500');
  const srt = toSrt([{start: 0, end: 2.34, text: 'Сегодня мы запускаем новый курс по монтажу видео и расскажем, как всё устроено.'},
    {start: 2.6, end: 2.7, text: 'Коротко.'}]);
  assert.equal(srt, '1\r\n00:00:00,000 --> 00:00:02,340\r\nСегодня мы запускаем новый курс по монтажу\r\nвидео и расскажем, как всё устроено.\r\n'
    + '\r\n2\r\n00:00:02,600 --> 00:00:03,100\r\nКоротко.\r\n');
});

test('Markdown turns dictation bullets into list items and keeps numbered lists', () => {
  assert.equal(toMarkdown('Купить:\n• молоко\n• хлеб\n\n1. Раз\n2. Два'), 'Купить:\n- молоко\n- хлеб\n\n1. Раз\n2. Два');
});

test('the chosen format decides the content; subtitles need timing', () => {
  const entry = {cues: [{start: 1, end: 2, text: 'Привет.'}]};
  assert.equal(exportText('txt', entry, '• Текст'), '• Текст');
  assert.equal(exportText('md', entry, '• Текст'), '- Текст');
  assert.match(exportText('srt', entry, 'ignored'), /^1\r\n00:00:01,000 --> 00:00:02,000\r\nПривет\.\r\n$/);
  assert.throws(() => exportText('srt', {}, 'x'), /времени/);
});
