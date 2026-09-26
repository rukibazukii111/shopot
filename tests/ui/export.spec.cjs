const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('a transcribed file saves as text, Markdown or subtitles', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `export-${Date.now()}`);
  const out = path.join(dataDir, 'exports');
  fs.mkdirSync(out, {recursive: true});
  const store = new Store(dataDir);
  store.addHistory({id: 'interview', createdAt: '2026-09-26T09:00:00Z', source: 'интервью.m4a', text: 'Привет всем. Начинаем.\n• Первый пункт',
    rawText: 'Привет всем. Начинаем.', words: [], duration: 3, elapsed: .5, model: 'gigaam', mode: 'natural', replacements: [], audioFile: null,
    cues: [{start: 0, end: 1.5, text: 'Привет всем.'}, {start: 1.6, end: 3, text: 'Начинаем.'}]});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: dataDir}});
  const saveAs = file => app.evaluate(({dialog}, target) => {
    dialog.showSaveDialog = async (window, options) => { globalThis.__saveOptions = options; return {canceled: false, filePath: target}; };
  }, file);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await page.locator('[data-page="history"]').click();
    const subtitles = path.join(out, 'интервью.srt');
    await saveAs(subtitles);
    await page.locator('#history-detail [data-action="export"]').click();
    await expect(page.locator('#toast')).toContainText('Сохранено: интервью.srt');
    expect(fs.readFileSync(subtitles, 'utf8')).toBe('1\r\n00:00:00,000 --> 00:00:01,500\r\nПривет всем.\r\n\r\n2\r\n00:00:01,600 --> 00:00:03,000\r\nНачинаем.\r\n');
    const options = await app.evaluate(() => globalThis.__saveOptions);
    expect(options.defaultPath).toBe('интервью.txt');
    expect(options.filters.map(f => f.extensions[0])).toEqual(['txt', 'md', 'srt']);
    const markdown = path.join(out, 'интервью.md');
    await saveAs(markdown);
    await page.locator('#history-detail [data-action="export"]').click();
    await expect.poll(() => fs.existsSync(markdown)).toBe(true);
    expect(fs.readFileSync(markdown, 'utf8')).toBe('Привет всем. Начинаем.\n- Первый пункт');
  } finally { await app.close(); }
});
