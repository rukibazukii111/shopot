// The app starts on a data folder left by 0.3.0 and shows everything it had (PRD, section 10).
const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {BACKUP_FILE} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('0.3.0 data: history, unfinished recording, dictionary and settings are all there after the update', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `migration-${Date.now()}`);
  fs.cpSync(path.join(root, 'tests', 'fixtures', 'data-0.3.0'), dataDir, {recursive: true});
  const errors = [];
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: dataDir}});
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await expect(page.locator('#recovery-banner')).toBeVisible();
    await expect(page.locator('#recovery-title')).toHaveText('Запись сохранена, можно повторить распознавание');
    await expect(page.locator('input[name="mode"][value="minimal"]')).toBeChecked();
    await expect(page.locator('#history-count')).toHaveText('4');
    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-list .history-row')).toHaveCount(4);
    await expect(page.locator('#history-list')).toContainText('Старая запись версии 0.2.');
    await page.screenshot({path: path.join(dataDir, 'history.png')});
    await page.locator('[data-page="dictionary"]').click();
    await expect(page.locator('.dictionary-word').filter({hasText: 'LocalSend'})).toBeVisible();
    await expect(page.locator('.dictionary-word').filter({hasText: 'Qwen'})).toBeVisible();
    await page.locator('[data-page="settings"]').click();
    await expect(page.locator('.profile-row[data-profile="telegram.exe"]')).toContainText('Telegram');
    // Startup recovery keeps the unfinished recording and the audio kept in history.
    const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
    expect(stored.pendingRecordings.map(e => e.audioFile)).toEqual(['3f2b8c1e-0a4d-4e6f-9b7a-2c5d8e1f0002.webm']);
    for (const name of ['3f2b8c1e-0a4d-4e6f-9b7a-2c5d8e1f0001.webm', '3f2b8c1e-0a4d-4e6f-9b7a-2c5d8e1f0002.webm'])
      expect(fs.existsSync(path.join(dataDir, 'audio', name))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, BACKUP_FILE)))
      .toEqual(fs.readFileSync(path.join(root, 'tests', 'fixtures', 'data-0.3.0', 'store.json')));
    expect(errors).toEqual([]);
  } finally { await app.close(); }
});
