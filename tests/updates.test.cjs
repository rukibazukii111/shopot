const {test} = require('node:test');
const assert = require('node:assert/strict');
const u = require('../electron/updates.cjs');

// A GitHub release as the API returns it, with this repository's download links.
const release = (tag, {prerelease = tag.includes('-'), draft = false, assets = null, body = '## Что нового\n- **Быстрее** запуск'} = {}) => {
  const version = tag.replace(/^v/, '');
  return {tag_name: tag, prerelease, draft, body, html_url: `https://github.com/${u.REPO}/releases/tag/${tag}`,
    assets: assets ?? [`Shopot-${version}-win-x64.exe`, `Shopot-${version}-mac-arm64.dmg`, 'SHA256SUMS.txt']
      .map(name => ({name, size: 10, browser_download_url: `https://github.com/${u.REPO}/releases/download/${tag}/${name}`}))};
};
const win = {platform: 'win32', arch: 'x64'};

test('versions order betas before their release', () => {
  const v = u.parseVersion;
  assert.ok(u.compareVersions(v('1.0.0-beta.2'), v('1.0.0-beta.1')) > 0);
  assert.ok(u.compareVersions(v('1.0.0'), v('1.0.0-beta.9')) > 0);
  assert.ok(u.compareVersions(v('1.0.1-beta.1'), v('1.0.0')) > 0);
  assert.equal(u.compareVersions(v('v1.2.3'), v('1.2.3')), 0);
  assert.equal(v('1.0'), null); assert.equal(v('1.0.0-rc.1'), null);
});
test('a stable install is offered only stable releases', () => {
  const offer = u.pickRelease([release('v1.1.0-beta.1'), release('v1.0.1'), release('v1.0.0')], {current: '1.0.0', ...win});
  assert.equal(offer.version, '1.0.1'); assert.equal(offer.beta, false);
  assert.equal(offer.installer.name, 'Shopot-1.0.1-win-x64.exe');
  assert.equal(u.pickRelease([release('v1.1.0-beta.1')], {current: '1.0.0', ...win}), null);
});
test('a beta install is offered the newest of betas and stable releases', () => {
  assert.equal(u.pickRelease([release('v1.0.0'), release('v1.0.0-beta.2')], {current: '1.0.0-beta.1', ...win}).version, '1.0.0');
  const beta = u.pickRelease([release('v1.0.0-beta.2')], {current: '1.0.0-beta.1', ...win});
  assert.equal(beta.version, '1.0.0-beta.2'); assert.equal(beta.beta, true);
});
test('drafts, mismatched flags, missing installers and missing sums are not offered', () => {
  const none = releases => assert.equal(u.pickRelease(releases, {current: '1.0.0', ...win}), null);
  none([release('v1.0.1', {draft: true})]);
  none([release('v1.0.1', {prerelease: true})]);
  none([release('v1.0.1', {assets: []})]);
  none([release('v1.0.1', {assets: [{name: 'Shopot-1.0.1-win-x64.exe', browser_download_url: `https://github.com/${u.REPO}/releases/download/v1.0.1/Shopot-1.0.1-win-x64.exe`}]})]);
  // An installer link outside this repository's releases is never followed.
  none([{...release('v1.0.1'), assets: release('v1.0.1').assets.map(a => ({...a, browser_download_url: 'https://evil.example/x.exe'}))}]);
  assert.equal(u.pickRelease([release('v1.0.1')], {current: '1.0.0', platform: 'win32', arch: 'arm64'}), null);
  assert.equal(u.pickRelease('nonsense', {current: '1.0.0', ...win}), null);
  assert.equal(u.pickRelease([null, {tag_name: 5}], {current: '1.0.0', ...win}), null);
});
test('a skipped version is offered only to a manual check', () => {
  assert.equal(u.pickRelease([release('v1.0.1')], {current: '1.0.0', ...win, skipped: '1.0.1'}), null);
  assert.equal(u.pickRelease([release('v1.0.1')], {current: '1.0.0', ...win, skipped: '1.0.1', manual: true}).version, '1.0.1');
});
test('release notes become short plain text', () => {
  assert.equal(u.notesText('## Что нового\r\n- **Быстрее** [запуск](https://x)\n\n\n\n`код`'), 'Что нового\n• Быстрее запуск\n\nкод');
  assert.ok(u.notesText('слово '.repeat(400)).length <= 1202);
  assert.equal(u.notesText(null), '');
});
test('checksum files, urls and errors', () => {
  const sums = u.parseSums(`${'a'.repeat(64)}  Shopot-1.0.1-win-x64.exe\n${'B'.repeat(64)} *SHA256SUMS.txt\nмусор\n`);
  assert.equal(sums.get('Shopot-1.0.1-win-x64.exe'), 'a'.repeat(64));
  assert.equal(sums.get('SHA256SUMS.txt'), 'b'.repeat(64));
  assert.equal(sums.size, 2);
  assert.ok(u.allowedUrl('https://api.github.com/repos/x'));
  assert.ok(u.allowedUrl('https://objects.githubusercontent.com/a'));
  assert.ok(!u.allowedUrl('http://github.com/a')); assert.ok(!u.allowedUrl('https://example.com')); assert.ok(!u.allowedUrl('not a url'));
  assert.equal(u.installerName('1.0.0', 'darwin', 'x64'), 'Shopot-1.0.0-mac-x64.dmg');
  assert.equal(u.installerName('1.0.0', 'linux', 'x64'), null);
  const error = new u.UpdateError('offline');
  assert.equal(error.kind, 'offline'); assert.match(error.message, /интернет/);
});

const {EventEmitter} = require('node:events');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
// GitHub stand-in: a URL maps to JSON, text, bytes, an HTTP status ({status}) or a thrown network error.
function fakeFetch(routes) {
  return async url => {
    const route = routes[url];
    if (route instanceof Error) throw route;
    if (route === undefined) return new Response('', {status: 404});
    if (route?.status) return new Response('', {status: route.status});
    return new Response(typeof route === 'string' || Buffer.isBuffer(route) ? route : JSON.stringify(route));
  };
}
const tempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-update-'));

test('check offers a release, then a verified download becomes ready', async () => {
  const dir = tempDir(), r = release('v1.0.1'), data = Buffer.from('installer');
  const fetch = fakeFetch({[u.RELEASES_URL]: [r], [r.assets[2].browser_download_url]: `${sha(data)}  Shopot-1.0.1-win-x64.exe\n`, [r.assets[0].browser_download_url]: data});
  const updater = new u.Updater({fetch, dir, current: '1.0.0', ...win});
  const states = []; updater.on('state', s => states.push(s.phase));
  try {
    assert.equal((await updater.check()).version, '1.0.1');
    assert.equal(updater.state.phase, 'available');
    assert.equal(updater.state.notes, 'Что нового\n• Быстрее запуск');
    await updater.download();
    assert.equal(updater.state.phase, 'ready');
    assert.equal(fs.readFileSync(updater.readyFile(), 'utf8'), 'installer');
    assert.deepEqual([...new Set(states)], ['available', 'downloading', 'ready']);
    // A later check of the same version keeps the downloaded installer.
    await updater.check(); assert.equal(updater.state.phase, 'ready');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('a wrong checksum deletes the file and offers the version again with an error', async () => {
  const dir = tempDir(), r = release('v1.0.1');
  const fetch = fakeFetch({[u.RELEASES_URL]: [r], [r.assets[2].browser_download_url]: `${'0'.repeat(64)}  Shopot-1.0.1-win-x64.exe\n`, [r.assets[0].browser_download_url]: 'tampered'});
  const updater = new u.Updater({fetch, dir, current: '1.0.0', ...win});
  try {
    await updater.check();
    await assert.rejects(updater.download(), {kind: 'checksum'});
    assert.deepEqual(fs.readdirSync(dir), []);
    assert.equal(updater.state.phase, 'available');
    assert.match(updater.state.error, /не прошёл проверку/);
    assert.equal(updater.readyFile(), null);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('a ready installer that disappeared is offered for download again', async () => {
  const dir = tempDir(), r = release('v1.0.1'), data = Buffer.from('installer');
  const fetch = fakeFetch({[u.RELEASES_URL]: [r], [r.assets[2].browser_download_url]: `${sha(data)}  Shopot-1.0.1-win-x64.exe
`, [r.assets[0].browser_download_url]: data});
  const updater = new u.Updater({fetch, dir, current: '1.0.0', ...win});
  try {
    await updater.check(); await updater.download();
    fs.rmSync(updater.ready.file);
    assert.equal(updater.readyFile(), null);
    assert.equal(updater.state.phase, 'available');
    await updater.download();
    assert.equal(updater.state.phase, 'ready');
    assert.equal(fs.readFileSync(updater.readyFile(), 'utf8'), 'installer');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('a download that stops sending data fails as offline', async () => {
  const dir = tempDir(), r = release('v1.0.1');
  const routes = {[u.RELEASES_URL]: [r], [r.assets[2].browser_download_url]: `${'0'.repeat(64)}  Shopot-1.0.1-win-x64.exe
`};
  const base = fakeFetch(routes);
  // The installer answers, then never sends a byte.
  const fetch = async (url, init) => url === r.assets[0].browser_download_url ? new Response(new ReadableStream({pull: () => new Promise(() => {})})) : base(url, init);
  const updater = new u.Updater({fetch, dir, current: '1.0.0', ...win, idleMs: 50});
  try {
    await updater.check();
    await assert.rejects(updater.download(), {kind: 'offline'});
    assert.equal(updater.state.phase, 'available');
    assert.match(updater.state.error, /интернет/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('a missing sum line, no network and rate limits are update errors', async () => {
  const dir = tempDir(), r = release('v1.0.1');
  try {
    let updater = new u.Updater({fetch: fakeFetch({[u.RELEASES_URL]: [r], [r.assets[2].browser_download_url]: 'нет строк'}), dir, current: '1.0.0', ...win});
    await updater.check(); await assert.rejects(updater.download(), {kind: 'format'});
    updater = new u.Updater({fetch: fakeFetch({[u.RELEASES_URL]: new TypeError('fetch failed')}), dir, current: '1.0.0', ...win});
    await assert.rejects(updater.check(), {kind: 'offline'});
    assert.equal(updater.state.phase, 'none');
    updater = new u.Updater({fetch: fakeFetch({[u.RELEASES_URL]: {status: 403}}), dir, current: '1.0.0', ...win});
    await assert.rejects(updater.check(), {kind: 'rate-limit'});
    updater = new u.Updater({fetch: fakeFetch({[u.RELEASES_URL]: 'не json'}), dir, current: '1.0.0', ...win});
    await assert.rejects(updater.check(), {kind: 'format'});
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('later hides the offer until the next check; nothing newer clears it', async () => {
  const dir = tempDir(), r = release('v1.0.1');
  const routes = {[u.RELEASES_URL]: [r]}, updater = new u.Updater({fetch: fakeFetch(routes), dir, current: '1.0.0', ...win});
  await updater.check(); updater.hide();
  assert.equal(updater.state.hidden, true);
  await updater.check(); assert.equal(updater.state.hidden, false);
  routes[u.RELEASES_URL] = [];
  await updater.check(); assert.equal(updater.state.phase, 'none');
  fs.rmSync(dir, {recursive: true, force: true});
});
test('a manual check during an automatic one still offers a skipped version', async () => {
  const dir = tempDir(), r = release('v1.0.1');
  let resolve; const answer = new Promise(done => { resolve = done; }); let calls = 0;
  const updater = new u.Updater({fetch: async () => { calls++; await answer; return new Response(JSON.stringify([r])); }, dir, current: '1.0.0', ...win});
  try {
    const auto = updater.check({skipped: '1.0.1'}), manual = updater.check({manual: true, skipped: '1.0.1'});
    resolve();
    assert.equal(await auto, null);
    assert.equal((await manual).version, '1.0.1');
    assert.equal(calls, 1);
    assert.equal(updater.state.phase, 'available');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});
test('clean removes leftovers, and installers launch per system', async () => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, 'Shopot-1.0.0-win-x64.exe'), 'old'); fs.writeFileSync(path.join(dir, 'x.part'), 'old');
  new u.Updater({fetch: async () => {}, dir, current: '1.0.0', ...win}).clean();
  assert.deepEqual(fs.readdirSync(dir), []);
  new u.Updater({fetch: async () => {}, dir: path.join(dir, 'missing'), current: '1.0.0', ...win}).clean();
  const spawned = [];
  // Like a real ChildProcess: 'spawn' or 'error' arrives after spawn() returns.
  const child = event => Object.assign(new EventEmitter(), {unref() {}, event});
  const spawn = (file, args, options) => {
    spawned.push({file, args, options}); const c = child();
    setImmediate(() => file.includes('blocked') ? c.emit('error', Object.assign(new Error('spawn EACCES'), {code: 'EACCES'})) : c.emit('spawn'));
    return c;
  };
  assert.equal(await u.launchInstaller('C:/u/setup.exe', 'win32', {spawn}), 'quit');
  assert.deepEqual(spawned[0].args, ['--updated', '/S', '--force-run']);
  assert.equal(spawned[0].options.detached, true);
  // A launch that fails (antivirus, missing file) is an error, not a quit without an update.
  await assert.rejects(u.launchInstaller('C:/u/blocked.exe', 'win32', {spawn}), {kind: 'open', code: 'EACCES'});
  assert.equal(await u.launchInstaller('/u/a.dmg', 'darwin', {openPath: async () => ''}), 'opened');
  await assert.rejects(u.launchInstaller('/u/a.dmg', 'darwin', {openPath: async () => 'нет'}), {kind: 'open'});
  fs.rmSync(dir, {recursive: true, force: true});
});
