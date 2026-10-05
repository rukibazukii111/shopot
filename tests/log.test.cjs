const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {createJournal, timestamp, errorFields} = require('../electron/log.cjs');

const LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d [a-z-]+( [A-Za-z]+=("[^"]*"|\S+))*$/;
function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-log-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  let clock = new Date('2026-10-05T12:00:00Z');
  const journal = createJournal({dir: path.join(root, 'logs'), now: () => clock, ...options});
  const read = (name = 'shopot.log') => fs.readFileSync(path.join(root, 'logs', name), 'utf8');
  return {root, journal, read, files: () => fs.readdirSync(path.join(root, 'logs')).sort(), tick: ms => { clock = new Date(clock.getTime() + ms); }};
}

test('a line is local time with offset, the event and its fields in schema order', t => {
  const f = fixture(t);
  assert.equal(f.journal.write('dictation', {paste: 'focus-changed', model: 'gigaam', result: 'ok', record: 4.236, app: 'Telegram', profile: false}), true);
  const line = f.read().trim();
  assert.match(line, LINE);
  assert.match(line, / dictation result=ok model=gigaam record=4\.24 paste=focus-changed app=Telegram profile=false$/);
  assert.equal(Date.parse(line.split(' ')[0]), Date.parse('2026-10-05T12:00:00Z'));
  assert.match(timestamp(new Date()), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d$/);
});

test('fields outside the event schema or of the wrong type never reach the file', t => {
  const f = fixture(t);
  f.journal.write('dictation', {result: 'ok', text: 'секретный текст', model: 'не модель', record: 'долго', app: 'Окно "Чат с Машей"', appId: 'x'.repeat(65)});
  const line = f.read().trim();
  assert.match(line, / dictation result=ok rejected=model,record,app,appId,text$/);
  assert.doesNotMatch(line, /секрет|Маш|долго|xxxx/);
  assert.equal(f.journal.write('no-such-event', {result: 'ok'}), false);
  assert.equal(f.read().trim().split('\n').length, 1);
});

test('app names with spaces and Cyrillic are kept in quotes', t => {
  const f = fixture(t);
  f.journal.write('dictation', {app: 'Яндекс Браузер', appId: 'browser.exe'});
  assert.match(f.read(), / app="Яндекс Браузер" appId=browser\.exe$/m);
});

test('a list is written comma-separated, and an empty one as none', t => {
  const f = fixture(t);
  f.journal.write('engine-ready', {models: ['gigaam@322c3b294926', 'turbo@abc']});
  f.journal.write('engine-ready', {models: []});
  f.journal.write('engine-ready', {models: ['слово из диктовки']});
  assert.deepEqual(f.read().trim().split('\n').map(line => line.split(' ').slice(1).join(' ')),
    ['engine-ready models=gigaam@322c3b294926,turbo@abc', 'engine-ready models=none', 'engine-ready rejected=models']);
});

test('an error message is written only for expected errors, with the home folder hidden', t => {
  const f = fixture(t, {home: 'C:\\Users\\Ivan', platform: 'win32'});
  f.journal.write('ipc-error', {channel: 'transcribe', kind: 'KeyError', expected: false, message: 'слово из диктовки'});
  f.journal.write('ipc-error', {channel: 'transcribe', kind: 'UserError', expected: true,
    message: 'Нет файла C:\\Users\\Ivan\\x.bin и c:/users/ivan/y.bin, а C:\\Users\\Ivanov остаётся.\nВторая "строка"'});
  const [first, second] = f.read().trim().split('\n');
  assert.match(first, / ipc-error channel=transcribe kind=KeyError expected=false rejected=message$/);
  assert.match(second, / message="Нет файла ~\\x\.bin и ~\/y\.bin, а C:\\Users\\Ivanov остаётся\. Вторая 'строка'"$/);
  assert.match(second, LINE);
});

test('rotation keeps three files and the newest line in shopot.log', t => {
  const f = fixture(t, {maxBytes: 300});
  for (let i = 0; i < 40; i++) f.journal.write('quit', {uptime: i});
  assert.deepEqual(f.files(), ['shopot.1.log', 'shopot.2.log', 'shopot.log']);
  assert.match(f.read().trim().split('\n').at(-1), / quit uptime=39$/);
  for (const name of f.files()) assert.ok(fs.statSync(path.join(f.root, 'logs', name)).size <= 300);
  // A new journal on the same folder continues the size count instead of overrunning the limit.
  const again = createJournal({dir: path.join(f.root, 'logs'), maxBytes: 300});
  for (let i = 0; i < 10; i++) again.write('quit', {uptime: 100 + i});
  assert.ok(fs.statSync(path.join(f.root, 'logs', 'shopot.log')).size <= 300);
});

test('a journal that cannot write reports false and never throws', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shopot-log-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  fs.writeFileSync(path.join(root, 'logs'), 'a file where the folder should be');
  const journal = createJournal({dir: path.join(root, 'logs')});
  assert.equal(journal.write('quit', {uptime: 1}), false);
  assert.doesNotThrow(() => journal.pruneOlderThan(7));
});

test('pruning removes lines older than the period from every file', t => {
  const f = fixture(t, {maxBytes: 300});
  for (let i = 0; i < 12; i++) f.journal.write('quit', {uptime: i});
  f.tick(10 * 864e5);
  for (let i = 0; i < 3; i++) f.journal.write('quit', {uptime: 50 + i});
  f.journal.pruneOlderThan(0); f.journal.pruneOlderThan(Number.NaN);
  assert.equal(f.files().length, 3);
  f.journal.pruneOlderThan(7);
  const left = f.files().flatMap(name => f.read(name).trim().split('\n'));
  assert.deepEqual(left.map(line => line.split('=')[1]).sort(), ['50', '51', '52']);
  f.journal.write('quit', {uptime: 99});
  assert.match(f.read().trim().split('\n').at(-1), /uptime=99$/);
});

test('error fields carry the type and code, never the message or a path', () => {
  let missing;
  try { fs.readFileSync(path.join(os.tmpdir(), 'нет-такого-Шёпот', 'запись встречи.mp3')); } catch (error) { missing = error; }
  assert.deepEqual(errorFields(missing), {kind: 'Error', code: 'ENOENT', expected: false});
  const typeError = new TypeError("Cannot create property 'x' on string 'текст диктовки'");
  typeError.stack = 'TypeError: ...\n    at deliver (C:\\app\\electron\\paste.cjs:44:12)\n    at main (C:\\app\\electron\\main.cjs:300:5)';
  assert.deepEqual(errorFields(typeError), {kind: 'TypeError', expected: false, at: 'paste.cjs:44'});
  const engine = Object.assign(new Error('Аудиофайл пуст.'), {engine: true, kind: 'UserError', expected: true});
  assert.deepEqual(errorFields(engine), {kind: 'UserError', expected: true, message: 'Аудиофайл пуст.'});
  assert.deepEqual(errorFields('строка'), {kind: 'string', expected: false});
});
