// Isolated UI harness: production IPC/controller, fake ASR, actual OS input backend.
const {globalShortcut} = require('electron');
// Tests pick the machine size: warnings for heavy models depend on it.
if (process.env.SHOPOT_TEST_TOTAL_MEMORY) require('node:os').totalmem = () => Number(process.env.SHOPOT_TEST_TOTAL_MEMORY);
const {Worker} = require('../../electron/worker.cjs');
const status = {formatter: {name: 'Qwen3-4B', size: '2,4 ГБ', supported: true, installed: false}, models: [{id: 'gigaam', installed: true, languages: ['ru']}, {id: 'turbo', installed: true, languages: ['ru', 'en', 'auto']}, {id: 'small', installed: true, languages: ['ru', 'en', 'auto'], translates: true}], device: 'cpu', computeType: 'int8'};
globalThis.__test = {requests: [], notifications: [], nativeCalls: []};
globalThis.__test.status = status;
const nativeModule = require('../../electron/native-input.cjs');
const createNative = nativeModule.createNativeBackend;
nativeModule.createNativeBackend = () => {
  const native = createNative();
  globalThis.__test.foregroundPid = () => { const target = native.capture(); native.release(target); return target?.pid; };
  // Tests hold or release the hotkey through __test.keysDown; otherwise the real key state is read.
  // Apps using the microphone come from the test, never from the machine running it.
  native.micUsers = () => globalThis.__test.micUsers || [];
  const hotkeyDown = native.hotkeyDown;
  native.hotkeyDown = () => globalThis.__test.keysDown !== undefined ? Boolean(globalThis.__test.keysDown) : hotkeyDown();
  for (const method of ['capture', 'sameTarget', 'paste']) {
    const original = native[method];
    native[method] = (...args) => {
      // Tests can pretend another app had focus; such a target never receives real input.
      if (method === 'capture' && globalThis.__test.fakeTarget) return globalThis.__test.fakeTarget;
      if (method === 'paste' && native.capture()?.pid !== globalThis.__test.targetPid) return false;
      const result = original(...args); globalThis.__test.nativeCalls.push({method, args, result}); return result;
    };
  }
  return native;
};
globalShortcut.register = (key, callback) => {
  if (key === 'CommandOrControl+Shift+Space') globalThis.__test.toggle = callback;
  if (key === 'Escape') { globalThis.__test.cancel = callback; globalThis.__test.escape = true; }
  return true;
};
globalShortcut.unregister = key => { if (key === 'Escape') globalThis.__test.escape = false; };
Worker.prototype.start = function () { this.status = status; setImmediate(() => this.emit('ready', status)); };
Worker.prototype.request = function (command, payload) {
  globalThis.__test.requests.push({command, payload});
  return new Promise((resolve, reject) => {
    globalThis.__test.resolve = value => resolve(value);
    globalThis.__test.finish = () => resolve({text: 'Видосы для GitHub готовы.', rawText: 'Видосы для GitHub готовы.', duration: 2, elapsed: .1, model: 'turbo', words: []});
    globalThis.__test.fail = () => reject(new Error('Тестовая ошибка распознавания'));
    globalThis.__test.progress = () => this.emit('progress', {stage: 'transcribe', fraction: .5, message: 'Тестовый прогресс'});
    this.testReject = reject;
  });
};
Worker.prototype.notify = function (command, payload) { globalThis.__test.notifications.push({command, payload}); };
Worker.prototype.cancel = function () { this.notify('cancel'); this.testReject?.(new Error('Операция отменена.')); };
Worker.prototype.stop = function () { this.testReject?.(new Error('Операция отменена.')); this.status = null; };
require('../../electron/main.cjs');
