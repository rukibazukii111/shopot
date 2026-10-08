const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}[+-]\d\d:\d\d [a-z-]+( [A-Za-z]+=("[^"]*"|\S+))*$/;

test('the journal records every step of real work and none of what the user said or typed', async () => {
  const stamp = `Qz${Date.now().toString(36)}`;
  // Every private value carries the stamp; a Cyrillic word checks the text itself, whatever the encoding.
  const said = `шепотслово${stamp}`, mark = name => `${name}${stamp}`;
  const dataDir = path.join(root, '.private', 'ui-test', `journal-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.setDictionary([...store.data.dictionary, {word: mark('Словарь'), aliases: [mark('псевдоним')]}]);
  store.setSnippets([{trigger: mark('мой адрес'), text: mark('Улица')}]);
  store.addHistory({id: 'earlier', createdAt: '2026-09-26T09:00:00Z', source: 'Микрофон', text: mark('Старая диктовка'), rawText: mark('Старая'), words: [],
    duration: 2, elapsed: .2, model: 'gigaam', mode: 'natural', replacements: [], audioFile: null, app: null});
  // Nothing may reach the user's clipboard or another window.
  store.setSettings({...store.data.settings, context: mark('Подсказка'), autoCopy: false, autoPaste: false});
  const imported = path.join(dataDir, `Встреча с юристом ${stamp}.wav`);
  fs.writeFileSync(imported, Buffer.alloc(64));
  // The hotkey preload loaded the model for 2.5 s while the user spoke (the engine reports it once, for the journal).
  const result = {text: `${said} ${mark('Текст')}`, rawText: mark('Сырой'), duration: 3.5, elapsed: .5, loadElapsed: .2, formatElapsed: .1,
    preloadElapsed: 2.5, memoryPeak: 512 * 2 ** 20, device: 'cpu', formatting: 'rules', model: 'gigaam', noSpeech: false,
    words: [{word: mark('Слово'), start: 0, end: 1}], segments: [{text: mark('Сегмент'), start: 0, end: 1}], cues: [{text: mark('Субтитр'), start: 0, end: 1}],
    replacements: [{from: mark('псевдоним'), to: mark('Словарь')}], snippets: [mark('мой адрес')], commands: []};

  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir}});
  const requests = () => app.evaluate(() => globalThis.__test.requests.length);
  const idle = () => expect.poll(() => page.evaluate(() => window.shopot.boot().then(s => s.busy))).toBe(false);
  let page, system;
  async function dictate(finish) {
    const before = await requests();
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(requests).toBe(before + 1);
    await finish();
    await idle();
  }
  try {
    page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    // The window title of the target app is private even if it is ever captured.
    await app.evaluate((_, title) => { globalThis.__test.fakeTarget = {hwnd: 1, pid: 1, focus: 0, title, app: {id: 'telegram.exe', name: 'Telegram'}}; }, mark('Чат с Машей'));
    // The engine answers 0.8 s after the request and spent 0.5 s on it: the rest is the wait for the engine.
    await dictate(async () => {
      await new Promise(resolve => setTimeout(resolve, 800));
      await app.evaluate((_, value) => globalThis.__test.resolve(value), result);
    });
    await dictate(() => app.evaluate(() => globalThis.__test.resolve({text: '', rawText: '', words: [], segments: [], duration: 1, elapsed: .1, model: 'gigaam', noSpeech: true})));
    await dictate(() => app.evaluate((_, message) => globalThis.__test.failWith({message, kind: 'KeyError', expected: false}), `KeyError: '${said}'`));
    await dictate(() => app.evaluate(() => globalThis.__test.failWith({message: 'Аудиофайл пуст.', kind: 'UserError', expected: true})));
    // A file the user opens: its name is theirs too.
    await app.evaluate(({dialog}, file) => { dialog.showOpenDialog = async () => ({canceled: false, filePaths: [file]}); }, imported);
    let before = await requests();
    await page.evaluate(() => { window.shopot.importAudio().catch(() => {}); });
    await expect.poll(requests).toBe(before + 1);
    await app.evaluate((_, value) => globalThis.__test.resolve(value), result);
    await idle();
    // Retrying the recording that failed above.
    const pending = (await page.evaluate(() => window.shopot.boot())).pendingRecordings;
    expect(pending.length).toBeGreaterThan(0);
    before = await requests();
    await page.evaluate(id => { window.shopot.retryRecording(id).catch(() => {}); }, pending[0].id);
    await expect.poll(requests).toBe(before + 1);
    await app.evaluate((_, value) => globalThis.__test.resolve(value), result);
    await idle();
    // The microphone fails with a type the window has no words for, so its own message travels to main.
    await page.evaluate(message => {
      window.originalGetMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = async () => { throw new DOMException(message, 'AbortError'); };
    }, mark('Микрофон Маши'));
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(() => fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8')).toMatch(/ capture-error /);
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.originalGetMedia; });
    system = await app.evaluate(() => process.getSystemVersion());
    // Escape during a recording.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.cancel());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    const journalNow = () => fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8');
    // The recorder fails mid-recording: a failure of its type, not the user's cancel, and its message stays out.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await page.evaluate(message => recorder.dispatchEvent(new ErrorEvent('error', {error: new DOMException(message, 'UnknownError')})), mark('Сбой у Маши'));
    await expect.poll(journalNow).toMatch(/ capture-error phase=recording kind=UnknownError$/m);
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    // A recording that holds no audio is not a cancel either.
    await page.evaluate(() => { window.originalArrayBuffer = Blob.prototype.arrayBuffer; Blob.prototype.arrayBuffer = async () => new ArrayBuffer(0); });
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(journalNow).toMatch(/ capture-error phase=stopping kind=EmptyRecording$/m);
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    await page.evaluate(() => { Blob.prototype.arrayBuffer = window.originalArrayBuffer; });
    // The microphone goes away mid-recording: the stop is journaled with its cause, and what was recorded is still recognized.
    before = await requests();
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await page.evaluate(() => stream.getAudioTracks()[0].dispatchEvent(new Event('ended')));
    await expect.poll(requests).toBe(before + 1);
    await app.evaluate(() => globalThis.__test.finish());
    await idle();
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    // A hotkey press main refuses, here because the model in the settings is not downloaded.
    const settings = (await page.evaluate(() => window.shopot.boot())).settings;
    await page.evaluate(value => window.shopot.settings(value), {...settings, model: 'large-v3'});
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(journalNow).toMatch(/ command-error /);
  } finally { await app.close(); }

  const logs = path.join(dataDir, 'logs');
  const journal = fs.readdirSync(logs).map(name => fs.readFileSync(path.join(logs, name), 'utf8')).join('');
  const lines = journal.trim().split('\n');
  for (const line of lines) expect(line).toMatch(LINE);
  expect(journal).not.toContain(stamp);
  expect(journal).not.toContain('шепотслово');
  expect(journal).not.toMatch(/Маш|юрист|Встреча|Улица|Подсказка/);
  const has = pattern => expect(lines.some(line => pattern.test(line)), String(pattern)).toBe(true);
  const version = require('../../package.json').version.replace(/\./g, '\\.');
  // The system version reads the same as in «Сообщить о проблеме» (on macOS os.release() is the Darwin version).
  has(new RegExp(` app-start version=${version} electron=\\S+ os=${system.replace(/\./g, '\\.')} platform=\\S+ .* dataDirNonAscii=(true|false) dataDirSpace=(true|false)`));
  has(/ engine-ready models=gigaam@322c3b294926,turbo@,small@ .*formatter=absent/);
  // The load inside the job stays apart from the preload's, so recognition is the job minus load and layout.
  has(/ dictation result=ok trigger=hotkey model=gigaam device=cpu language=ru mode=natural formattingRequested=rules formatting=rules translate=false record=\d.* audio=3\.5 preload=2\.5 wait=\S+ load=0\.2 transcribe=0\.2 format=0\.1 total=0\.5 pasteTime=\S+ memoryMb=512 paste=saved app=Telegram appId=telegram\.exe profile=false$/);
  expect(Number(/ wait=(\S+)/.exec(lines.find(line => / dictation result=ok /.test(line)))[1])).toBeGreaterThanOrEqual(.25);
  has(/ dictation result=no-speech .* audio=1 /);
  has(/ dictation result=error .*kind=KeyError expected=false$/);
  has(/ dictation result=error .*kind=UserError expected=true message="Аудиофайл пуст\."$/);
  has(/ file result=ok model=gigaam .* wait=\S+ load=0\.2 .* paste=saved$/);
  has(/ retry result=ok /);
  // Only a dictation sends a preload; a file or a retry would report a canceled dictation's.
  expect(lines.filter(line => / (file|retry) result=ok .*preload=/.test(line))).toEqual([]);
  has(/ capture-error phase=requesting kind=AbortError$/);
  has(/ cancel phase=recording$/);
  // Only Escape was a cancel: a failed recorder and an empty recording are capture errors.
  expect(lines.filter(line => / cancel /.test(line))).toHaveLength(1);
  has(/ capture-error phase=recording kind=UnknownError$/);
  has(/ capture-error phase=stopping kind=EmptyRecording$/);
  const unplugged = lines.findIndex(line => / capture-error phase=recording kind=TrackEnded$/.test(line));
  expect(unplugged).toBeGreaterThan(-1);
  expect(lines.slice(unplugged + 1).find(line => / dictation /.test(line))).toMatch(/ dictation result=ok trigger=hotkey /);
  // The refusal points at its line in main.cjs: a missing model, not a busy app or a starting engine.
  const refusal = fs.readFileSync(path.join(root, 'electron', 'main.cjs'), 'utf8').split('\n')
    .findIndex(line => line.includes("throw new Error('Сначала скачай модель в Шёпоте')")) + 1;
  has(new RegExp(` command-error command=hotkey kind=Error expected=false at=main\\.cjs:${refusal}$`));
  // A failed dictation is journaled once, as the dictation, not again as a failed window command.
  expect(journal).not.toContain('ipc-error channel=transcribe');
  has(/ app-ready hotkey=true customHotkey=false native=(true|false) meetings=(true|false)$/);
  expect(lines.filter(line => / dictation result=error .*kind=KeyError/.test(line))[0]).not.toContain('message=');
  expect(journal).not.toContain('rejected=');
  // The preload's time is the journal's: history keeps showing the load inside the recognition time.
  const history = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')).history;
  expect(history.filter(entry => 'preloadElapsed' in entry)).toEqual([]);
  expect(history.filter(entry => entry.loadElapsed === .2)).toHaveLength(3);
});

test('a cancel is journaled with the stage the user interrupted, not with the stop it starts', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `journal-cancel-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir}});
  const cancels = () => fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8').match(/(?<= cancel ).*$/gm) ?? [];
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await app.evaluate(() => { globalThis.__test.fakeTarget = {hwnd: 1, pid: 1, focus: 0, app: {id: 'notepad.exe', name: 'Notepad'}}; });
    // «Отменить» in the window: the window stops the recorder first and reports the cancel once it has stopped.
    await page.locator('#record-button').click();
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await page.locator('#cancel-button').click();
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    await expect.poll(cancels).toEqual(['phase=recording']);
    // The hotkey pressed again while the microphone is still opening: main stops the capture, then the window cancels it.
    // A press is a second one only after the hold watcher has found the keys up; before that it is the held key repeating.
    await app.evaluate(() => Object.defineProperty(globalThis.__test, 'keysDown', {configurable: true, get: () => { globalThis.__test.keysRead = true; return false; }}));
    await page.evaluate(() => {
      window.originalGetMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
      navigator.mediaDevices.getUserMedia = () => new Promise(() => {});
    });
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-heading')).toHaveText('Готовлюсь слушать');
    await expect.poll(() => app.evaluate(() => globalThis.__test.keysRead)).toBe(true);
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    await expect.poll(cancels).toEqual(['phase=recording', 'phase=requesting']);
    // After a plain stop the cancel belongs to recognition: the stage that stop interrupted does not linger.
    await page.evaluate(() => { navigator.mediaDevices.getUserMedia = window.originalGetMedia; });
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await app.evaluate(() => globalThis.__test.toggle());
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    await page.locator('#cancel-button').click();
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    await expect.poll(cancels).toEqual(['phase=recording', 'phase=requesting', 'phase=transcribing']);
  } finally { await app.close(); }
});

test('a store that cannot be loaded at start is journaled before the app quits, without its message', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `journal-store-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  // Cut short, as a crash or a sync tool can leave it.
  fs.writeFileSync(path.join(dataDir, 'store.json'), '{"version": 1, "settings": {');
  // The native error box cannot be kept off the desktop, so the harness leaves it out.
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: dataDir, SHOPOT_TEST_NO_ERROR_BOX: '1'}});
  const journal = () => fs.existsSync(path.join(dataDir, 'logs', 'shopot.log')) ? fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8').trim().split('\n') : [];
  try {
    await expect.poll(() => journal().map(line => line.split(' ')[1]), {timeout: 15000}).toEqual(['app-start', 'main-error', 'quit']);
  } finally { await app.close(); }
  const lines = journal();
  const unreadable = fs.readFileSync(path.join(root, 'electron', 'store.cjs'), 'utf8').split('\n')
    .findIndex(line => line.includes("throw new Error('Не удалось прочитать историю")) + 1;
  expect(lines[1]).toMatch(new RegExp(` main-error origin=store kind=Error at=store\\.cjs:${unreadable}$`));
});
