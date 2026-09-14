const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const testRoot = path.join(root, '.private', 'ui-test');
const cleanEnv = {...process.env};
delete cleanEnv.ELECTRON_RUN_AS_NODE;

test('desktop: real worker, personal dictionary, modes and local history', async () => {
  const dataDir = path.join(testRoot, `run-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.addHistory({id: 'fixture-transcript', createdAt: '2026-09-14T09:00:00Z', source: 'Тестовый пример',
    text: 'Открой LocalSend. Видосы готовы.', rawText: 'Открой локал сенд. Видосы готовы.', words: [],
    duration: 5, elapsed: 1.2, model: 'turbo', mode: 'natural', replacements: [], audioFile: null});
  const errors = [];
  const app = await electron.launch({args: [root], env: {...cleanEnv, SHOPOT_DATA_DIR: dataDir}});
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок', {timeout: 20000});
    await expect(page.locator('#record-label')).toHaveText('Скачать модель');
    await expect(page.locator('.transcript-editor')).toHaveValue('Открой LocalSend. Видосы готовы.');
    await page.locator('[data-result-tab="raw"]').click();
    await expect(page.locator('.raw-text')).toContainText('локал сенд');
    await page.locator('[data-page="dictionary"]').click();
    await page.locator('#add-word').click();
    await page.locator('#word-input').fill('Qwen'); await page.locator('#alias-input').fill('квэн, куэн');
    await page.locator('#dictionary-form button[type="submit"]').click();
    await expect(page.locator('.dictionary-word').filter({hasText: 'Qwen'})).toBeVisible();
    await page.locator('[data-page="dictation"]').click();
    await page.locator('#quick-mode').selectOption('minimal');
    await expect(page.locator('#mode-description')).toContainText('Написание версий');
    await page.locator('[data-page="history"]').click();
    await page.locator('#history-search').fill('не существующая фраза');
    await expect(page.locator('#history-list')).toContainText('ничего не найдено');
    await page.locator('#history-search').fill('LocalSend');
    await expect(page.locator('#history-list .result-card')).toHaveCount(1);
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
    expect(persisted.dictionary.find(e => e.word === 'Qwen').aliases).toEqual(['квэн', 'куэн']);
    expect(persisted.settings.mode).toBe('minimal');
    await page.locator('[data-page="settings"]').click();
    await page.locator('#context-input').fill('Монтаж, сленг и GitHub');
    await page.locator('#auto-copy').uncheck();
    await expect(page.locator('#context-input')).toHaveValue('Монтаж, сленг и GitHub');
    await page.locator('#save-context').click();
    await expect(page.locator('#toast')).toHaveText('Контекст сохранён');
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).settings.context).toBe('Монтаж, сленг и GitHub');
    await page.locator('[data-page="dictation"]').click();
    await page.screenshot({path: path.join(testRoot, 'desktop.png')});
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});

test('microphone permission failure is recoverable; canceled recording releases microphone', async () => {
  const dataDir = path.join(testRoot, `audio-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: {...cleanEnv, SHOPOT_DATA_DIR: dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку', {timeout: 20000});
    await page.evaluate(() => { window.originalGetMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices); navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); }; });
    await page.locator('#record-button').click();
    await expect(page.locator('#error-banner')).toContainText('Нет доступа к микрофону');
    await expect(page.locator('#record-button')).toBeEnabled();
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async (...args) => { window.testStream = await window.originalGetMedia(...args); return window.testStream; }; });
    await page.locator('#record-button').click();
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await page.locator('#cancel-button').click();
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    expect(await page.evaluate(() => window.testStream.getTracks().every(t => t.readyState === 'ended'))).toBe(true);
    await expect(page.locator('#latest-result')).toContainText('Здесь появятся твои слова');
    expect(fs.readdirSync(path.join(dataDir, 'audio'))).toEqual([]);
  } finally { await app.close(); }
});
