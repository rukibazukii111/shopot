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
    await page.locator('input[name="mode"][value="minimal"]').check();
    await expect(page.locator('.radio-row:has(input[value="minimal"])')).toContainText('Написание версий');
    await expect(page.locator('input[name="mode"][value="natural"]')).not.toBeChecked();
    await page.locator('[data-page="history"]').click();
    await page.locator('#history-search').fill('не существующая фраза');
    await expect(page.locator('#history-list')).toContainText('Ничего не нашлось');
    await page.locator('#history-search').fill('LocalSend');
    await expect(page.locator('#history-list .history-row')).toHaveCount(1);
    await expect(page.locator('#history-detail .history-editor')).toHaveValue('Открой LocalSend. Видосы готовы.');
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
    expect(persisted.dictionary.find(e => e.word === 'Qwen').aliases).toEqual(['квэн', 'куэн']);
    expect(persisted.settings.mode).toBe('minimal');
    await page.locator('[data-page="settings"]').click();
    await page.locator('#context-input').fill('Монтаж, сленг и GitHub');
    await page.locator('#auto-copy').uncheck();
    await page.locator('#voice-commands').uncheck();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).settings.voiceCommands).toBe(false);
    await expect(page.locator('#context-input')).toHaveValue('Монтаж, сленг и GitHub');
    await page.locator('#save-context').click();
    await expect(page.locator('#save-context')).toHaveText('Сохранено');
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

test('keyboard: Ctrl+F searches history, arrows select, Enter copies; Ctrl+N starts a new word', async () => {
  const dataDir = path.join(testRoot, `keys-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  for (const [id, text, createdAt] of [['older', 'Первая фраза.', '2026-09-14T09:00:00Z'], ['newer', 'Вторая фраза.', '2026-09-14T10:00:00Z']]) {
    store.addHistory({id, createdAt, source: 'Микрофон', text, rawText: text, words: [], duration: 2, elapsed: .2, model: 'gigaam', mode: 'natural', replacements: [], audioFile: null});
  }
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...cleanEnv, SHOPOT_DATA_DIR: dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    // Keep the user's real clipboard untouched.
    await app.evaluate(({clipboard}) => { clipboard.writeText = text => { globalThis.__copied = text; }; });
    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-detail .history-editor')).toHaveValue('Вторая фраза.');
    await page.keyboard.press('Control+KeyF');
    await expect(page.locator('#history-search')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(page.locator('#history-detail .history-editor')).toHaveValue('Первая фраза.');
    await expect(page.locator('#history-search')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect.poll(() => app.evaluate(() => globalThis.__copied)).toBe('Первая фраза.');
    await expect(page.locator('#history-detail [data-action="copy"]')).toContainText('Скопировано');
    await page.locator('[data-page="dictionary"]').click();
    await page.keyboard.press('Control+KeyN');
    await expect(page.locator('#word-input')).toBeFocused();
    await expect(page.locator('#word-dialog-title')).toHaveText('Новое слово');
  } finally { await app.close(); }
});

test('smart formatting downloads through the engine and becomes selectable', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `formatter-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const env = {...process.env, SHOPOT_DATA_DIR: dataDir}; delete env.ELECTRON_RUN_AS_NODE;
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    expect(await page.locator('#formatting-select option[value="llm"]').isDisabled()).toBe(true);
    await page.locator('[data-page="models"]').click();
    await page.locator('[data-formatter]').click();
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.map(r => r.command))).toEqual(['download-formatter']);
    await app.evaluate(() => globalThis.__test.resolve({...globalThis.__test.status,
      formatter: {...globalThis.__test.status.formatter, installed: true}}));
    await expect(page.locator('[data-formatter]')).toHaveText('Используется');
    expect((await page.evaluate(() => window.shopot.boot())).settings.formatting).toBe('llm');
    expect(await page.locator('#formatting-select option[value="llm"]').isDisabled()).toBe(false);
    await expect(page.locator('#formatting-select')).toHaveValue('llm');
  } finally { await app.close(); }
});
