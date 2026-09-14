const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
async function launch(existingDir) {
  const dataDir = existingDir || path.join(root, '.private', 'ui-test', `widget-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: {...env, SHOPOT_DATA_DIR: dataDir}});
  const page = await app.firstWindow();
  await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
  return {app, page, dataDir};
}
const widgetVisible = app => app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/widget.html')).isVisible());
test('waiting for microphone can be canceled and late permission cannot start recording', async () => {
  const {app, page} = await launch();
  try {
    await page.evaluate(() => {
      navigator.mediaDevices.getUserMedia = () => new Promise(resolve => { window.releasePermission = () => { window.lateStream = new MediaStream(); const oscillator = new AudioContext(); window.lateContext = oscillator; const dest = oscillator.createMediaStreamDestination(); window.lateStream = dest.stream; resolve(dest.stream); }; });
    });
    await page.locator('#record-button').click();
    await expect(page.locator('#record-heading')).toHaveText('Готовлюсь слушать');
    await page.waitForFunction(() => Boolean(window.releasePermission));
    await page.locator('#cancel-button').click();
    await expect(page.locator('#record-button')).toBeEnabled();
    await page.evaluate(() => window.releasePermission());
    await expect.poll(() => page.evaluate(() => window.lateStream.getTracks().every(t => t.readyState === 'ended'))).toBe(true);
    expect(await app.evaluate(() => globalThis.__test.requests.length)).toBe(0);
    await page.evaluate(() => window.lateContext.close());
  } finally { await app.close(); }
});

test('global widget keeps main window hidden and cancels transcription cleanly', async () => {
  const {app, page, dataDir} = await launch();
  try {
    await app.evaluate(({BrowserWindow}) => { BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).hide(); globalThis.__test.toggle(); });
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect.poll(() => app.windows().some(p => p.url().endsWith('/widget.html'))).toBe(true);
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await expect(widget.locator('#label')).toHaveText('Слушаю тебя');
    const windows = await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().map(w => ({url: w.webContents.getURL(), visible: w.isVisible(), focused: w.isFocused(), focusable: w.isFocusable()})));
    expect(windows.find(w => w.url.endsWith('/index.html')).visible).toBe(false);
    expect(windows.find(w => w.url.endsWith('/widget.html'))).toMatchObject({visible: true, focused: false, focusable: false});
    await widget.screenshot({path: path.join(root, '.private/ui-test/widget.png')});
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    expect(await widgetVisible(app)).toBe(false);
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'transcribing');
    // A late microphone tick and ASR progress must not reopen the stopped widget.
    await page.evaluate(() => window.shopot.captureUpdate({id: captureId, phase: 'recording', elapsed: 3, level: 1}));
    await app.evaluate(() => globalThis.__test.progress());
    expect(await widgetVisible(app)).toBe(false);
    await app.evaluate(() => globalThis.__test.cancel());
    await expect(widget.locator('#label')).toHaveText('Операция отменена');
    expect(await widgetVisible(app)).toBe(false);
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    await expect.poll(() => fs.readdirSync(path.join(dataDir, 'audio')).length).toBe(0);
    // A late result from the canceled job must not be inserted or persisted.
    await app.evaluate(() => globalThis.__test.finish());
    await expect(page.locator('#latest-result')).toContainText('Здесь появятся твои слова');
    expect((await page.evaluate(() => window.shopot.boot())).pendingRecordings).toEqual([]);
  } finally { await app.close(); }
});

test('stopping hides the widget before encoding, ignores late ticks, and success stays hidden', async () => {
  const {app, page, dataDir} = await launch();
  try {
    await page.evaluate(async () => {
      const boot = await window.shopot.boot(); await window.shopot.settings({...boot.settings, autoCopy: false, autoPaste: false});
      const stop = MediaRecorder.prototype.stop;
      MediaRecorder.prototype.stop = function () { window.finishStop = () => stop.call(this); };
    });
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    expect(await widgetVisible(app)).toBe(false);
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'stopping');
    await page.evaluate(() => window.shopot.captureUpdate({id: captureId, phase: 'recording', elapsed: 3, level: 1}));
    await expect(widget.locator('#widget')).toHaveAttribute('data-phase', 'stopping');
    expect(await widgetVisible(app)).toBe(false);
    await page.evaluate(() => window.finishStop());
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    await app.evaluate(() => { globalThis.__test.progress(); globalThis.__test.finish(); });
    await expect(page.locator('.transcript-editor')).toHaveValue('Видосы для GitHub готовы.');
    expect(await widgetVisible(app)).toBe(false);
    expect(fs.readdirSync(path.join(dataDir, 'audio'))).toEqual([]);
  } finally { await app.close(); }
});

test('recording errors preserve audio across restart and can be retried without auto-paste', async () => {
  let {app, page, dataDir} = await launch();
  try {
    await page.evaluate(async () => { const boot = await window.shopot.boot(); await window.shopot.settings({...boot.settings, autoCopy: false}); });
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await widget.locator('#stop').click();
    expect(await widgetVisible(app)).toBe(false);
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    const request = await app.evaluate(() => globalThis.__test.requests[0]);
    expect(request.payload.audioFile).toMatch(/^[a-f0-9-]+\.webm$/);
    expect(request.payload.path).toBeUndefined();
    await app.evaluate(() => globalThis.__test.fail());
    await expect(page.locator('#error-text')).toHaveText('Тестовая ошибка распознавания');
    await expect(page.locator('#recovery-banner')).toBeVisible();
    await expect.poll(() => widgetVisible(app), {timeout: 5000}).toBe(false);
    expect(fs.readdirSync(path.join(dataDir, 'audio'))).toEqual([request.payload.audioFile]);
    await page.screenshot({path: path.join(root, '.private/ui-test/recovery.png'), fullPage: true});
    await app.close();
    ({app, page} = await launch(dataDir));
    await expect(page.locator('#recovery-banner')).toBeVisible();
    await page.locator('#retry-recording').click();
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    // Canceling a retry keeps the saved recording available for another attempt.
    await page.locator('#cancel-button').click();
    await expect(page.locator('#recovery-banner')).toBeVisible();
    expect(fs.readdirSync(path.join(dataDir, 'audio'))).toEqual([request.payload.audioFile]);
    await page.locator('#retry-recording').click();
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(2);
    await app.evaluate(() => globalThis.__test.finish());
    await expect(page.locator('.transcript-editor')).toHaveValue('Видосы для GitHub готовы.');
    await expect(page.locator('#recovery-banner')).toBeHidden();
    expect((await page.evaluate(() => window.shopot.boot())).pendingRecordings).toEqual([]);
    expect(fs.readdirSync(path.join(dataDir, 'audio'))).toEqual([]);
    expect(await app.evaluate(() => globalThis.__test.nativeCalls.filter(c => c.method === 'paste'))).toEqual([]);
    expect(await widgetVisible(app)).toBe(false);
  } finally { await app.close(); }
});

test('interrupted captures are recovered on startup and explicit deletion removes the audio', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `recovery-${Date.now()}`);
  const audioDir = path.join(dataDir, 'audio'); fs.mkdirSync(audioDir, {recursive: true});
  fs.writeFileSync(path.join(audioDir, 'abc-123.webm'), 'interrupted capture');
  const {app, page} = await launch(dataDir);
  try {
    await expect(page.locator('#recovery-banner')).toBeVisible();
    await app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response: 0}); });
    await page.locator('#delete-recording').click();
    expect(fs.readdirSync(audioDir)).toEqual(['abc-123.webm']);
    await app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response: 1}); });
    await page.locator('#delete-recording').click();
    await expect(page.locator('#recovery-banner')).toBeHidden();
    expect(fs.readdirSync(audioDir)).toEqual([]);
  } finally { await app.close(); }
});

test('renderer failure during recognition preserves the recording for retry', async () => {
  const {app, page, dataDir} = await launch();
  try {
    await page.locator('#record-button').click();
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await page.locator('#record-button').click();
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).webContents.emit('render-process-gone'));
    await expect(page.locator('#recovery-banner')).toBeVisible();
    expect(fs.readdirSync(path.join(dataDir, 'audio'))).toHaveLength(1);
    expect((await page.evaluate(() => window.shopot.boot())).pendingRecordings).toHaveLength(1);
  } finally { await app.close(); }
});

test('Windows: native paste reaches the original external input exactly once without Enter', async () => {
  test.skip(process.platform !== 'win32', 'macOS requires a user-granted Accessibility permission');
  test.skip(process.env.SHOPOT_NATIVE_INPUT_TEST !== '1', 'Opt in on an interactive desktop with SHOPOT_NATIVE_INPUT_TEST=1');
  const {app, page} = await launch();
  let target;
  try {
    await app.evaluate(async ({clipboard, ClipboardItem}) => {
      const saved = [];
      for (const item of await clipboard.read()) {
        const data = {};
        for (const type of item.types) data[type] = await item.getType(type);
        saved.push(new ClipboardItem(data));
      }
      globalThis.__test.clipboardSnapshot = saved;
    });
    target = await electron.launch({args: [path.join(root, 'tests/fixtures/paste-target.cjs')], env});
    const targetPid = await target.evaluate(() => globalThis.__fixturePid);
    await app.evaluate((_, pid) => { globalThis.__test.targetPid = pid; }, targetPid);
    console.log('Native input test target PID:', targetPid);
    const fieldPage = await target.firstWindow();
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/index.html')).hide());
    await target.evaluate(({BrowserWindow}) => { BrowserWindow.getAllWindows()[0].show(); BrowserWindow.getAllWindows()[0].focus(); });
    await fieldPage.locator('textarea').click();
    await expect.poll(() => target.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows()[0].isFocused())).toBe(true);
    // Electron's isFocused may be true on an inactive Windows desktop. Verify with the OS.
    await expect.poll(() => app.evaluate(() => globalThis.__test.foregroundPid()),
      {timeout: 60000, message: 'The test application must own the OS foreground before input is generated'}).toBe(targetPid);
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    await app.evaluate(() => globalThis.__test.finish());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    await expect(fieldPage.locator('textarea')).toHaveValue('Видосы для GitHub готовы.');
    expect(await fieldPage.evaluate(() => window.enters)).toBe(0);
    expect(await app.evaluate(() => globalThis.__test.nativeCalls.filter(c => c.method === 'paste').length)).toBe(1);
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await expect(widget.locator('#label')).toHaveText('Текст вставлен');
    expect(await widgetVisible(app)).toBe(false);
    await expect(page.locator('.transcript-editor')).toHaveValue('Видосы для GitHub готовы.');
  } finally {
    try {
      await app.evaluate(async ({clipboard}) => {
        if (await clipboard.readText() === 'Видосы для GitHub готовы.' && globalThis.__test.clipboardSnapshot) await clipboard.write(globalThis.__test.clipboardSnapshot);
      });
    } finally { if (target) await target.close(); await app.close(); }
  }
});
