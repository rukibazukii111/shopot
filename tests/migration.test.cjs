// Shopot 1.0 opens the data of 0.3.0 without losses (PRD, section 10).
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {Store, DEFAULT_SETTINGS, STORE_VERSION, BACKUP_FILE} = require('../electron/store.cjs');

const FIXTURE = path.join(__dirname, 'fixtures', 'data-0.3.0');
const SECTIONS = ['dictionary', 'snippets', 'profiles', 'history', 'pendingRecordings'];
// Every setting 0.3.0 had. A 1.0 that renames or drops one of them fails these tests.
const ZERO_THREE_SETTINGS = ['model', 'language', 'mode', 'context', 'autoCopy', 'autoPaste', 'keepAudio', 'microphoneId',
  'formatting', 'removeFillers', 'voiceCommands', 'meetingOffers', 'meetingIgnore', 'translate'];

function openFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-migration-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.cpSync(FIXTURE, root, {recursive: true});
  const bytes = fs.readFileSync(path.join(root, 'store.json'));
  return {root, bytes, json: JSON.parse(bytes.toString('utf8'))};
}
function assertKept(data, original) {
  for (const key of SECTIONS) assert.deepEqual(data[key], original[key], key);
  for (const key of ZERO_THREE_SETTINGS) assert.deepEqual(data.settings[key], original.settings[key], key);
}

test('0.3.0 data opens without losing anything', t => {
  const {root, json} = openFixture(t);
  assertKept(new Store(root).data, json);
});
test('settings 0.3.0 did not have get their defaults', t => {
  const {settings} = new Store(openFixture(t).root).data;
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    if (!ZERO_THREE_SETTINGS.includes(key)) assert.deepEqual(settings[key], value, key);
  }
  assert.deepEqual(Object.keys(settings).sort(), Object.keys(DEFAULT_SETTINGS).sort());
});
test('saving and reopening keeps the 0.3.0 data', t => {
  const {root, json} = openFixture(t);
  const store = new Store(root);
  store.setSettings(store.data.settings);
  assertKept(new Store(root).data, json);
});
test('one untouched copy of 0.3.0 data is kept before 1.0 writes', t => {
  const {root, bytes} = openFixture(t);
  const backup = path.join(root, BACKUP_FILE);
  const store = new Store(root);
  store.setSettings({...store.data.settings, mode: 'raw'});
  assert.deepEqual(fs.readFileSync(backup), bytes);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'store.json'), 'utf8')).version, STORE_VERSION);
  const reopened = new Store(root);
  reopened.setDictionary([...reopened.data.dictionary, {word: 'Whisper', aliases: []}]);
  assert.deepEqual(fs.readFileSync(backup), bytes);
});
test('a failed copy does not stop the app and is retried on the next start', t => {
  const {root, bytes} = openFixture(t);
  const backup = path.join(root, BACKUP_FILE);
  const copyFileSync = fs.copyFileSync;
  fs.copyFileSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), {code: 'ENOSPC'}); };
  try {
    const store = new Store(root);
    assert.equal(store.data.version, 1);
    assert.equal(fs.existsSync(backup), false);
  } finally { fs.copyFileSync = copyFileSync; }
  assert.equal(new Store(root).data.version, STORE_VERSION);
  assert.deepEqual(fs.readFileSync(backup), bytes);
});
test('a new installation keeps no copy', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-new-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const store = new Store(root);
  store.save();
  assert.equal(new Store(root).data.version, STORE_VERSION);
  assert.equal(fs.existsSync(path.join(root, BACKUP_FILE)), false);
});
test('the data folder stays where 0.3.0 kept it', () => {
  const {build} = require('../package.json');
  assert.equal(build.appId, 'local.shopot.desktop');
  assert.equal(build.productName, 'Shopot');
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8'), /getPath\('appData'\), 'Shopot'\)/);
});
