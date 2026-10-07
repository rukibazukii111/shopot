const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
// System audio is a test tone here: nothing from the machine's speakers is recorded.
async function fakeSystemAudio(page) {
  await page.evaluate(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const context = new AudioContext(), tone = context.createOscillator(), out = context.createMediaStreamDestination();
      tone.connect(out); tone.start();
      return new MediaStream([...document.createElement('canvas').captureStream(1).getVideoTracks(), ...out.stream.getAudioTracks()]);
    };
  });
}
// The engine answers each chunk: the left channel is the user, the right one the other side.
function answerChunks(app) {
  const payloads = [];
  let answering = true;
  const done = (async () => {
    while (answering) {
      const count = await app.evaluate(() => globalThis.__test.requests.length);
      if (count > payloads.length) {
        const request = await app.evaluate((_, index) => globalThis.__test.requests[index], payloads.length);
        const n = payloads.push(request.payload);
        const cues = request.payload.channel === 'left' ? [{start: 0.1, end: 0.5, text: `Моя реплика ${n}.`}] : [{start: 0.6, end: 1.0, text: `Ответ собеседника ${n}.`}];
        await app.evaluate((_, value) => globalThis.__test.resolve({text: 'x', rawText: 'x', cues: value, words: [], duration: 1.2, elapsed: .1, model: 'gigaam'}), cues);
      } else await new Promise(resolve => setTimeout(resolve, 50));
    }
  })();
  return {payloads, stop: () => { answering = false; return done; }};
}
async function widgetOf(app) {
  await expect.poll(() => app.windows().some(p => p.url().endsWith('/widget.html'))).toBe(true);
  return app.windows().find(p => p.url().endsWith('/widget.html'));
}

test('a call is offered, recorded as two channels while it goes on and saved as a dialog', async () => {
  test.skip(process.platform !== 'win32', 'Calls are recorded on Windows only');
  const dataDir = path.join(root, '.private', 'ui-test', `meeting-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir, SHOPOT_MIC_POLL_MS: '150', SHOPOT_MEETING_CHUNK_SECONDS: '1.2'}});
  let engine;
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await expect(page.locator('#meeting-button')).toBeVisible();
    await fakeSystemAudio(page);
    engine = answerChunks(app);
    const payloads = engine.payloads;
    await app.evaluate(() => { globalThis.__test.micUsers = [{id: 'discord.exe', name: 'Discord'}]; });
    await expect.poll(() => app.windows().some(p => p.url().endsWith('/widget.html'))).toBe(true);
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await expect(widget.locator('#label')).toHaveText('Созвон в Discord. Записать?');
    await widget.locator('#offer-record').click();
    await expect(page.locator('#meeting-banner')).toBeVisible();
    await expect(page.locator('#meeting-detail')).toContainText('Discord');
    await expect(widget.locator('#label')).toHaveText('Созвон · Discord');
    await expect(widget.locator('#hint')).toContainText('Предупреди собеседников');
    await expect.poll(() => payloads.length, {timeout: 15000}).toBeGreaterThanOrEqual(4);
    // Discord lets go of the microphone: the call is over and the recording stops by itself.
    await app.evaluate(() => { globalThis.__test.micUsers = []; });
    await expect(widget.locator('#label')).toHaveText('Расшифровка созвона готова', {timeout: 15000});
    await expect(page.locator('#meeting-banner')).toBeHidden();
    expect(payloads.map(p => p.channel)).toEqual(payloads.map((_, i) => i % 2 ? 'right' : 'left'));
    expect(payloads[0]).toMatchObject({mode: 'natural', formatting: 'off', voiceCommands: false, snippets: []});
    const entry = (await page.evaluate(() => window.shopot.boot())).history[0];
    expect(entry.source).toBe('Созвон · Discord');
    expect(entry.text).toMatch(/^\[00:00\] Я: Моя реплика 1\.\n\n\[00:00\] Собеседники: Ответ собеседника 2\./);
    expect(entry.meeting).toMatchObject({app: 'Discord', failedChunks: 0});
    expect(fs.readdirSync(path.join(dataDir, 'audio'))).toEqual([]);
    // The transcript goes to a chat assistant only when the user pastes it.
    await app.evaluate(({clipboard}) => { clipboard.writeText = text => { globalThis.__copied = text; }; });
    await page.locator('[data-page="history"]').click();
    await page.locator('#history-detail [data-action="summary"]').click();
    await expect.poll(() => app.evaluate(() => globalThis.__copied)).toMatch(/^Сделай краткое резюме созвона \(Discord\)/);
    // A game using the microphone can be told not to offer again.
    await app.evaluate(() => { globalThis.__test.micUsers = [{id: 'deadlock.exe', name: 'deadlock'}]; });
    await expect(widget.locator('#label')).toHaveText('Созвон в deadlock. Записать?');
    await widget.locator('#offer-ignore').click();
    await expect.poll(async () => (await page.evaluate(() => window.shopot.boot())).settings.meetingIgnore).toEqual([{id: 'deadlock.exe', name: 'deadlock'}]);
    await page.locator('[data-page="settings"]').click();
    await expect(page.locator('#meeting-ignore')).toContainText('deadlock');
    // A transcript that cannot be stored (a read-only store.json, as a sync tool can leave it) is journaled as an error, not as saved.
    const storeFile = path.join(dataDir, 'store.json'), journalNow = () => fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8');
    const sent = payloads.length;
    await page.evaluate(() => window.shopot.startMeeting());
    await expect.poll(() => payloads.length, {timeout: 15000}).toBeGreaterThanOrEqual(sent + 2);
    fs.chmodSync(storeFile, 0o444);
    try {
      await page.evaluate(() => window.shopot.stopMeeting());
      await expect(widget.locator('#label')).toHaveText('Расшифровка созвона не сохранена', {timeout: 15000});
      await expect(page.locator('#meeting-banner')).toBeHidden();
      await expect.poll(journalNow).toMatch(/ meeting-finish .*result=error/);
    } finally { fs.chmodSync(storeFile, 0o666); }
    // A call the window cannot record: the journal keeps the error's type, not its message.
    await page.evaluate(() => { navigator.mediaDevices.getDisplayMedia = async () => { throw new DOMException('Экран Маши недоступен', 'NotAllowedError'); }; });
    await page.evaluate(() => window.shopot.startMeeting());
    await expect.poll(journalNow).toMatch(/ meeting-finish .*result=empty/);
    await engine.stop();
    // An offer main refuses, here because the model in the settings is not downloaded: the widget says why, the journal keeps the refusal.
    const settings = (await page.evaluate(() => window.shopot.boot())).settings;
    await page.evaluate(value => window.shopot.settings(value), {...settings, model: 'large-v3'});
    await app.evaluate(() => { globalThis.__test.micUsers = [{id: 'zoom.exe', name: 'Zoom'}]; });
    await expect(widget.locator('#label')).toHaveText('Созвон в Zoom. Записать?');
    await widget.locator('#offer-record').click();
    await expect(widget.locator('#label')).toHaveText('Сначала скачай модель в Шёпоте');
  } finally { await engine?.stop(); await app.close(); }
  // The journal follows the call part by part, without a word of what was said.
  const journal = fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8');
  expect(journal).not.toMatch(/реплика|собеседника/i);
  expect(journal).toMatch(/ meeting-start app=Discord appId=discord\.exe trigger=offer\n/);
  expect(journal).toMatch(/ meeting-chunk index=0 channel=left result=ok attempts=1 transcribe=\S+\n/);
  expect(journal).toMatch(/ meeting-chunk index=0 channel=right result=ok attempts=1 transcribe=\S+\n/);
  expect(journal).toMatch(/ meeting-finish duration=\S+ turns=\d+ chunks=\d+ failed=0 result=saved attempts=1\n/);
  // The call whose save failed: its code and the failing call, and no second «saved».
  expect(journal.match(/ meeting-finish .*result=saved/g)).toHaveLength(1);
  expect(journal).toMatch(/ meeting-finish duration=\S+ turns=[1-9]\d* chunks=[1-9]\d* failed=0 result=error attempts=3 code=EPERM at=store\.cjs:\d+\n/);
  expect(journal).toMatch(/ meeting-finish duration=\S+ turns=0 chunks=0 failed=0 result=empty problem=renderer kind=NotAllowedError\n/);
  expect(journal).toMatch(/ command-error command=meeting-record kind=Error expected=false at=main\.cjs:\d+\n/);
  expect(journal).not.toMatch(/Маши|rejected=/);
});

test('a call transcript that cannot be saved stays in the history until a save works', async () => {
  test.skip(process.platform !== 'win32', 'Calls are recorded on Windows only');
  const dataDir = path.join(root, '.private', 'ui-test', `meeting-unsaved-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  const storeFile = path.join(dataDir, 'store.json');
  const chunks = () => fs.readdirSync(path.join(dataDir, 'audio')).filter(name => name.endsWith('.webm')).sort();
  const saved = () => JSON.parse(fs.readFileSync(storeFile, 'utf8')).history;
  const launch = () => electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir, SHOPOT_MIC_POLL_MS: '150', SHOPOT_MEETING_CHUNK_SECONDS: '1.2', SHOPOT_SAVE_RETRY_SECONDS: '1.5'}});
  const app = await launch();
  let engine;
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await fakeSystemAudio(page);
    engine = answerChunks(app);
    const widget = await widgetOf(app);
    const unsaved = async () => (await page.evaluate(() => window.shopot.boot())).unsaved;
    // A call that ends while store.json cannot be written, as a sync tool or an antivirus can leave it.
    const recordCall = async () => {
      const sent = engine.payloads.length, before = chunks();
      await page.evaluate(() => window.shopot.startMeeting());
      await expect.poll(() => engine.payloads.length, {timeout: 15000}).toBeGreaterThanOrEqual(sent + 2);
      fs.chmodSync(storeFile, 0o444);
      await page.evaluate(() => window.shopot.stopMeeting());
      await expect(widget.locator('#label')).toHaveText('Расшифровка созвона не сохранена', {timeout: 15000});
      return chunks().filter(name => !before.includes(name));
    };
    const first = await recordCall();
    expect(first.length).toBeGreaterThanOrEqual(1);
    await expect(widget.locator('#hint')).toHaveText('Файл истории занят. Повторю сам');
    await expect(page.locator('#meeting-banner')).toBeHidden();
    // The text is in the history at once; store.json on disk does not have it yet.
    const history = (await page.evaluate(() => window.shopot.boot())).history;
    expect(history[0]).toMatchObject({source: 'Созвон', meeting: {app: null, failedChunks: 0}});
    expect(history[0].text).toMatch(/Я: Моя реплика 1\./);
    expect(saved()).toEqual([]);
    expect(await unsaved()).toEqual({count: 1, reason: 'access'});
    // The message stays until the user closes it.
    await page.waitForTimeout(3500);
    expect(await app.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().endsWith('/widget.html')).isVisible())).toBe(true);
    await expect(widget.locator('#label')).toHaveText('Расшифровка созвона не сохранена');
    // The disk fills up during a second call: the advice is to free space.
    await app.evaluate(() => {
      const fs = globalThis.__test.fs, write = fs.writeFileSync;
      globalThis.__test.restoreWrite = () => { fs.writeFileSync = write; };
      fs.writeFileSync = (file, ...rest) => {
        if (String(file).endsWith('store.json.tmp')) throw Object.assign(new Error('ENOSPC: no space left on device'), {code: 'ENOSPC'});
        return write(file, ...rest);
      };
    });
    const second = await recordCall();
    expect(second.length).toBeGreaterThanOrEqual(1);
    await expect(widget.locator('#hint')).toHaveText('Освободи место на диске');
    expect(await unsaved()).toEqual({count: 2, reason: 'space'});
    // Deleting the second call's text from the history lets go of its audio.
    const secondId = (await page.evaluate(() => window.shopot.boot())).history[0].id;
    await app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response: 1}); });
    await page.evaluate(id => window.shopot.deleteEntry(id).catch(() => false), secondId);
    await expect.poll(unsaved, {timeout: 10000}).toEqual({count: 1, reason: 'space'});
    expect(chunks()).toEqual(first);
    await app.evaluate(() => globalThis.__test.restoreWrite());
    // A dictation keeps the widget when the file can be written again and the transcript is saved by itself.
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(widget.locator('#label')).toHaveText('Слушаю тебя');
    fs.chmodSync(storeFile, 0o666);
    await expect.poll(saved, {timeout: 10000}).toHaveLength(1);
    expect(saved()[0].text).toMatch(/Я: Моя реплика 1\./);
    await expect.poll(chunks).toEqual([]);
    expect(await unsaved()).toBeNull();
    await expect(widget.locator('#label')).toHaveText('Слушаю тебя');
    await app.evaluate(() => globalThis.__test.cancel());
    await expect(widget.locator('#label')).toHaveText('Запись отменена');
  } finally { await engine?.stop(); fs.chmodSync(storeFile, 0o666); await app.close(); }
  const journal = fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8');
  expect(journal).not.toMatch(/реплика|собеседника|rejected=/i);
  expect(journal).toMatch(/ meeting-finish duration=\S+ turns=[1-9]\d* chunks=[1-9]\d* failed=0 result=error attempts=3 code=EPERM at=store\.cjs:\d+\n/);
  expect(journal).toMatch(/ meeting-finish duration=\S+ turns=[1-9]\d* chunks=[1-9]\d* failed=0 result=error attempts=3 code=ENOSPC at=store\.cjs:\d+\n/);
  expect(journal).toMatch(/ meeting-save result=saved trigger=timer waited=\S+\n/);
});
