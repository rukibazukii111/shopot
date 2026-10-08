const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const {labels, DEFAULT_HOTKEY} = require('../../electron/hotkey.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
// Ctrl+Alt (⌃⌥ on a Mac) with a letter is a valid shortcut on both systems.
const NEW = 'Control+Alt+K', TAKEN = 'Control+Alt+J';
const copyKey = process.platform === 'darwin' ? 'Meta+KeyC' : 'Control+KeyC';
const keysOf = accelerator => labels(accelerator, process.platform);

function dataDir(name) {
  const dir = path.join(root, '.private', 'ui-test', `hotkey-${name}-${Date.now()}`);
  fs.mkdirSync(dir, {recursive: true});
  const store = new Store(dir);
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  return {dir, store};
}
const launch = (dir, busy = '') => electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
  env: {...env, SHOPOT_DATA_DIR: dir, SHOPOT_TEST_BUSY_SHORTCUTS: busy}});
const registered = app => app.evaluate(() => globalThis.__test.hotkey);
const stored = dir => JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).settings.hotkey;
async function ready(app) {
  const page = await app.firstWindow();
  await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
  return page;
}
async function openSettings(page) { await page.locator('[data-page="settings"]').click(); await expect(page.locator('#hotkey-change')).toBeVisible(); }
const keycaps = locator => locator.locator('kbd').allTextContents();
const journal = dir => fs.existsSync(path.join(dir, 'logs', 'shopot.log')) ? fs.readFileSync(path.join(dir, 'logs', 'shopot.log'), 'utf8') : '';

test('a new shortcut works at once in both modes, frees the old one and survives a restart', async () => {
  const {dir} = dataDir('change');
  let app = await launch(dir);
  try {
    const page = await ready(app);
    expect(await keycaps(page.locator('#hero-keys'))).toEqual(keysOf(DEFAULT_HOTKEY));
    await openSettings(page);
    await expect(page.locator('#hotkey-reset')).toBeDisabled();
    await page.locator('#hotkey-change').click();
    await expect(page.locator('#hotkey-field')).toContainText('Нажми новое сочетание');
    await expect(page.locator('#hotkey-description')).toHaveText('Esc — отмена');
    // While Settings waits, the old shortcut is off and cannot start a recording.
    await expect.poll(() => registered(app)).toBe(null);
    await page.keyboard.press('Control+Alt+KeyK');
    await expect(page.locator('#toast')).toContainText('Сочетание изменено');
    await expect.poll(() => registered(app)).toBe(NEW);
    expect(stored(dir)).toBe(NEW);
    await expect.poll(() => journal(dir)).toMatch(/ hotkey-change result=ok reset=false$/m);
    expect(await keycaps(page.locator('#hotkey-keys'))).toEqual(keysOf(NEW));
    expect(await keycaps(page.locator('#hero-keys'))).toEqual(keysOf(NEW));
    await expect(page.locator('#hotkey-reset')).toBeEnabled();

    // Push-to-talk with the new keys: the hold check reads the new shortcut, the repeat does not stop it.
    await app.evaluate(() => { globalThis.__test.keysDown = true; globalThis.__test.toggle(); });
    await expect.poll(() => app.windows().some(p => p.url().endsWith('/widget.html'))).toBe(true);
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await expect(widget.locator('#hint')).toContainText('Отпусти клавиши, чтобы закончить');
    expect(await app.evaluate(() => globalThis.__test.holdKeys)).toBe(NEW);
    await app.evaluate(() => globalThis.__test.toggle());
    await page.waitForTimeout(200);
    expect(await app.evaluate(() => globalThis.__test.requests.length)).toBe(0);
    await app.evaluate(() => { globalThis.__test.keysDown = false; });
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    await app.evaluate(() => globalThis.__test.finish());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    // A short press: the widget names the new keys to finish.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(widget.locator('#hint')).toContainText('закончить');
    expect(await keycaps(widget.locator('#hint'))).toEqual([...keysOf(NEW), 'Esc']);
    // A second press once the microphone records ends it (a press while it connects cancels instead).
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(2);
    await app.evaluate(() => globalThis.__test.finish());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    // Other settings do not overwrite the shortcut.
    await openSettings(page);
    await page.locator('#remove-fillers').click({force: true});
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8')).settings.removeFillers).toBe(false);
    expect(stored(dir)).toBe(NEW);
  } finally { await app.close(); }

  app = await launch(dir);
  try {
    const page = await ready(app);
    expect(await registered(app)).toBe(NEW);
    expect(await keycaps(page.locator('#hero-keys'))).toEqual(keysOf(NEW));
  } finally { await app.close(); }
});

test('single keys and shortcuts other programs need are refused while Settings keeps waiting; Esc gives the old one back', async () => {
  const {dir} = dataDir('rules');
  const app = await launch(dir);
  try {
    const page = await ready(app);
    await openSettings(page);
    await page.locator('#hotkey-change').click();
    await page.keyboard.press('KeyK');
    await expect(page.locator('#hotkey-description')).toHaveText(process.platform === 'darwin' ? 'Добавь ⌘, ⌥, ⌃ или Shift' : 'Добавь Ctrl, Alt, Shift или Win');
    await page.keyboard.press(copyKey);
    await expect(page.locator('#hotkey-description')).toHaveText('Это сочетание нужно другим программам. Выбери другое');
    await page.keyboard.press('Shift+KeyA');
    await expect(page.locator('#hotkey-description')).toHaveText('Это сочетание нужно другим программам. Выбери другое');
    await expect(page.locator('#hotkey-field')).toHaveClass(/capturing/);
    expect(await registered(app)).toBe(null);
    await page.keyboard.press('Escape');
    await expect(page.locator('#hotkey-field')).not.toHaveClass(/capturing/);
    await expect.poll(() => registered(app)).toBe(DEFAULT_HOTKEY);
    expect(await keycaps(page.locator('#hotkey-keys'))).toEqual(keysOf(DEFAULT_HOTKEY));
    expect(stored(dir)).toBe(DEFAULT_HOTKEY);
    // Leaving for another tab while waiting gives the old one back too.
    await page.locator('#hotkey-change').click();
    await expect.poll(() => registered(app)).toBe(null);
    await page.locator('[data-page="history"]').click();
    await expect.poll(() => registered(app)).toBe(DEFAULT_HOTKEY);
    // The main window losing focus gives it back as well, in main and on the page.
    await openSettings(page);
    await page.locator('#hotkey-change').click();
    await expect.poll(() => registered(app)).toBe(null);
    await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('index.html')).emit('blur'));
    await expect.poll(() => registered(app)).toBe(DEFAULT_HOTKEY);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await expect(page.locator('#hotkey-field')).not.toHaveClass(/capturing/);
    await expect(page.locator('#hotkey-state')).toContainText('Работает');
    expect(stored(dir)).toBe(DEFAULT_HOTKEY);
  } finally { await app.close(); }
});

test('if another program takes the shortcut while Settings waits, Esc shows it as taken', async () => {
  const {dir} = dataDir('lost');
  const app = await launch(dir);
  try {
    const page = await ready(app);
    await openSettings(page);
    await page.locator('#hotkey-change').click();
    await expect.poll(() => registered(app)).toBe(null);
    await app.evaluate((_, key) => globalThis.__test.busy.add(key), DEFAULT_HOTKEY);
    await page.keyboard.press('Escape');
    await expect(page.locator('#hotkey-field')).not.toHaveClass(/capturing/);
    await expect(page.locator('#hotkey-state')).toContainText('Занято');
    await expect(page.locator('#hotkey-description')).toHaveText('Сочетание занято другой программой. Нажми «Изменить» и выбери другое.');
    await page.locator('[data-page="dictation"]').click();
    await expect(page.locator('#hotkey-fix')).toBeVisible();
    await expect(page.locator('#record-description')).toHaveText('Сочетание занято другой программой. Нажми «Изменить» и выбери другое.');
    expect(stored(dir)).toBe(DEFAULT_HOTKEY);
  } finally { await app.close(); }
});

test('a shortcut another program holds is refused and the old one keeps working; «Сбросить» returns the default', async () => {
  const {dir} = dataDir('taken');
  const app = await launch(dir, TAKEN);
  try {
    const page = await ready(app);
    await openSettings(page);
    await page.locator('#hotkey-change').click();
    await page.keyboard.press('Control+Alt+KeyJ');
    await expect(page.locator('#error-text')).toHaveText('Сочетание занято другой программой или системой. Оставили прежнее');
    await expect(page.locator('#hotkey-field')).not.toHaveClass(/capturing/);
    await expect.poll(() => registered(app)).toBe(DEFAULT_HOTKEY);
    expect(stored(dir)).toBe(DEFAULT_HOTKEY);
    await expect.poll(() => journal(dir)).toMatch(/ hotkey-change result=taken reset=false$/m);
    await page.locator('#dismiss-error').click();
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    // Settings cannot wait for a new shortcut during a recording.
    await expect(page.locator('#hotkey-change')).toBeDisabled();
    await expect(page.evaluate(() => window.shopot.pauseHotkey(true))).rejects.toThrow('Закончи запись, потом меняй сочетание');
    await app.evaluate(() => globalThis.__test.cancel());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');

    await page.locator('#hotkey-change').click();
    await page.keyboard.press('Control+Alt+KeyK');
    await expect.poll(() => registered(app)).toBe(NEW);
    await page.locator('#hotkey-reset').click();
    await expect(page.locator('#toast')).toContainText('Вернули стандартное сочетание');
    await expect.poll(() => registered(app)).toBe(DEFAULT_HOTKEY);
    expect(stored(dir)).toBe(DEFAULT_HOTKEY);
    await expect(page.locator('#hotkey-reset')).toBeDisabled();
  } finally { await app.close(); }
});

test('a saved shortcut taken at start stays saved, says so on Dictation and Settings, and can be changed from there', async () => {
  const {dir, store} = dataDir('startup');
  store.setHotkey(TAKEN);
  const app = await launch(dir, TAKEN);
  const busy = 'Сочетание занято другой программой. Нажми «Изменить» и выбери другое.';
  try {
    const page = await ready(app);
    await expect(page.locator('#record-description')).toHaveText(busy);
    await expect(page.locator('#hotkey-fix')).toBeVisible();
    expect(await registered(app)).toBe(undefined);
    expect(stored(dir)).toBe(TAKEN);
    await page.locator('#hotkey-fix').click();
    await expect(page.locator('#hotkey-field')).toHaveClass(/capturing/);
    await page.keyboard.press('Control+Alt+KeyL');
    await expect.poll(() => registered(app)).toBe('Control+Alt+L');
    await expect(page.locator('#hotkey-state')).toContainText('Работает');
    await page.locator('[data-page="dictation"]').click();
    await expect(page.locator('#hotkey-fix')).toBeHidden();
    await expect(page.locator('#record-description')).not.toHaveText(busy);
  } finally { await app.close(); }
});
