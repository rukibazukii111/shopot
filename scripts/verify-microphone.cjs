const {_electron: electron} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sample = path.resolve(process.argv[2]);
const dataDir = path.join(root, '.private', 'mic-test', String(Date.now()));
fs.mkdirSync(dataDir, {recursive: true});
const linkType = process.platform === 'win32' ? 'junction' : 'dir';
fs.symlinkSync(path.resolve(process.env.SHOPOT_MODELS_DIR || path.join(root, '.local', 'models')), path.join(dataDir, 'models'), linkType);
if (process.env.SHOPOT_REDIRECT_AUDIO === '1') {
  const redirected = path.join(root, '.private', 'mic-audio', path.basename(dataDir));
  fs.mkdirSync(redirected, {recursive: true});
  fs.symlinkSync(redirected, path.join(dataDir, 'audio'), linkType);
  assert.ok(path.relative(fs.realpathSync(dataDir), fs.realpathSync(path.join(dataDir, 'audio'))).startsWith('..'));
}
const env = {...process.env, SHOPOT_DATA_DIR: dataDir, HF_HUB_OFFLINE: '1'};
delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await electron.launch({executablePath: process.env.SHOPOT_EXECUTABLE,
    args: [...(process.env.SHOPOT_EXECUTABLE ? [] : [root]), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sample}`], env});
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#engine-label').textContent === 'Локальный движок');
    await page.evaluate(async model => { const boot = await window.shopot.boot(); await window.shopot.settings({...boot.settings, model, autoCopy: false}); }, process.env.SHOPOT_MODEL || 'turbo');
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === 'Начать диктовку');
    await page.locator('#record-button').click();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === 'Закончить запись');
    await page.waitForFunction(() => document.querySelector('#record-time').textContent >= '00:07');
    await page.locator('#record-button').click();
    await page.locator('.transcript-editor').waitFor({timeout: 180000});
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
    assert.ok(data.history[0].text.length > 10);
    assert.equal(data.history[0].source, 'Микрофон');
    assert.equal(data.history[0].audioFile, null);
    assert.deepEqual(data.pendingRecordings, []);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'audio')), []);
    console.log(JSON.stringify({passed: true, source: 'Chromium test microphone fed with local WAV', capturedSeconds: data.history[0].duration, elapsed: data.history[0].elapsed, model: data.history[0].model, words: data.history[0].words.length, audioDeleted: true, redirected: process.env.SHOPOT_REDIRECT_AUDIO === '1'}));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
