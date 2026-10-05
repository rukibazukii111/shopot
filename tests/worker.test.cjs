const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {once} = require('node:events');
const {Worker} = require('../electron/worker.cjs');

// A stand-in engine: Node runs it through SHOPOT_PYTHON and speaks the same JSON lines.
const FAKE_ENGINE = `
const reply = value => process.stdout.write(JSON.stringify(value) + '\\n');
reply({event: 'ready', status: {models: []}});
require('node:readline').createInterface({input: process.stdin}).on('line', line => {
  const {id, command} = JSON.parse(line);
  if (command === 'refuse') reply({id, error: 'Аудиофайл пуст.', kind: 'UserError', expected: true});
  if (command === 'break') reply({id, error: "KeyError: 'слово из диктовки'", kind: 'KeyError', expected: false});
  if (command === 'cancel-me') reply({id, error: 'Операция отменена.', kind: 'Canceled', expected: true, canceled: true});
  if (command === 'crash') { process.stderr.write('Traceback: слово из диктовки\\n'); process.exit(3); }
});`;

function start(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-worker-'));
  fs.mkdirSync(path.join(root, 'backend'));
  fs.writeFileSync(path.join(root, 'backend', 'engine.py'), FAKE_ENGINE);
  const previous = process.env.SHOPOT_PYTHON;
  process.env.SHOPOT_PYTHON = process.execPath;
  const worker = new Worker({root, dataDir: root, packaged: false});
  const ready = once(worker, 'ready');
  worker.start();
  const child = worker.process, exited = once(child, 'exit');
  if (previous === undefined) delete process.env.SHOPOT_PYTHON; else process.env.SHOPOT_PYTHON = previous;
  // Windows keeps the folder locked until the engine process is really gone.
  t.after(async () => { worker.stop(); if (child.exitCode === null && child.signalCode === null) await exited; fs.rmSync(root, {recursive: true, force: true}); });
  return {worker, ready};
}

test('an engine error keeps its type, whether it is expected, and cancellation', async t => {
  const {worker, ready} = start(t);
  await ready;
  await assert.rejects(worker.request('refuse'), {message: 'Аудиофайл пуст.', engine: true, kind: 'UserError', expected: true, canceled: false});
  await assert.rejects(worker.request('break'), {engine: true, kind: 'KeyError', expected: false});
  await assert.rejects(worker.request('cancel-me'), {kind: 'Canceled', expected: true, canceled: true});
});

test('a crashed engine reports its exit code separately from the stderr text', async t => {
  const {worker, ready} = start(t);
  await ready;
  const offline = once(worker, 'offline');
  await assert.rejects(worker.request('crash'), {kind: 'EngineOffline'});
  const [, info] = await offline;
  assert.deepEqual(info, {cause: 'exit', exitCode: 3, signal: undefined});
  assert.doesNotMatch(JSON.stringify(info), /слово/);
});
