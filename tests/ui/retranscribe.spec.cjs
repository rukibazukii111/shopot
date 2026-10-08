const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const DAY = 864e5;
const AUDIO = 'a1b2c3d4-0000-4000-8000-000000000001.webm', SOLO = 'a1b2c3d4-0000-4000-8000-000000000002.webm';

// A data folder with history entries and their audio files, as an earlier run left it.
function seed(name, history) {
  const dataDir = path.join(root, '.private', 'ui-test', `${name}-${Date.now()}`);
  const audio = path.join(dataDir, 'audio');
  fs.mkdirSync(audio, {recursive: true});
  const entries = history.map(({id, age, text = id, model = 'gigaam', audioFile = null, ...rest}) => ({id, createdAt: new Date(Date.now() - age).toISOString(),
    source: 'Микрофон', text, rawText: text, words: [], duration: 2, elapsed: .2, model, language: 'ru', mode: 'natural', replacements: [], audioFile, ...rest}));
  for (const file of new Set(entries.map(e => e.audioFile).filter(Boolean))) fs.writeFileSync(path.join(audio, file), 'audio');
  fs.writeFileSync(path.join(dataDir, 'store.json'), JSON.stringify({version: 1, settings: {}, dictionary: [], history: entries, pendingRecordings: []}));
  return {dataDir, audio, entries, saved: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')),
    journal: () => fs.readFileSync(path.join(dataDir, 'logs', 'shopot.log'), 'utf8')};
}
async function launch(data) {
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: data.dataDir}});
  const page = await app.firstWindow();
  await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
  await page.locator('[data-page="history"]').click();
  return {app, page};
}
const lastRequest = app => app.evaluate(() => globalThis.__test.requests.at(-1));
const notifications = app => app.evaluate(() => globalThis.__test.notifications.map(n => n.command));
const detail = page => page.locator('#history-detail');

test('another model gives a new entry right above the original, with its date, and leaves the original as it was', async () => {
  const data = seed('retranscribe', [{id: 'newest', age: 3600e3}, {id: 'original', age: 3 * DAY, text: 'Исходный текст', audioFile: AUDIO}, {id: 'oldest', age: 5 * DAY}]);
  const {app, page} = await launch(data);
  try {
    await page.locator('[data-select-entry="original"]').click();
    await detail(page).locator('[data-action="retranscribe"]').click();
    const model = detail(page).locator('[data-retranscribe="model"]'), language = detail(page).locator('[data-retranscribe="language"]');
    // The active model made this entry, so the first other downloaded one is offered.
    await expect(model).toHaveValue('turbo');
    await expect(model.locator('option[value="gigaam"]')).toHaveText('Быстрая — как в этой записи');
    await expect(language).toHaveValue('ru');
    await language.selectOption('auto');
    await detail(page).screenshot({path: path.join(root, '.private/ui-test/retranscribe-choice.png')});
    await detail(page).locator('[data-action="retranscribe-start"]').click();
    await expect(detail(page).locator('.retranscribe-status')).toContainText('Распознаю заново · Точная');
    const request = await lastRequest(app);
    expect(request.command).toBe('transcribe');
    expect(request.payload).toMatchObject({audioFile: AUDIO, model: 'turbo', language: 'auto', mode: 'natural', translate: false});
    await app.evaluate(() => globalThis.__test.progress());
    await expect.poll(() => page.locator('#retranscribe-progress').evaluate(bar => bar.value)).toBe(.5);
    await page.waitForTimeout(300);
    await detail(page).screenshot({path: path.join(root, '.private/ui-test/retranscribe-progress.png')});
    // A dictation-only action stays off while the engine is busy with it.
    await page.locator('[data-page="dictation"]').click();
    await expect(page.locator('#import-button')).toBeDisabled();
    await expect(page.locator('#record-button')).toBeEnabled();
    await page.locator('[data-page="history"]').click();

    await app.evaluate(() => globalThis.__test.resolve({text: 'Новый текст', rawText: 'Новый текст', duration: 2, elapsed: .3, model: 'turbo', words: [], language: 'ru'}));
    await expect(page.locator('#toast')).toContainText('Готово. Новая запись — над исходной');
    const saved = data.saved().history;
    expect(saved.map(e => e.id).filter(id => !['newest', 'original', 'oldest'].includes(id))).toHaveLength(1);
    const again = saved[1];
    expect(saved.map(e => e.id)).toEqual(['newest', again.id, 'original', 'oldest']);
    expect(again).toMatchObject({createdAt: data.entries[1].createdAt, text: 'Новый текст', model: 'turbo', audioFile: AUDIO, source: 'Микрофон',
      retranscribed: {from: 'original', model: 'turbo'}});
    expect(Date.parse(again.recognizedAt)).toBeGreaterThan(Date.parse(again.createdAt));
    expect(saved[2]).toEqual(data.entries[1]);
    expect(fs.existsSync(path.join(data.audio, AUDIO))).toBe(true);

    await expect(page.locator(`[data-select-entry="${again.id}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(`[data-select-entry="${again.id}"] .row-again`)).toHaveText('Повторно: Точная');
    await expect(detail(page).locator('.detail-source')).toHaveText('Повторно: Точная · Микрофон');
    await expect(detail(page).locator('.meta-list')).toContainText('Распознано заново');
    await expect(detail(page).locator('.history-editor')).toHaveValue('Новый текст');
    // Nothing is pasted, and the new entry can be re-recognized in its turn.
    expect(await app.evaluate(() => globalThis.__test.nativeCalls.filter(call => call.method === 'paste').length)).toBe(0);
    await expect(detail(page).locator('[data-action="retranscribe"]')).toBeEnabled();
    const line = data.journal().split('\n').find(l => / retranscribe /.test(l));
    expect(line).toMatch(/ retranscribe result=ok model=turbo .*from=gigaam preempted=false$/);
    expect(data.journal()).not.toContain('Новый текст');
  } finally { await app.close(); }
});

test('GigaAM takes Russian only, «Отменить» stops it, and the entry being re-recognized cannot be deleted', async () => {
  const data = seed('retranscribe-cancel', [{id: 'original', age: DAY, model: 'turbo', audioFile: AUDIO}]);
  const {app, page} = await launch(data);
  try {
    await detail(page).locator('[data-action="retranscribe"]').click();
    const model = detail(page).locator('[data-retranscribe="model"]'), language = detail(page).locator('[data-retranscribe="language"]');
    await expect(model).toHaveValue('gigaam');
    await expect(language).toHaveValue('ru');
    const disabled = () => language.locator('option').evaluateAll(options => options.filter(o => o.disabled).map(o => o.value));
    await expect.poll(disabled).toEqual(['en', 'auto']);
    await expect(detail(page).locator('.retranscribe-note')).toContainText('Быстрая модель понимает только русский');
    await model.selectOption('small');
    await expect.poll(disabled).toEqual([]);
    await language.selectOption('en');
    await model.selectOption('gigaam');
    await expect(language).toHaveValue('ru');
    // Main checks the pair too.
    const refused = await page.evaluate(() => window.shopot.retranscribe('original', 'gigaam', 'en').then(() => '', error => error.message));
    expect(refused).toContain('GigaAM распознаёт только русский');
    expect(await app.evaluate(() => globalThis.__test.requests.length)).toBe(0);
    // «Закрыть» hides the choice without starting anything.
    await detail(page).locator('[data-action="retranscribe-close"]').click();
    await expect(detail(page).locator('.retranscribe')).toHaveCount(0);

    await detail(page).locator('[data-action="retranscribe"]').click();
    await model.selectOption('small');
    await detail(page).locator('[data-action="retranscribe-start"]').click();
    await expect(detail(page).locator('.retranscribe-status')).toContainText('Распознаю заново · Лёгкая');
    await expect(detail(page).locator('[data-action="delete"]')).toBeDisabled();
    const deleting = await page.evaluate(() => window.shopot.deleteEntry('original').then(() => '', error => error.message));
    expect(deleting).toContain('Дождись конца повторного распознавания');

    await detail(page).locator('[data-action="retranscribe-cancel"]').click();
    await expect(page.locator('#toast')).toContainText('Повторное распознавание отменено');
    await expect(detail(page).locator('.retranscribe-status')).toHaveCount(0);
    expect(await notifications(app)).toContain('cancel');
    // A late answer from the engine makes no entry.
    await app.evaluate(() => globalThis.__test.resolve({text: 'Поздно', rawText: 'Поздно', duration: 2, elapsed: .3, model: 'small', words: []}));
    await page.waitForTimeout(300);
    expect(data.saved().history.map(e => e.id)).toEqual(['original']);
    await expect(page.locator('#history-list .history-row')).toHaveCount(1);
    await expect(detail(page).locator('[data-action="delete"]')).toBeEnabled();
    expect(data.journal()).toMatch(/ cancel phase=retranscribing$/m);
    expect(data.journal()).toMatch(/ retranscribe result=canceled model=small .*from=turbo preempted=false$/m);
  } finally { await app.close(); }
});

test('a dictation by the hotkey cancels the re-recognition and says so', async () => {
  const data = seed('retranscribe-preempt', [{id: 'original', age: DAY, audioFile: AUDIO}]);
  const {app, page} = await launch(data);
  try {
    await detail(page).locator('[data-action="retranscribe"]').click();
    await detail(page).locator('[data-action="retranscribe-start"]').click();
    await expect(detail(page).locator('.retranscribe-status')).toBeVisible();
    await app.evaluate(() => globalThis.__test.toggle());
    await expect(page.locator('#toast')).toContainText('Повторное распознавание отменено');
    await expect(detail(page).locator('.retranscribe-status')).toHaveCount(0);
    const commands = await notifications(app);
    expect(commands.indexOf('cancel')).toBeGreaterThanOrEqual(0);
    expect(commands.indexOf('preload')).toBeGreaterThan(commands.indexOf('cancel'));
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect.poll(() => app.windows().some(p => p.url().endsWith('/widget.html'))).toBe(true);
    const widget = app.windows().find(p => p.url().endsWith('/widget.html'));
    await expect(widget.locator('#label')).toHaveText('Повторное распознавание отменено');
    // After a few seconds the widget is an ordinary recording again.
    await expect(widget.locator('#label')).toHaveText('Слушаю тебя', {timeout: 6000});
    await app.evaluate(() => globalThis.__test.cancel());
    await expect(page.locator('#record-label')).toHaveText('Начать диктовку');
    expect(data.saved().history.map(e => e.id)).toEqual(['original']);
    expect(data.journal()).toMatch(/ retranscribe result=canceled model=turbo .*preempted=true$/m);
    expect(data.journal()).not.toMatch(/ cancel phase=retranscribing$/m);
  } finally { await app.close(); }
});

test('shared audio goes with the last entry that uses it; an entry without audio offers no re-recognition', async () => {
  const data = seed('retranscribe-delete', [{id: 'newest', age: 3600e3},
    {id: 'again', age: DAY, model: 'turbo', audioFile: AUDIO, retranscribed: {from: 'original', model: 'turbo'}},
    {id: 'original', age: DAY, audioFile: AUDIO}, {id: 'solo', age: 2 * DAY, audioFile: SOLO}]);
  const {app, page} = await launch(data);
  try {
    await app.evaluate(({dialog}) => { dialog.showMessageBox = async () => ({response: 1}); });
    await expect(detail(page).locator('[data-action="retranscribe"]')).toHaveCount(0);
    const remove = async id => { await page.locator(`[data-select-entry="${id}"]`).click(); await detail(page).locator('[data-action="delete"]').click();
      await expect(page.locator(`[data-select-entry="${id}"]`)).toHaveCount(0); };
    await remove('original');
    expect(fs.existsSync(path.join(data.audio, AUDIO))).toBe(true);
    await remove('again');
    expect(fs.existsSync(path.join(data.audio, AUDIO))).toBe(false);
    await remove('solo');
    expect(fs.existsSync(path.join(data.audio, SOLO))).toBe(false);
    expect(data.saved().history.map(e => e.id)).toEqual(['newest']);
  } finally { await app.close(); }
});
