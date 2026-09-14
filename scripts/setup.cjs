const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const windows = process.platform === 'win32';
const venvPython = path.join(root, '.venv', windows ? 'Scripts/python.exe' : 'bin/python');
function run(executable, args) {
  const result = spawnSync(executable, args, {cwd: root, stdio: 'inherit', windowsHide: true});
  if (result.error || result.status !== 0) { console.error(result.error?.message || `Команда завершилась с кодом ${result.status}`); process.exit(1); }
}
if (!fs.existsSync(venvPython)) {
  const candidates = windows ? [['py', ['-3.11']], ['python', []]] : [['python3', []]];
  const candidate = candidates.find(([exe, prefix]) => spawnSync(exe, [...prefix, '-c', 'import sys; assert (3, 11) <= sys.version_info[:2] <= (3, 12)'], {windowsHide: true}).status === 0);
  if (!candidate) { console.error('Нужен Python 3.11 или 3.12 (рекомендуется 3.11). Установи его и повтори npm run setup.'); process.exit(1); }
  run(candidate[0], [...candidate[1], '-m', 'venv', '.venv']);
}
run(venvPython, ['-m', 'pip', 'install', '-r', 'backend/requirements.txt']);
console.log('Готово. Запуск: npm start. Модель можно скачать в приложении.');
