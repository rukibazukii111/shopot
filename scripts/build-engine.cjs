const {spawnSync} = require('node:child_process');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const python = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const result = spawnSync(python, ['-m', 'PyInstaller', '--noconfirm', '--clean', '--onedir', '--name', 'shopot-engine',
  '--collect-all', 'faster_whisper', '--collect-all', 'ctranslate2', '--collect-all', 'onnxruntime',
  '--collect-all', 'tokenizers', '--collect-all', 'onnx_asr', '--collect-all', 'av', '--collect-all', 'huggingface_hub',
  '--hidden-import', 'text_processing', '--hidden-import', 'llm', '--hidden-import', 'memory', '--paths', 'backend', 'backend/engine.py'],
  {cwd: root, stdio: 'inherit', windowsHide: true, env: {...process.env, HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1', HF_HUB_OFFLINE: '1'}});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
