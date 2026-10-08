const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('Windows uninstaller asks about the data folder and keeps it by default', () => {
  const include = pkg.build.nsis.include;
  assert.equal(include, 'packaging/installer.nsh');
  const script = fs.readFileSync(path.join(root, include), 'utf8');
  assert.ok(script.startsWith('﻿'), 'NSIS reads the Russian text correctly only with a UTF-8 BOM');
  assert.match(script, /!macro customUnInstall/);
  assert.match(script, /\$\{ifNot\} \$\{isUpdated\}\s+\$\{andIfNot\} \$\{Silent\}/, 'Updates and silent uninstalls must not ask');
  const ask = script.split('\n').find(line => line.includes('MessageBox MB_YESNO'));
  assert.ok(ask.includes('Удалить также модели, историю и настройки?'));
  assert.ok(ask.includes('MB_DEFBUTTON2'), '"No" must be the default button');
  assert.ok(ask.includes('/SD IDNO IDNO'), 'Silent mode and "No" must skip the deletion');
  // The data folder name must match electron/main.cjs.
  assert.match(script, /RMDir \/r "\$APPDATA\\\$\{APP_FILENAME\}"/);
  assert.equal(pkg.build.productName, 'Shopot');
  assert.match(fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8'), /path\.join\(app\.getPath\('appData'\), 'Shopot'\)/);
});
