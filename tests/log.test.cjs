const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {createJournal, timestamp, errorFields} = require('../electron/log.cjs');
const {MODEL_IDS, LANGUAGES, MODES, FORMATTING} = require('../electron/store.cjs');

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

test('every model, language, text mode and layout the settings accept is journaled', t => {
  const f = fixture(t);
  for (const model of MODEL_IDS) f.journal.write('dictation', {model});
  for (const language of LANGUAGES) f.journal.write('dictation', {language});
  for (const mode of MODES) f.journal.write('dictation', {mode});
  for (const formatting of FORMATTING) f.journal.write('dictation', {formattingRequested: formatting, formatting});
  assert.equal(f.read().trim().split('\n').length, MODEL_IDS.length + LANGUAGES.length + MODES.length + FORMATTING.length);
  assert.doesNotMatch(f.read(), /rejected=/);
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

const logLine = (uptime, date = '2026-10-05') => `${date}T12:00:00.000+00:00 quit uptime=${uptime}\n`;
function interruptedRotation(t, after) {
  const f = fixture(t), dir = path.join(f.root, 'logs');
  fs.mkdirSync(dir);
  for (const [name, uptime] of [['shopot.2.log', 10], ['shopot.1.log', 20], ['shopot.log', 30]]) {
    fs.writeFileSync(path.join(dir, name), logLine(uptime));
  }
  crashJournal(dir, 'write', after);
  return {...f, dir};
}
function crashJournal(dir, operation, after) {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'fixtures/journal-crash.cjs'), dir, operation, String(after)], {encoding: 'utf8'});
  assert.equal(child.status, 73, child.stderr || `rename ${after} was not reached`);
}
const uptimes = text => [...text.matchAll(/ quit uptime=(\d+)\n/g)].map(match => Number(match[1]));

for (const after of [1, 2, 3]) {
  for (const entry of ['read', 'write', 'prune']) {
    for (const newActive of [false, true]) {
      test(`${entry} recovers rotation interrupted after rename ${after}${newActive ? ', retaining a newer active file' : ''}`, t => {
        const f = interruptedRotation(t, after);
        if (newActive) fs.writeFileSync(path.join(f.dir, 'shopot.log'), logLine(40));
        const restarted = createJournal({dir: f.dir, maxBytes: 300, now: () => new Date('2026-10-06T12:00:00Z')});
        if (entry === 'write') assert.equal(restarted.write('app-start', {version: '0.3.0'}), true);
        if (entry === 'prune') restarted.pruneOlderThan(7);
        assert.deepEqual(uptimes(restarted.read()), newActive ? [20, 30, 40] : [20, 30]);
        assert.ok(f.files().length <= 3);
        assert.ok(!f.files().some(name => name.endsWith('.rotating')));
        // Repeated reads/restarts neither repeat nor drop a recovered part.
        assert.deepEqual(uptimes(createJournal({dir: f.dir}).read()), newActive ? [20, 30, 40] : [20, 30]);
      });
    }
  }
  test(`retention also removes expired rows from rotation interrupted after rename ${after}`, t => {
    const f = interruptedRotation(t, after);
    fs.writeFileSync(path.join(f.dir, 'shopot.log'), logLine(40, '2026-10-15'));
    const restarted = createJournal({dir: f.dir, now: () => new Date('2026-10-15T12:00:00Z')});
    restarted.pruneOlderThan(7);
    assert.deepEqual(uptimes(restarted.read()), [40]);
    assert.deepEqual(f.files(), ['shopot.log']);
  });
}

for (const after of [1, 2]) {
  test(`a second crash during recovery after rename ${after} preserves the remaining rows`, t => {
    const f = interruptedRotation(t, 1);
    fs.writeFileSync(path.join(f.dir, 'shopot.log'), logLine(40));
    crashJournal(f.dir, 'read', after);
    assert.deepEqual(uptimes(createJournal({dir: f.dir}).read()), [20, 30, 40]);
    assert.deepEqual(f.files(), ['shopot.1.log', 'shopot.2.log', 'shopot.log']);
  });
}

test('a locked recovery keeps its source, refuses incomplete reads and resumes once unlocked', t => {
  const f = interruptedRotation(t, 1);
  fs.writeFileSync(path.join(f.dir, 'shopot.log'), logLine(40));
  const rename = fs.renameSync;
  const locked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith('.rotating')) throw Object.assign(new Error('locked'), {code: 'EBUSY'});
    return rename(from, to);
  });
  const restarted = createJournal({dir: f.dir});
  assert.equal(restarted.write('quit', {uptime: 50}), false);
  assert.throws(() => restarted.read(), {code: 'EBUSY'});
  assert.doesNotThrow(() => restarted.pruneOlderThan(7));
  assert.equal(f.read('shopot.log.rotating'), logLine(30));
  assert.equal(f.read('shopot.log'), logLine(40));
  assert.equal(f.read('shopot.2.log'), logLine(20));
  locked.mock.restore();
  assert.deepEqual(uptimes(restarted.read()), [20, 30, 40]);
  assert.equal(restarted.write('quit', {uptime: 60}), true);
  assert.deepEqual(uptimes(restarted.read()), [20, 30, 40, 60]);
  assert.deepEqual(f.files(), ['shopot.1.log', 'shopot.2.log', 'shopot.log']);
});

test('an unreadable journal part is an error rather than an absent part', t => {
  const f = fixture(t);
  f.journal.write('quit', {uptime: 1});
  fs.writeFileSync(path.join(f.root, 'logs', 'shopot.1.log'), logLine(0));
  const stat = fs.statSync;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    if (path.basename(file) === 'shopot.1.log') throw Object.assign(new Error('denied'), {code: 'EACCES'});
    return stat(file, ...args);
  });
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (path.basename(file) === 'shopot.1.log') throw Object.assign(new Error('denied'), {code: 'EACCES'});
    return read(file, ...args);
  });
  // existsSync alone cannot distinguish a missing optional archive from denied access.
  t.mock.method(fs, 'existsSync', file => path.basename(file) === 'shopot.1.log' ? false : fs.statSync(file, {throwIfNoEntry: false}) !== undefined);
  assert.throws(() => f.journal.read(), {code: 'EACCES'});
});

test('a shopot.log another program holds open stops the rotation before any older part is touched', t => {
  const f = fixture(t, {maxBytes: 300});
  for (let i = 0; i < 40; i++) f.journal.write('quit', {uptime: i});
  const older = name => f.read(name).trim().split('\n').map(line => line.split('=')[1]);
  const before = {'shopot.1.log': older('shopot.1.log'), 'shopot.2.log': older('shopot.2.log'), 'shopot.log': older('shopot.log')};
  // What Windows does while a viewer holds the file open without delete sharing.
  const rename = fs.renameSync;
  const locked = t.mock.method(fs, 'renameSync', (from, to) => {
    if (path.basename(from) === 'shopot.log') throw Object.assign(new Error('EBUSY: resource busy or locked'), {code: 'EBUSY'});
    return rename(from, to);
  });
  const results = Array.from({length: 10}, (_, i) => f.journal.write('quit', {uptime: 100 + i}));
  assert.ok(results.includes(false));
  assert.deepEqual(f.files(), ['shopot.1.log', 'shopot.2.log', 'shopot.log']);
  assert.deepEqual(older('shopot.1.log'), before['shopot.1.log']);
  assert.deepEqual(older('shopot.2.log'), before['shopot.2.log']);
  // Once the file is free, the rotation goes through and keeps the order.
  locked.mock.restore();
  assert.equal(f.journal.write('quit', {uptime: 200}), true);
  assert.deepEqual(f.files(), ['shopot.1.log', 'shopot.2.log', 'shopot.log']);
  assert.deepEqual(older('shopot.2.log'), before['shopot.1.log']);
  assert.deepEqual(older('shopot.1.log').slice(0, before['shopot.log'].length), before['shopot.log']);
  assert.match(f.read().trim(), / quit uptime=200$/);
});

test('reading gives the whole journal as one text, oldest line first', t => {
  const f = fixture(t, {maxBytes: 300});
  for (let i = 0; i < 40; i++) f.journal.write('quit', {uptime: i});
  const lines = f.journal.read().trim().split('\n');
  for (const line of lines) assert.match(line, LINE);
  // Consecutive and ending with the newest: no part is missing, repeated or out of order.
  const uptimes = lines.map(line => Number(line.split('=')[1]));
  assert.deepEqual(uptimes, Array.from({length: uptimes.length}, (_, i) => 40 - uptimes.length + i));
  assert.equal(uptimes.length, f.files().reduce((sum, name) => sum + f.read(name).trim().split('\n').length, 0));
});

test('an absent journal reads as empty text, and a part cut short stays a line of its own', t => {
  const f = fixture(t);
  assert.equal(f.journal.read(), '');
  fs.mkdirSync(path.join(f.root, 'logs'));
  fs.writeFileSync(path.join(f.root, 'logs', 'shopot.1.log'), 'A');
  fs.writeFileSync(path.join(f.root, 'logs', 'shopot.log'), 'B\n');
  assert.equal(f.journal.read(), 'A\nB\n');
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

test('a prune that cannot replace a locked file leaves no copy behind', t => {
  const f = fixture(t);
  f.journal.write('quit', {uptime: 1});
  f.tick(10 * 864e5);
  f.journal.write('quit', {uptime: 2});
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from.endsWith('.tmp')) throw Object.assign(new Error('EPERM: operation not permitted'), {code: 'EPERM'});
    return rename(from, to);
  });
  assert.doesNotThrow(() => f.journal.pruneOlderThan(7));
  assert.deepEqual(f.files(), ['shopot.log']);
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
