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
