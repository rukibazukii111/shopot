const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const {ISSUES, systemName, issueUrl} = require('../../electron/report.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('the System group opens the journal folder, saves the journal as one file and opens a problem report', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `system-${Date.now()}`);
  const logs = path.join(dataDir, 'logs'), out = path.join(dataDir, 'exports');
  fs.mkdirSync(logs, {recursive: true}); fs.mkdirSync(out);
  // Parts left by earlier runs, oldest first; this run's app-start goes to the end of shopot.log.
  fs.writeFileSync(path.join(logs, 'shopot.2.log'), '2026-10-01T10:00:00.000+03:00 quit uptime=1\n');
  fs.writeFileSync(path.join(logs, 'shopot.1.log'), '2026-10-02T10:00:00.000+03:00 quit uptime=2\n');
  fs.writeFileSync(path.join(logs, 'shopot.log'), '2026-10-03T10:00:00.000+03:00 quit uptime=3\n');
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: dataDir}});
  // Nothing real may open: no folder window, no browser, no change to the user's clipboard.
  await app.evaluate(({shell, clipboard}) => {
    shell.openPath = async target => { globalThis.__opened = target; return ''; };
    shell.openExternal = async url => { globalThis.__external = url; };
    clipboard.writeText = text => { globalThis.__copied = text; };
  });
  const saveAs = file => app.evaluate(({dialog}, target) => {
    dialog.showSaveDialog = async (window, options) => { globalThis.__saveOptions = options; return target ? {canceled: false, filePath: target} : {canceled: true}; };
  }, file);
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await page.locator('[data-page="settings"]').click();
    await expect(page.locator('section[aria-label="Система"]')).toBeVisible();

    await page.locator('#journal-open').click();
    await expect.poll(() => app.evaluate(() => globalThis.__opened)).toBe(logs);

    const saved = path.join(out, 'journal.txt');
    await saveAs(saved);
    await page.locator('#journal-save').click();
    await expect(page.locator('#toast')).toContainText('Журнал сохранён');
    const lines = fs.readFileSync(saved, 'utf8').trim().split('\n');
    expect(lines.slice(0, 3).map(line => line.split(' ').at(-1))).toEqual(['uptime=1', 'uptime=2', 'uptime=3']);
    expect(lines.slice(3).some(line => line.includes(' app-start '))).toBe(true);
    const options = await app.evaluate(() => globalThis.__saveOptions);
    expect(path.basename(options.defaultPath)).toMatch(/^Шёпот-журнал-\d{4}-\d\d-\d\d\.txt$/);
    expect(options.filters.map(f => f.extensions[0])).toEqual(['txt']);
    await saveAs(null);
    expect(await page.evaluate(() => window.shopot.saveJournal())).toBe(false);
    // A folder that cannot take the file gives a plain message, not a system error.
    await saveAs(path.join(dataDir, 'нет-такой-папки', 'journal.txt'));
    await page.locator('#journal-save').click();
    await expect(page.locator('#error-text')).toHaveText('Не удалось сохранить журнал. Выбери другую папку');
    await page.locator('#dismiss-error').click();
    // The journal learns why the save failed and at which call, never where: the folder the user picked stays out.
    const journal = fs.readFileSync(path.join(logs, 'shopot.log'), 'utf8');
    const write = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8').split('\n').findIndex(line => line.includes('fs.writeFileSync(result.filePath, text')) + 1;
    expect(journal).toMatch(new RegExp(` ipc-error channel=journal-save kind=Error code=ENOENT expected=false at=main\\.cjs:${write}$`, 'm'));
    expect(journal).not.toContain('нет-такой-папки');

    await page.locator('#report-problem').click();
    await expect(page.locator('#toast')).toContainText('Открыл страницу в браузере');
    const [platform, systemVersion, arch] = await app.evaluate(() => [process.platform, process.getSystemVersion(), process.arch]);
    const link = issueUrl({version: require('../../package.json').version, system: systemName(platform, systemVersion), arch});
    expect(link.startsWith(`${ISSUES}?body=`)).toBe(true);
    expect(await app.evaluate(() => globalThis.__external)).toBe(link);

    await app.evaluate(({shell}) => { shell.openExternal = async () => { throw new Error('no browser'); }; });
    await page.locator('#report-problem').click();
    await expect(page.locator('#toast')).toContainText('Не удалось открыть браузер. Ссылка скопирована');
    expect(await app.evaluate(() => globalThis.__copied)).toBe(link);
  } finally { await app.close(); }
});

test('a locked interrupted journal stays silent, allows dictation and exports only after full recovery', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `system-recovery-${Date.now()}`);
  const logs = path.join(dataDir, 'logs'), out = path.join(dataDir, 'exports');
  fs.mkdirSync(logs, {recursive: true}); fs.mkdirSync(out);
  for (const [name, uptime] of [['shopot.2.log', 1], ['shopot.1.log', 2], ['shopot.log.rotating', 3], ['shopot.log', 4]]) {
    fs.writeFileSync(path.join(logs, name), `2026-10-05T12:00:00.000+00:00 quit uptime=${uptime}\n`);
  }
  const store = new Store(dataDir);
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir, SHOPOT_TEST_JOURNAL_LOCK: '1'}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await expect(page.locator('#error-banner')).toBeHidden();
    // Recording and its saved result still work while the journal cannot recover.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    await app.evaluate(() => globalThis.__test.finish());
    await expect.poll(() => page.evaluate(() => window.shopot.boot().then(s => s.busy))).toBe(false);
    const history = (await page.evaluate(() => window.shopot.boot())).history;
    expect(history).toHaveLength(1);
    expect(history[0].text).toBe('Видосы для GitHub готовы.');
    await expect(page.locator('#error-banner')).toBeHidden();
    await page.locator('[data-page="settings"]').click();
    const saved = path.join(out, 'journal.txt'), existing = path.join(out, 'existing.txt');
    fs.writeFileSync(existing, 'keep this file');
    for (const file of [saved, existing]) {
      await app.evaluate(({dialog}, target) => { dialog.showSaveDialog = async () => ({canceled: false, filePath: target}); }, file);
      await page.locator('#journal-save').click();
      await expect(page.locator('#error-text')).toHaveText('Не удалось сохранить полный журнал. Попробуйте позже');
      expect(fs.existsSync(saved)).toBe(false);
      expect(fs.readFileSync(existing, 'utf8')).toBe('keep this file');
      await page.locator('#dismiss-error').click();
    }
    expect(fs.readFileSync(path.join(logs, 'shopot.log.rotating'), 'utf8')).toContain('uptime=3');
    await app.evaluate(({dialog}, target) => {
      globalThis.__test.unlockJournal();
      dialog.showSaveDialog = async () => ({canceled: false, filePath: target});
    }, saved);
    await page.locator('#journal-save').click();
    await expect(page.locator('#toast')).toContainText('Журнал сохранён');
    expect([...fs.readFileSync(saved, 'utf8').matchAll(/ quit uptime=(\d+)\n/g)].map(match => Number(match[1]))).toEqual([2, 3, 4]);
    expect(fs.readdirSync(logs).sort()).toEqual(['shopot.1.log', 'shopot.2.log', 'shopot.log']);
  } finally { await app.close(); }
});
