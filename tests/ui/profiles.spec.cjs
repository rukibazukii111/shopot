const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('per-app profile: set up for an app from history, applied when dictating into it', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `profiles-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.addHistory({id: 'earlier', createdAt: '2026-09-26T09:00:00Z', source: 'Микрофон', text: 'Привет.', rawText: 'Привет.', words: [],
    duration: 2, elapsed: .2, model: 'gigaam', mode: 'natural', replacements: [], audioFile: null, app: {id: 'telegram.exe', name: 'Telegram', profile: false}});
  // Nothing may reach the user's clipboard or another window.
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await page.locator('[data-page="settings"]').click();
    await expect(page.locator('#profiles-list')).toContainText('по общим настройкам');
    await page.locator('#profile-app').selectOption('telegram.exe');
    const row = page.locator('.profile-row[data-profile="telegram.exe"]');
    await expect(row).toContainText('Telegram');
    await expect(page.locator('#profile-app')).toBeDisabled();
    await row.locator('[data-profile-field="mode"]').selectOption('minimal');
    await row.locator('[data-profile-field="dropFinalPeriod"]').check();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).profiles).toEqual([
      {app: 'telegram.exe', name: 'Telegram', mode: 'minimal', formatting: null, dropFinalPeriod: true}]);
    // Dictating by hotkey while Telegram has focus uses its profile; the general settings stay as they were.
    await app.evaluate(() => { globalThis.__test.fakeTarget = {hwnd: 1, pid: 1, focus: 0, app: {id: 'telegram.exe', name: 'Telegram'}}; globalThis.__test.toggle(); });
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    const request = await app.evaluate(() => globalThis.__test.requests[0]);
    expect(request.payload).toMatchObject({mode: 'minimal', dropFinalPeriod: true});
    expect((await page.evaluate(() => window.shopot.boot())).settings.mode).toBe('natural');
    await app.evaluate(() => globalThis.__test.finish());
    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-detail .meta-list')).toContainText('Telegram · свои настройки');
    // Removing the profile brings the app back to the list of candidates.
    await page.locator('[data-page="settings"]').click();
    await row.locator('[data-remove-profile]').click();
    await expect(page.locator('.profile-row[data-profile]')).toHaveCount(0);
    await expect(page.locator('#profile-app')).toBeEnabled();
  } finally { await app.close(); }
});
