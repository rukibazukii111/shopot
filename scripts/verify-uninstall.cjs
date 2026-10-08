// Installs the built Windows installer silently, then checks that updating and
// uninstalling keep the data folder, and that --delete-app-data removes it.
// It uses the real %APPDATA%\Shopot, so it runs only on CI (GitHub sets CI=true).
const {spawnSync} = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const output = path.resolve(process.argv[2] || path.join(root, 'release'));

if (process.platform !== 'win32') { console.log('verify-uninstall: Windows only, skipped'); process.exit(0); }
if (process.env.CI !== 'true') {
  console.error('verify-uninstall uses the real %APPDATA%\\Shopot and runs only on CI (CI=true).');
  process.exit(1);
}

const installer = fs.readdirSync(output).filter(name => /^Shopot-.+-win-x64\.exe$/.test(name)).map(name => path.join(output, name))[0];
assert.ok(installer, `No Shopot-*-win-x64.exe in ${output}`);
const installDir = path.join(os.tmpdir(), 'shopot-uninstall-test');
const app = path.join(installDir, 'Shopot.exe');
const uninstaller = path.join(installDir, 'Uninstall Shopot.exe');
const dataDir = path.join(process.env.APPDATA, 'Shopot');
const marker = path.join(dataDir, 'models', 'marker.txt');
assert.ok(!fs.existsSync(dataDir), `${dataDir} already exists; refusing to touch it`);

// NSIS takes /D= unquoted and last, and _?= last; Node must not quote them.
function run(file, args) {
  const result = spawnSync(file, args, {windowsVerbatimArguments: true, windowsHide: true, timeout: 180000});
  assert.equal(result.status, 0, `${path.basename(file)} ${args.join(' ')} -> ${result.status} ${result.error?.message || ''}`);
}
const install = () => run(installer, ['/S', '/currentuser', `/D=${installDir}`]);
// _?= runs the uninstaller in place, so the call waits for it to finish.
const uninstall = (...args) => run(uninstaller, ['/S', ...args, `_?=${installDir}`]);

try {
  install();
  assert.ok(fs.existsSync(app), 'Shopot.exe is not installed');
  fs.mkdirSync(path.dirname(marker), {recursive: true});
  fs.writeFileSync(marker, 'model');

  install();
  assert.ok(fs.existsSync(app), 'Shopot.exe is missing after reinstall');
  assert.ok(fs.existsSync(marker), 'Reinstall removed the data folder');

  uninstall();
  assert.ok(!fs.existsSync(app), 'Uninstall left Shopot.exe');
  assert.ok(fs.existsSync(marker), 'Silent uninstall removed the data folder');

  install();
  uninstall('--delete-app-data');
  assert.ok(!fs.existsSync(app), 'Uninstall left Shopot.exe');
  assert.ok(!fs.existsSync(dataDir), '--delete-app-data kept the data folder');

  console.log(JSON.stringify({reinstallKeepsData: true, uninstallKeepsData: true, deleteAppDataRemovesData: true}));
} finally {
  fs.rmSync(installDir, {recursive: true, force: true});
  fs.rmSync(dataDir, {recursive: true, force: true});
}
