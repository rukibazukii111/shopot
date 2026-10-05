const {test} = require('node:test');
const assert = require('node:assert/strict');
const {ISSUES, systemName, issueBody, issueUrl} = require('../electron/report.cjs');
const pkg = require('../package.json');

test('the system is named the way people know it', () => {
  assert.equal(systemName('win32', '10.0.26200'), 'Windows 11 (10.0.26200)');
  assert.equal(systemName('win32', '10.0.22000'), 'Windows 11 (10.0.22000)');
  assert.equal(systemName('win32', '10.0.19045'), 'Windows 10 (10.0.19045)');
  assert.equal(systemName('win32', 'unknown'), 'Windows (unknown)');
  assert.equal(systemName('darwin', '14.5.0'), 'macOS 14.5.0');
  assert.equal(systemName('linux', '6.8.0'), 'linux 6.8.0');
});

test('a report opens a new issue with a short form and the versions, nothing else', () => {
  const versions = {version: '0.3.0', system: 'Windows 11 (10.0.26200)', arch: 'x64'};
  const body = issueBody(versions);
  assert.equal(body, [
    '**Что делал:**', '', '',
    '**Что ожидал:**', '', '',
    '**Что случилось:**', '', '',
    '_Журнал можно приложить: перетащи файл сюда._', '',
    'Шёпот 0.3.0 · Windows 11 (10.0.26200) · x64',
  ].join('\n'));
  const link = issueUrl(versions), url = new URL(link);
  assert.equal(url.origin + url.pathname, ISSUES);
  assert.deepEqual([...url.searchParams.keys()], ['body']);
  assert.equal(url.searchParams.get('body'), body);
  // Older Windows URL APIs stop at 2083 characters (INTERNET_MAX_URL_LENGTH); the link stays well below.
  assert.ok(link.length < 2000, `${link.length} characters`);
});

test('the issue address is the repository from package.json', () => {
  assert.equal(ISSUES, `${pkg.repository.url.replace(/\.git$/, '')}/issues/new`);
  assert.equal(ISSUES, 'https://github.com/rukibazukii111/shopot/issues/new');
});
