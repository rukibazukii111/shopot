const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('holding the hotkey records until release; a short press records until the next press', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `hold-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir}});
  const requests = () => app.evaluate(() => globalThis.__test.requests.length);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    // Push-to-talk: the keys stay down while the user speaks.
    await app.evaluate(() => { globalThis.__test.keysDown = true; globalThis.__test.toggle(); });
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect.poll(() => app.windows().some(p => p.url().endsWith('/widget.html'))).toBe(true);
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await expect(widget.locator('#hint')).toContainText('Отпусти клавиши, чтобы закончить');
    // The held key repeating is not a second press.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    expect(await requests()).toBe(0);
    await app.evaluate(() => { globalThis.__test.keysDown = false; });
    await expect.poll(requests).toBe(1);
    await app.evaluate(() => globalThis.__test.finish());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    // A short press: the keys are already up, so the recording goes on until the next press.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(widget.locator('#hint')).toContainText('закончить');
    await expect(widget.locator('#hint')).not.toContainText('Отпусти');
    await page.waitForTimeout(800);
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    expect(await requests()).toBe(1);
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(requests).toBe(2);
    await app.evaluate(() => globalThis.__test.finish());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
  } finally { await app.close(); }
});
