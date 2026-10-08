const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

const entry = (id, createdAt, source, duration, text) => ({id, createdAt, source, text, rawText: text, words: [], duration, elapsed: .5,
  model: 'gigaam', mode: 'natural', replacements: [], audioFile: null});

test('long recordings offer a summary request, short dictations do not', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `summary-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.addHistory(entry('voice-note', '2026-10-08T09:00:00Z', 'голосовое.ogg', 8, 'Купить хлеб.'));
  store.addHistory(entry('short', '2026-10-08T09:10:00Z', 'Микрофон', 40, 'Короткая заметка.'));
  store.addHistory(entry('long', '2026-10-08T09:20:00Z', 'Микрофон', 150, 'Длинная заметка про план.'));
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await app.evaluate(({clipboard}) => { clipboard.writeText = text => { globalThis.__copied = text; }; });
    // The latest result card on the dictation page is the long dictation.
    await expect(page.locator('.result-card [data-action="summary"]')).toBeVisible();
    await page.locator('[data-page="history"]').click();
    const button = page.locator('#history-detail [data-action="summary"]');
    await page.locator('[data-select-entry="short"]').click();
    await expect(page.locator('#history-detail')).toContainText('Короткая заметка.');
    await expect(button).toHaveCount(0);
    await page.locator('[data-select-entry="voice-note"]').click();
    await expect(page.locator('#history-detail')).toContainText('Купить хлеб.');
    await expect(button).toBeVisible();
    await page.locator('[data-select-entry="long"]').click();
    await expect(page.locator('#history-detail')).toContainText('Длинная заметка про план.');
    await button.click();
    await expect(page.locator('#toast')).toContainText('Скопировано с просьбой о резюме. Вставь в ChatGPT или Claude');
    // Windows gets CRLF line breaks in the clipboard.
    expect((await app.evaluate(() => globalThis.__copied)).replace(/\r\n/g, '\n')).toBe(
      'Сделай краткое резюме моей надиктованной заметки: главные мысли, решения, задачи и сроки, открытые вопросы.\n\nДлинная заметка про план.');
  } finally { await app.close(); }
});
