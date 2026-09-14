const {spawn} = require('node:child_process');
const {EventEmitter} = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

class Worker extends EventEmitter {
  constructor({root, dataDir, resourcesPath, packaged}) {
    super(); this.options = {root, dataDir, resourcesPath, packaged};
    this.pending = new Map(); this.sequence = 0; this.status = null; this.process = null;
  }
  start() {
    const {root, dataDir, resourcesPath, packaged} = this.options;
    const exe = packaged ? path.join(resourcesPath, 'engine', process.platform === 'win32' ? 'shopot-engine.exe' : 'shopot-engine')
      : process.env.SHOPOT_PYTHON || path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
    if (!fs.existsSync(exe)) throw new Error('Движок не установлен. Выполни npm run setup в папке проекта.');
    const args = packaged ? ['--data-dir', dataDir] : [path.join(root, 'backend', 'engine.py'), '--data-dir', dataDir];
    const child = spawn(exe, args, {cwd: packaged ? resourcesPath : root, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
      env: {...process.env, PYTHONIOENCODING: 'utf-8', HF_HUB_DISABLE_TELEMETRY: '1', HF_HUB_DISABLE_IMPLICIT_TOKEN: '1'}});
    this.process = child;
    let errorTail = '';
    child.stderr.on('data', data => { errorTail = (errorTail + data).slice(-4000); });
    readline.createInterface({input: child.stdout}).on('line', line => {
      if (this.process !== child) return;
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message.event === 'ready') { this.status = message.status; this.emit('ready', this.status); }
      if (message.event === 'progress') this.emit('progress', message);
      if ('result' in message || 'error' in message) {
        const item = this.pending.get(message.id);
        if (item) {
          this.pending.delete(message.id);
          clearTimeout(item.timeout);
          message.error ? item.reject(new Error(message.error)) : item.resolve(message.result);
        }
      }
    });
    const fail = reason => {
      if (this.process !== child) return;
      this.status = null; this.process = null;
      for (const item of this.pending.values()) { clearTimeout(item.timeout); item.reject(new Error(reason)); }
      this.pending.clear(); this.emit('offline', reason);
    };
    child.on('error', error => fail('Не удалось запустить движок: ' + error.message));
    child.on('exit', code => fail(code ? 'Движок завершился с ошибкой. ' + errorTail.slice(-400) : 'Движок остановлен.'));
  }
  request(command, payload = {}) {
    if (!this.process || !this.status) return Promise.reject(new Error('Движок ещё запускается. Попробуй через несколько секунд.'));
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.stop(); this.emit('offline', 'Превышено время ожидания движка. Перезапусти Шёпот.'); }, 60 * 60 * 1000);
      this.pending.set(id, {resolve, reject, timeout});
      this.process.stdin.write(JSON.stringify({id, command, ...payload}) + '\n', 'utf8', error => {
        if (error) { this.pending.delete(id); clearTimeout(timeout); reject(error); }
      });
    });
  }
  stop() {
    for (const item of this.pending.values()) { clearTimeout(item.timeout); item.reject(new Error('Операция отменена.')); }
    this.pending.clear(); this.status = null;
    const child = this.process; this.process = null;
    if (child) { child.stdin.destroy(); child.kill(); }
  }
  restart() { this.stop(); this.start(); }
}
module.exports = {Worker};
