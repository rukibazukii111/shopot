const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const GB = 1024 ** 3;

async function launch(totalMemory, entries = []) {
  const dataDir = path.join(root, '.private', 'ui-test', `memory-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  for (const entry of entries) store.addHistory(entry);
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')],
    env: {...env, SHOPOT_DATA_DIR: dataDir, SHOPOT_TEST_TOTAL_MEMORY: String(totalMemory)}});
  const page = await app.firstWindow();
  await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
  return {app, page};
}

test('8 GB machine: heavy Whisper models warn and take a second click', async () => {
  const {app, page} = await launch(8 * GB);
  try {
    await page.locator('[data-page="models"]').click();
    const card = id => page.locator('.model-card', {has: page.locator(`[data-model="${id}"]`)});
    await expect(card('turbo').locator('.model-warning')).toContainText('На этом компьютере 8 ГБ памяти');
    await expect(card('large-v3').locator('.model-warning')).toContainText('около 3,3 ГБ');
    await expect(card('gigaam').locator('.model-warning')).toHaveCount(0);
    await page.locator('[data-model="turbo"]').click();
    await expect(page.locator('[data-model="turbo"]')).toHaveText('Всё равно выбрать');
    expect((await page.evaluate(() => window.shopot.boot())).settings.model).toBe('gigaam');
    await page.locator('[data-model="turbo"]').click();
    await expect(page.locator('[data-model="turbo"]')).toHaveText('Используется');
    expect((await page.evaluate(() => window.shopot.boot())).settings.model).toBe('turbo');
    await page.locator('[data-page="dictation"]').click();
    await expect(page.locator('#active-model-state')).toHaveText('Точная, тяжёлая для 8 ГБ памяти');
    await expect(page.locator('#active-model-state')).toHaveClass(/warn/);
  } finally { await app.close(); }
});

test('large machine: no memory warnings, and history shows what a dictation cost', async () => {
  const {app, page} = await launch(32 * GB, [{id: 'measured', createdAt: '2026-09-26T10:00:00Z', source: 'Микрофон',
    text: 'Проверка памяти.', rawText: 'Проверка памяти.', words: [], duration: 3, elapsed: 2.7, loadElapsed: 1.2,
    memoryPeak: 360 * 1024 ** 2, model: 'gigaam', mode: 'natural', replacements: [], audioFile: null}]);
  try {
    await page.locator('[data-page="models"]').click();
    await expect(page.locator('.model-warning')).toHaveCount(0);
    await page.locator('[data-model="turbo"]').click();
    await expect(page.locator('[data-model="turbo"]')).toHaveText('Используется');
    await page.locator('[data-page="history"]').click();
    const meta = page.locator('#history-detail .meta-list');
    await expect(meta).toContainText('пик 360 МБ из 32 ГБ');
    await expect(meta).toContainText('2,7 с, из них загрузка модели 1,2 с');
  } finally { await app.close(); }
});
