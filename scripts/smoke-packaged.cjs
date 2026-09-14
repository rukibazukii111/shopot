const {_electron: electron} = require('@playwright/test');
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release'));
const windows = process.platform === 'win32';
const bundle = path.join(output, windows ? 'win-unpacked' : process.arch === 'arm64' ? 'mac-arm64/Shopot.app/Contents' : 'mac/Shopot.app/Contents');
const executablePath = path.join(bundle, windows ? 'Shopot.exe' : 'MacOS/Shopot');
const resources = path.join(bundle, windows ? 'resources' : 'Resources');
const dataDir = path.join(root, '.private', 'packaged-smoke', String(Date.now()));
fs.mkdirSync(dataDir, {recursive: true});
const env = {...process.env, SHOPOT_DATA_DIR: dataDir, HF_HUB_OFFLINE: '1'}; delete env.ELECTRON_RUN_AS_NODE;
(async () => {
  const engine = spawnSync(path.join(resources, 'engine', windows ? 'shopot-engine.exe' : 'shopot-engine'), ['--data-dir', dataDir, '--self-check'], {encoding: 'utf8', windowsHide: true, env, timeout: 90000});
  assert.equal(engine.status, 0, engine.stderr || engine.error?.message);
  assert.equal(JSON.parse(engine.stdout).ok, true);
  const app = await electron.launch({executablePath, env});
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => document.querySelector('#engine-label')?.textContent === 'Локальный движок');
    const boot = await page.evaluate(() => window.shopot.boot());
    assert.equal(boot.nativeAvailable, true, 'Native input backend must load in the packaged app');
    assert.equal(boot.settings.autoPaste, true);
    assert.equal(boot.history.length, 0);
    console.log(JSON.stringify({packagedApp: true, nativeInputLoaded: true, backendAndVAD: true, platform: process.platform, arch: process.arch}));
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
