const {_electron: electron} = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sample = path.resolve(process.argv[2]);
const dataDir = path.join(root, '.private', 'mic-test', String(Date.now()));
fs.mkdirSync(dataDir, {recursive: true});
fs.symlinkSync(path.join(root, '.local', 'models'), path.join(dataDir, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
const env = {...process.env, SHOPOT_DATA_DIR: dataDir, HF_HUB_OFFLINE: '1'};
delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const app = await electron.launch({args: [root, '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${sample}`], env});
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#engine-label').textContent === 'Локальный движок');
    await page.evaluate(async () => { const boot = await window.shopot.boot(); await window.shopot.settings({...boot.settings, autoCopy: false}); });
    await page.locator('#record-button').click();
    await page.waitForFunction(() => document.querySelector('#record-label').textContent === 'Закончить запись');
    await page.waitForFunction(() => document.querySelector('#record-time').textContent >= '00:07');
    await page.locator('#record-button').click();
    await page.locator('.transcript-editor').waitFor({timeout: 90000});
    const data = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
    assert.ok(data.history[0].text.length > 10);
    assert.equal(data.history[0].source, 'Микрофон');
    assert.equal(data.history[0].audioFile, null);
    assert.deepEqual(fs.readdirSync(path.join(dataDir, 'audio')), []);
    console.log(JSON.stringify({passed: true, source: 'Chromium test microphone fed with local WAV', capturedSeconds: data.history[0].duration, elapsed: data.history[0].elapsed, text: data.history[0].text, audioDeleted: true}));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
