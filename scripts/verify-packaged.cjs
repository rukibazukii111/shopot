const { _electron: electron } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
const sample = process.argv[2];
if (!sample) throw new Error('Usage: node scripts/verify-packaged.cjs <local audio sample>');
const dataDir = path.join(root, '.private', 'packaged-test', String(Date.now()));
fs.mkdirSync(dataDir, {recursive: true});
fs.symlinkSync(path.join(root, '.local', 'models'), path.join(dataDir, 'models'), process.platform === 'win32' ? 'junction' : 'dir');
const env = {...process.env, SHOPOT_DATA_DIR: dataDir, HF_HUB_OFFLINE: '1'};
delete env.ELECTRON_RUN_AS_NODE;
const executablePath = process.env.SHOPOT_EXECUTABLE || (process.platform === 'win32' ? path.join(root, 'release', 'win-unpacked', 'Shopot.exe') : undefined);

(async () => {
  const app = await electron.launch({executablePath, args: [], env});
  const errors = [];
  let originalClipboard = '', resultingText = '';
  try {
    const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => document.querySelector('#engine-label').textContent === 'Локальный движок', {timeout: 30000});
    originalClipboard = await app.evaluate(({clipboard}) => clipboard.readText());
    await app.evaluate(({dialog}, samplePath) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [samplePath]}); }, path.resolve(sample));
    await page.locator('[data-page="settings"]').click();
    await page.locator('#keep-audio').check();
    await page.locator('[data-page="dictation"]').click();
    await page.locator('#import-button').click();
    await page.locator('.transcript-editor').waitFor({timeout: 180000});
    resultingText = await page.locator('.transcript-editor').inputValue();
    assert.ok(resultingText.length > 200, 'Expected a real transcript from the audio sample');
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
    const entry = persisted.history[0];
    assert.ok(entry.words.length > 50);
    assert.ok(entry.duration > 60);
    assert.ok(fs.existsSync(path.join(dataDir, 'audio', entry.audioFile)));
    const audioBytes = await page.evaluate(async id => (await window.shopot.readAudio(id)).byteLength, entry.id);
    assert.ok(audioBytes > 1000);
    assert.equal(await app.evaluate(({clipboard}) => clipboard.readText()), resultingText);
    await page.locator('#import-button').waitFor({state: 'visible'});
    await page.screenshot({path: path.join(root, '.private', 'ui-test', 'packaged.png'), fullPage: true});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({passed: true, executable: executablePath, duration: entry.duration, elapsed: entry.elapsed, words: entry.words.length, audioRetained: true, clipboardMatches: true, dataDir}));
  } finally {
    await app.evaluate(async ({clipboard}, values) => { if (await clipboard.readText() === values.resultingText) await clipboard.writeText(values.originalClipboard); }, {originalClipboard, resultingText}).catch(() => {});
    await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
