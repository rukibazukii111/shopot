const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {REPO, RELEASES_URL} = require('../../electron/updates.cjs');
const {version: current} = require('../../package.json');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

async function launch(existingDir, settings) {
  const dataDir = existingDir || path.join(root, '.private', 'ui-test', `updates-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`);
  fs.mkdirSync(dataDir, {recursive: true});
  if (settings) {
    const file = path.join(dataDir, 'store.json'), data = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({...data, settings: {...data.settings, ...settings}}));
  }
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'], env: {...env, SHOPOT_DATA_DIR: dataDir}});
  // Nothing real may happen: no folder or installer opens, no dialog shows.
  await app.evaluate(({shell, dialog}) => {
    shell.openPath = async target => { globalThis.__opened = target; return ''; };
    dialog.showMessageBox = async (window, options) => { globalThis.__dialog = options; return {response: 0}; };
  });
  const page = await app.firstWindow();
  await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
  return {app, page, dataDir};
}
// A release of this repository, as GitHub's API lists it, with its installer and SHA256SUMS.txt.
function releaseRoutes(tag, {data = Buffer.from(`installer ${tag}`), sum} = {}) {
  const version = tag.replace(/^v/, ''), system = process.platform === 'darwin' ? ['mac', 'dmg'] : ['win', 'exe'];
  const name = `Shopot-${version}-${system[0]}-${process.arch}.${system[1]}`;
  const link = file => `https://github.com/${REPO}/releases/download/${tag}/${file}`;
  const release = {tag_name: tag, prerelease: tag.includes('-'), draft: false, body: '## Что нового\n- Быстрее запуск',
    assets: [name, 'SHA256SUMS.txt'].map(file => ({name: file, size: data.length, browser_download_url: link(file)}))};
  const hash = sum || crypto.createHash('sha256').update(data).digest('hex');
  return {release, routes: {[link('SHA256SUMS.txt')]: `${hash}  ${name}\n`, [link(name)]: data.toString('base64')}, name};
}
// Routes go into main as JSON; installer bytes travel as base64 and the harness gets them back as a Buffer.
async function serve(app, releases, extra = {}) {
  await app.evaluate((_, {list, routes, url}) => {
    globalThis.__test.routes = {[url]: list};
    for (const [key, value] of Object.entries(routes)) globalThis.__test.routes[key] = key.endsWith('.txt') ? value : Buffer.from(value, 'base64');
  }, {list: releases.map(r => r.release), routes: Object.assign({}, ...releases.map(r => r.routes), extra), url: RELEASES_URL});
}
const fetches = app => app.evaluate(() => globalThis.__test.fetches);
const bump = (patch = 1) => current.replace(/^(\d+)\.(\d+)\.(\d+).*$/, (_, a, b, c) => `${a}.${b}.${Number(c) + patch}`);
const nextMinorBeta = () => current.replace(/^(\d+)\.(\d+)\.\d+.*$/, (_, a, b) => `${a}.${Number(b) + 1}.0-beta.1`);

test('with the setting off Shopot makes no request and shows its version', async () => {
  const {app, page} = await launch();
  try {
    await page.locator('[data-page="settings"]').click();
    await expect(page.locator('#check-updates')).not.toBeChecked();
    await expect(page.locator('#app-version')).toHaveText(`Установлена версия ${current}`);
    await page.waitForTimeout(1000);
    expect(await fetches(app)).toEqual([]);
    await expect(page.locator('#update-banner')).toBeHidden();
  } finally { await app.close(); }
});

test('«Проверить сейчас» finds a stable release and never offers a beta', async () => {
  const {app, page} = await launch();
  try {
    await page.locator('[data-page="settings"]').click();
    await serve(app, [releaseRoutes(`v${nextMinorBeta()}`)]);
    await page.locator('#check-now').click();
    await expect(page.locator('#toast')).toContainText('Установлена последняя версия');
    await expect(page.locator('#update-banner')).toBeHidden();
    await serve(app, [releaseRoutes(`v${nextMinorBeta()}`), releaseRoutes(`v${bump()}`)]);
    await page.locator('#check-now').click();
    await expect(page.locator('#toast')).toContainText(`Доступна версия ${bump()}`);
    await expect(page.locator('#update-banner')).toBeVisible();
    await expect(page.locator('#update-title')).toHaveText(`Доступна версия ${bump()}`);
    await expect(page.locator('#update-notes')).toContainText('• Быстрее запуск');
    await expect(page.locator('#update-install')).toHaveText('Скачать и установить');
    expect((await fetches(app)).every(url => url === RELEASES_URL)).toBe(true);
  } finally { await app.close(); }
});

test('an offline manual check shows an error and the journal keeps no address', async () => {
  const {app, page, dataDir} = await launch();
  try {
    await page.locator('[data-page="settings"]').click();
    await page.locator('#check-now').click();
    await expect(page.locator('#error-text')).toHaveText('Не удалось связаться с GitHub. Проверь интернет и попробуй ещё раз.');
    await expect(page.locator('#check-now')).toHaveText('Проверить сейчас');
    await expect(page.locator('#check-now')).toBeEnabled();
    const journal = fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8');
    expect(journal).toMatch(/ update-check trigger=manual result=error elapsed=[\d.]+ kind=offline expected=false at=updates\.cjs:\d+$/m);
    expect(journal).not.toContain('github');
  } finally { await app.close(); }
});

test('turning the setting on checks at once; «Позже» hides until the next check, a skip is remembered', async () => {
  let {app, page, dataDir} = await launch();
  try {
    await serve(app, [releaseRoutes(`v${bump()}`)]);
    await page.locator('[data-page="settings"]').click();
    await page.locator('label[for="check-updates"]').click();
    await expect(page.locator('#check-updates')).toBeChecked();
    await expect(page.locator('#update-title')).toHaveText(`Доступна версия ${bump()}`);
    await page.locator('#update-later').click();
    await expect(page.locator('#update-banner')).toBeHidden();
    await page.locator('#check-now').click();
    await expect(page.locator('#update-banner')).toBeVisible();
    await page.locator('#update-skip').click();
    await expect(page.locator('#update-banner')).toBeHidden();
    expect(JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).updates.skipped).toBe(bump());
    await app.close();

    // The next start checks on its own, and the skipped version stays quiet until a manual check.
    ({app, page} = await launch(dataDir));
    await serve(app, [releaseRoutes(`v${bump()}`)]);
    await page.locator('[data-page="settings"]').click();
    await page.locator('#check-now').click();
    await expect(page.locator('#update-banner')).toBeVisible();
    const journal = fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8');
    expect(journal).toMatch(/ update-check trigger=auto result=(error|none)/);
  } finally { await app.close(); }
});

test('a tampered download is refused; a verified one installs', async () => {
  const {app, page, dataDir} = await launch();
  try {
    await serve(app, [releaseRoutes(`v${bump()}`, {sum: '0'.repeat(64)})]);
    await page.locator('[data-page="settings"]').click();
    await page.locator('#check-now').click();
    await page.locator('#update-install').click();
    await expect(page.locator('#update-detail')).toContainText('не прошёл проверку');
    await expect(page.locator('#update-install')).toHaveText('Скачать и установить');
    await expect(page.locator('#error-banner')).toBeHidden();
    expect(fs.readdirSync(path.join(dataDir, 'updates'))).toEqual([]);

    await serve(app, [releaseRoutes(`v${bump()}`)]);
    await page.locator('#update-install').click();
    await expect(page.locator('#update-title')).toHaveText(`Версия ${bump()} готова к установке`);
    const mac = process.platform === 'darwin';
    await expect(page.locator('#update-install')).toHaveText(mac ? 'Открыть установщик' : 'Перезапустить и обновить');
    // The app's own quit is held back for this click, and given back so that the test can close the app.
    await app.evaluate(({app}) => { globalThis.__realQuit = app.quit; app.quit = () => { globalThis.__quit = true; }; });
    // A double click starts one installer: the second call is ignored while the first is running.
    const answers = await page.evaluate(() => Promise.all([window.shopot.installUpdate(), window.shopot.installUpdate()]));
    await expect.poll(() => app.evaluate(() => globalThis.__quit)).toBe(true);
    await app.evaluate(({app}) => { app.quit = globalThis.__realQuit; });
    expect(answers).toEqual([true, false]);
    if (mac) {
      expect(await app.evaluate(() => globalThis.__opened)).toMatch(/\.dmg$/);
      expect((await app.evaluate(() => globalThis.__dialog)).message).toBe('Установщик открыт');
    } else {
      const spawned = await app.evaluate(() => globalThis.__test.spawned), [run] = spawned;
      expect(spawned).toHaveLength(1);
      expect(run.args).toEqual(['--updated', '/S', '--force-run']);
      expect(path.basename(run.file)).toBe(releaseRoutes(`v${bump()}`).name);
    }
    expect(fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8')).toMatch(new RegExp(` update-install version=${bump().replace(/\./g, '\\.')}$`, 'm'));
  } finally { await app.close(); }
});

test('installing waits for a recording to end', async () => {
  const {app, page} = await launch();
  try {
    await serve(app, [releaseRoutes(`v${bump()}`)]);
    await page.locator('[data-page="settings"]').click();
    await page.locator('#check-now').click();
    await page.locator('#update-install').click();
    await expect(page.locator('#update-title')).toHaveText(`Версия ${bump()} готова к установке`);
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#update-install')).toBeDisabled();
    await expect(page.locator('#update-detail')).toContainText('Кнопка станет доступна после записи, распознавания или загрузки модели.');
    await expect(page.locator('#update-later')).toBeEnabled();
    // Escape cancels the dictation; the button comes back.
    await app.evaluate(() => globalThis.__test.cancel());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    await expect(page.locator('#update-install')).toBeEnabled();
  } finally { await app.close(); }
});
