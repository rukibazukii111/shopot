const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

// The dictation limit (PRD 6.2) under the test's clock: fastForward takes a recording to its last minute,
// or past its end, at once.
async function launch(name) {
  const dataDir = path.join(root, '.private', 'ui-test', `${name}-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir}});
  const page = await app.firstWindow();
  await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
  // The hotkey is pressed, not held, unless a test says so: the real keyboard is not read.
  await app.evaluate(() => { globalThis.__test.keysDown = false; });
  // The clock is installed in the pages Playwright already knows: the widget's must be one of them.
  await widgetPage(app);
  await page.clock.install();
  return {app, page, dataDir};
}
async function widgetPage(app) {
  await expect.poll(() => app.windows().some(p => p.url().endsWith('/widget.html'))).toBe(true);
  return app.windows().find(p => p.url().endsWith('/widget.html'));
}
const widgetVisible = app => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/widget.html')).isVisible());
const requests = app => app.evaluate(() => globalThis.__test.requests.length);
const commands = app => app.evaluate(() => globalThis.__test.notifications.map(n => n.command));

test('a minute before the limit the widget and the window say so, and the model is loaded again', async () => {
  const {app, page} = await launch('limit-warning');
  try {
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    const widget = await widgetPage(app);
    await expect(widget.locator('#label')).toHaveText('Слушаю тебя');
    await page.clock.fastForward('13:58');
    await expect(widget.locator('#time')).toHaveText(/^13:5\d$/);
    await expect(widget.locator('#label')).toHaveText('Слушаю тебя');
    expect(await widget.locator('#widget').getAttribute('data-warning')).toBeNull();
    await page.clock.fastForward('00:03');
    await expect(widget.locator('#label')).toHaveText('Осталась минута');
    await expect(widget.locator('#widget')).toHaveAttribute('data-warning', '');
    await expect(page.locator('#record-status')).toHaveText('Осталась минута');
    await expect(page.locator('#record-status')).toHaveClass(/\bwarn\b/);
    // So long a recording may outlast the idle unload: the model is loaded again for the stop.
    await expect.poll(() => commands(app)).toEqual(['preload', 'preload']);
    await widget.screenshot({path: path.join(root, '.private/ui-test/widget-last-minute.png')});
    // A stop by the user in the last minute is an ordinary one: the widget hides at once.
    await app.evaluate(() => globalThis.__test.toggle());
    expect(await widgetVisible(app)).toBe(false);
    await expect.poll(() => requests(app)).toBe(1);
  } finally { await app.close(); }
});
