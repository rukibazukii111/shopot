const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('a call is offered, recorded as two channels while it goes on and saved as a dialog', async () => {
  test.skip(process.platform !== 'win32', 'Calls are recorded on Windows only');
  const dataDir = path.join(root, '.private', 'ui-test', `meeting-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.setSettings({...store.data.settings, autoCopy: false, autoPaste: false});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir, SHOPOT_MIC_POLL_MS: '150', SHOPOT_MEETING_CHUNK_SECONDS: '1.2'}});
  let answering = true;
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await expect(page.locator('#meeting-button')).toBeVisible();
    // System audio is a test tone here: nothing from the machine's speakers is recorded.
    await page.evaluate(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const context = new AudioContext(), tone = context.createOscillator(), out = context.createMediaStreamDestination();
        tone.connect(out); tone.start();
        return new MediaStream([...document.createElement('canvas').captureStream(1).getVideoTracks(), ...out.stream.getAudioTracks()]);
      };
    });
    // The engine answers each chunk: the left channel is the user, the right one the other side.
    const payloads = [];
    const answers = (async () => {
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
    answering = false; await answers;
  } finally { answering = false; await app.close(); }
});
