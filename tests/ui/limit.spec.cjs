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
    env: {...env, SHOPOT_DATA_DIR: dataDir, SHOPOT_TEST_NO_ERROR_BOX: '1'}});
  const page = await app.firstWindow();
  await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
  // The hotkey is pressed, not held, unless a test says so, and the paste goes to a pretend desktop:
  // the real keyboard, clipboard and windows are not touched.
  await app.evaluate(() => { globalThis.__test.keysDown = false; globalThis.__test.fakeDesktop = {pastes: 0}; });
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
const journal = dataDir => fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8');
const pastes = app => app.evaluate(() => globalThis.__test.fakeDesktop.pastes);
const TEXT = 'Видосы для GitHub готовы.';

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

test('at the limit the recording stops by itself and the widget stays until the text is pasted', async () => {
  const {app, page, dataDir} = await launch('limit-stop');
  try {
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    // A second of real recording: a recorder stopped at once has no audio yet.
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    const widget = await widgetPage(app);
    // Straight past the last minute, as after a laptop's sleep: the warning and the stop come in one tick.
    await page.clock.fastForward('15:01');
    await expect.poll(() => requests(app)).toBe(1);
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'transcribing');
    await expect(widget.locator('#label')).toHaveText('Распознаю на устройстве');
    await expect(widget.locator('#cancel')).toHaveAttribute('title', 'Скрыть, распознавание продолжится');
    expect(await widgetVisible(app)).toBe(true);
    // Escape belongs to the user again, as after any stop.
    expect(await app.evaluate(() => globalThis.__test.escape)).toBe(false);
    // The user did not notice the stop and presses the hotkey to finish: nothing starts, nothing is canceled.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'transcribing');
    expect(await commands(app)).toEqual(['preload', 'preload']);
    // The bar shows how far the recognition got.
    await app.evaluate(() => globalThis.__test.progress());
    await expect(widget.locator('#progress')).toHaveClass(/\bdeterminate\b/);
    expect(await widget.locator('#progress i').evaluate(bar => bar.style.width)).toBe('50%');
    await widget.screenshot({path: path.join(root, '.private/ui-test/widget-limit.png')});
    await app.evaluate(() => globalThis.__test.finish());
    await expect.poll(() => pastes(app)).toBe(1);
    await expect.poll(() => widgetVisible(app)).toBe(false);
    expect(await app.evaluate(() => globalThis.__test.fakeDesktop.clipboard)).toBe(TEXT);
    await expect(page.locator('.transcript-editor')).toHaveValue(TEXT);
    expect(await requests(app)).toBe(1);
    await expect.poll(() => journal(dataDir)).toMatch(/ dictation result=ok trigger=hotkey .*record=900 limit=true .*paste=pasted/);
    // The next dictation is an ordinary one: no warning left over, and a stop hides the widget at once.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(widget.locator('#label')).toHaveText('Слушаю тебя');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    expect(await widgetVisible(app)).toBe(false);
    await expect.poll(() => requests(app)).toBe(2);
    await app.evaluate(() => globalThis.__test.finish());
    await expect.poll(() => journal(dataDir).match(/ dictation result=ok /g)?.length).toBe(2);
    expect(journal(dataDir).match(/limit=true/g)).toHaveLength(1);
  } finally { await app.close(); }
});

test('the cross only hides a widget stopped at the limit, and a failure after that still shows', async () => {
  const {app, page} = await launch('limit-hide');
  try {
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    const widget = await widgetPage(app);
    await page.clock.fastForward('15:01');
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'transcribing');
    await widget.locator('#cancel').click();
    await expect.poll(() => widgetVisible(app)).toBe(false);
    // Progress does not bring it back; the recognition goes on and the text is pasted.
    await app.evaluate(() => globalThis.__test.progress());
    expect(await widgetVisible(app)).toBe(false);
    await app.evaluate(() => globalThis.__test.finish());
    await expect.poll(() => pastes(app)).toBe(1);
    expect(await widgetVisible(app)).toBe(false);
    // A cancel sent in the very second of the stop, while the widget still showed the recording, only hides too.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await page.clock.fastForward('15:01');
    await expect.poll(() => requests(app)).toBe(2);
    await widget.evaluate(() => window.dictationWidget.action('cancel'));
    await expect.poll(() => widgetVisible(app)).toBe(false);
    // A failure shows even though the widget was hidden; the recording stays for a retry.
    await app.evaluate(() => globalThis.__test.fail());
    await expect(widget.locator('#label')).toHaveText('Не удалось распознать запись');
    expect(await widgetVisible(app)).toBe(true);
    await expect(page.locator('#recovery-banner')).toBeVisible();
    expect(await commands(app)).not.toContain('cancel');
  } finally { await app.close(); }
});

test('push-to-talk held to the limit stops there, and letting go of the keys changes nothing', async () => {
  const {app, page} = await launch('limit-hold');
  try {
    await app.evaluate(() => { globalThis.__test.keysDown = true; globalThis.__test.toggle(); });
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    const widget = await widgetPage(app);
    await expect(widget.locator('#hint')).toContainText('Отпусти клавиши, чтобы закончить');
    await page.clock.fastForward('14:01');
    await expect(widget.locator('#label')).toHaveText('Осталась минута');
    await expect(widget.locator('#hint')).toContainText('Отпусти клавиши, чтобы закончить');
    await page.clock.fastForward('01:00');
    await expect.poll(() => requests(app)).toBe(1);
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'transcribing');
    expect(await widgetVisible(app)).toBe(true);
    await app.evaluate(() => { globalThis.__test.keysDown = false; });
    // The keys are polled every 40 ms.
    await page.waitForTimeout(300);
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'transcribing');
    expect(await widgetVisible(app)).toBe(true);
    expect(await requests(app)).toBe(1);
    await app.evaluate(() => globalThis.__test.finish());
    await expect.poll(() => pastes(app)).toBe(1);
  } finally { await app.close(); }
});
