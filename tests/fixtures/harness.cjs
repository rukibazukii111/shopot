// Isolated UI harness: production IPC/controller, fake ASR, actual OS input backend.
const {globalShortcut} = require('electron');
const {Worker} = require('../../electron/worker.cjs');
const status = {models: [{id: 'turbo', installed: true}], device: 'cpu', computeType: 'int8'};
globalThis.__test = {requests: [], nativeCalls: []};
const nativeModule = require('../../electron/native-input.cjs');
const createNative = nativeModule.createNativeBackend;
nativeModule.createNativeBackend = () => {
  const native = createNative();
  for (const method of ['capture', 'sameTarget', 'paste']) {
    const original = native[method];
    native[method] = (...args) => {
      if (method === 'paste' && native.capture()?.pid !== globalThis.__test.targetPid) return false;
      const result = original(...args); globalThis.__test.nativeCalls.push({method, args, result}); return result;
    };
  }
  return native;
};
globalShortcut.register = (key, callback) => { if (key === 'CommandOrControl+Shift+Space') globalThis.__test.toggle = callback; return true; };
Worker.prototype.start = function () { this.status = status; setImmediate(() => this.emit('ready', status)); };
Worker.prototype.request = function (command, payload) {
  globalThis.__test.requests.push({command, payload});
  return new Promise((resolve, reject) => {
    globalThis.__test.finish = () => resolve({text: 'Видосы для GitHub готовы.', rawText: 'Видосы для GitHub готовы.', duration: 2, elapsed: .1, model: 'turbo', words: []});
    this.testReject = reject;
  });
};
Worker.prototype.stop = function () { this.testReject?.(new Error('Операция отменена.')); this.status = null; };
require('../../electron/main.cjs');
