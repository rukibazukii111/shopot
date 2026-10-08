const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {timestamp} = require('../../electron/log.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const DAY = 864e5;
// How long a seeded entry has left before its period ends: room for a slow start and first render on CI.
const MARGIN = 20e3;

// A data folder as an earlier run left it: history of the given ages, pending recordings and a journal line.
function seed(name, {days, history, pending = [], logAge}) {
  const dataDir = path.join(root, '.private', 'ui-test', `${name}-${Date.now()}`);
  const audio = path.join(dataDir, 'audio'), logs = path.join(dataDir, 'logs');
  fs.mkdirSync(audio, {recursive: true}); fs.mkdirSync(logs, {recursive: true});
  const entry = ({id, age, text, audioFile = null}) => ({id, createdAt: new Date(Date.now() - age).toISOString(), source: 'Микрофон', text, rawText: text,
    words: [], duration: 2, elapsed: .2, model: 'gigaam', mode: 'natural', replacements: [], audioFile});
  for (const file of [...history, ...pending].map(e => e.audioFile).filter(Boolean)) fs.writeFileSync(path.join(audio, file), 'audio');
  fs.writeFileSync(path.join(dataDir, 'store.json'), JSON.stringify({version: 1, settings: {historyDays: days}, dictionary: [], history: history.map(entry),
    pendingRecordings: pending.map(({id, age, audioFile}) => ({id, audioFile, source: 'Незавершённая запись', createdAt: new Date(Date.now() - age).toISOString()}))}));
  if (logAge) fs.writeFileSync(path.join(logs, 'shopot.log'), `${timestamp(new Date(Date.now() - logAge))} quit uptime=1\n`);
  return {dataDir, audio, saved: () => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8')),
    journal: () => fs.readFileSync(path.join(logs, 'shopot.log'), 'utf8')};
}
// Answers the confirmation with «Оставить» (0) or «Удалить» (1) and keeps what it asked.
const answer = (app, response) => app.evaluate(({dialog}, value) => {
  globalThis.__asked ??= [];
  dialog.showMessageBox = async (window, options) => { globalThis.__asked.push(options); return {response: value}; };
}, response);
const asked = app => app.evaluate(() => (globalThis.__asked || []).map(options => ({message: options.message, detail: options.detail, buttons: options.buttons})));

test('history past its period goes with its audio at start, a shorter period asks first, pending recordings stay', async () => {
  const oldAudio = 'a1b2c3d4-0000-4000-8000-000000000001.webm', pendingAudio = 'a1b2c3d4-0000-4000-8000-000000000002.webm';
  const data = seed('retention', {days: 30, logAge: 40 * DAY,
    history: [{id: 'fresh', age: 3600e3, text: 'Свежая запись'}, {id: 'mid', age: 10 * DAY, text: 'Запись недельной давности'},
      {id: 'old', age: 40 * DAY, text: 'Старая запись', audioFile: oldAudio}],
    pending: [{id: 'pending', age: 40 * DAY, audioFile: pendingAudio}]});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: data.dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    // At start: the 40-day entry and its audio are gone; the pending recording of the same age stays with its audio.
    expect(data.saved().history.map(e => e.id)).toEqual(['fresh', 'mid']);
    expect(fs.existsSync(path.join(data.audio, oldAudio))).toBe(false);
    expect(fs.existsSync(path.join(data.audio, pendingAudio))).toBe(true);
    await expect(page.locator('#recovery-banner')).toBeVisible();
    // The journal follows the same period and says how many entries went, not which.
    const journal = data.journal();
    expect(journal).not.toContain('quit uptime=1');
    expect(journal).toMatch(/ history-prune trigger=start days=30 removed=1$/m);
    expect(journal).not.toContain('Старая запись');

    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-list .history-row')).toHaveCount(2);
    await page.locator('[data-select-entry="mid"]').click();
    await expect(page.locator('#history-detail .history-editor')).toHaveValue('Запись недельной давности');

    await page.locator('[data-page="settings"]').click();
    const select = page.locator('#history-days');
    await expect(select).toHaveValue('30');
    await expect(page.locator('section[aria-label="Система"]')).toContainText('Записи старше срока удаляются сами вместе с аудио');

    // «Оставить» keeps the old period and the entry.
    await answer(app, 0);
    await select.selectOption('7');
    await expect.poll(() => asked(app)).toEqual([{message: 'Удалить 1 запись старше 7 дней?',
      detail: 'Текст и сохранённое аудио будут удалены с этого компьютера. Незавершённые записи останутся.', buttons: ['Оставить', 'Удалить']}]);
    await expect(select).toHaveValue('30');
    expect(data.saved().settings.historyDays).toBe(30);
    expect(data.saved().history.map(e => e.id)).toEqual(['fresh', 'mid']);

    // «Удалить» removes it at once; the history shows the next entry instead, as after deleting one by hand.
    await answer(app, 1);
    await select.selectOption('7');
    await expect.poll(() => data.saved().history.map(e => e.id)).toEqual(['fresh']);
    await expect(select).toHaveValue('7');
    expect(data.saved().settings.historyDays).toBe(7);
    expect(data.journal()).toMatch(/ history-prune trigger=setting days=7 removed=1$/m);
    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-list .history-row')).toHaveCount(1);
    await expect(page.locator('#history-detail .history-editor')).toHaveValue('Свежая запись');
    await expect(page.locator('#toast')).toBeHidden();

    // A longer period, or none, never asks and removes nothing.
    await page.locator('[data-page="settings"]').click();
    await select.selectOption('30');
    await expect(select).toHaveValue('30');
    await select.selectOption('0');
    await expect.poll(() => data.saved().settings.historyDays).toBe(0);
    expect((await asked(app)).length).toBe(2);
    expect(data.saved().history.map(e => e.id)).toEqual(['fresh']);
  } finally { await app.close(); }
});

test('a running app removes history once it passes its period, without a restart', async () => {
  const data = seed('retention-daily', {days: 7, history: [{id: 'edge', age: 7 * DAY - MARGIN, text: 'Запись на краю срока'}]});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: data.dataDir, SHOPOT_HISTORY_PRUNE_MS: '500'}});
  try {
    const page = await app.firstWindow();
    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-list .history-row')).toHaveCount(1);
    await expect(page.locator('#history-list .history-row')).toHaveCount(0, {timeout: MARGIN + 10000});
    expect(data.saved().history).toEqual([]);
    // The timer removed it, not the start.
    expect(data.journal()).toMatch(/ history-prune trigger=daily days=7 removed=1$/m);
    expect(data.journal()).not.toContain('trigger=start');
  } finally { await app.close(); }
});

test('with «Всегда» nothing expires, neither history nor the journal', async () => {
  const data = seed('retention-always', {days: 0, logAge: 400 * DAY, history: [{id: 'ancient', age: 400 * DAY, text: 'Очень старая запись'}]});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: data.dataDir, SHOPOT_HISTORY_PRUNE_MS: '500'}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await page.waitForTimeout(1500);
    expect(data.saved().history.map(e => e.id)).toEqual(['ancient']);
    expect(data.journal()).toContain('quit uptime=1');
    expect(data.journal()).not.toContain('history-prune');
    await page.locator('[data-page="settings"]').click();
    await expect(page.locator('#history-days')).toHaveValue('0');
  } finally { await app.close(); }
});

test('a setting saved while the confirmation is open survives «Удалить»', async () => {
  const data = seed('retention-race', {days: 30, history: [{id: 'fresh', age: 3600e3, text: 'Свежая запись'}, {id: 'mid', age: 10 * DAY, text: 'Запись недельной давности'}]});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: data.dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    // The confirmation stays open until the test answers it.
    await app.evaluate(({dialog}) => {
      dialog.showMessageBox = () => new Promise(resolve => { globalThis.__answer = response => resolve({response}); });
    });
    await page.locator('[data-page="settings"]').click();
    await page.locator('#history-days').selectOption('7');
    await expect.poll(() => app.evaluate(() => typeof globalThis.__answer)).toBe('function');
    // Another setting is saved meanwhile, as a finished model download or the widget's «Не предлагать» would.
    await page.locator('#keep-audio').check();
    await expect.poll(() => data.saved().settings.keepAudio).toBe(true);
    await app.evaluate(() => globalThis.__answer(1));
    await expect.poll(() => data.saved().history.map(e => e.id)).toEqual(['fresh']);
    expect(data.saved().settings).toMatchObject({historyDays: 7, keepAudio: true});
    await expect(page.locator('#history-days')).toHaveValue('7');
    await expect(page.locator('#keep-audio')).toBeChecked();
  } finally { await app.close(); }
});

test('an entry whose audio cannot be deleted stays until a later run; audio another entry keeps stays', async () => {
  const locked = 'a1b2c3d4-0000-4000-8000-000000000011.webm', shared = 'a1b2c3d4-0000-4000-8000-000000000012.webm';
  const data = seed('retention-locked', {days: 7, history: [{id: 'keeper', age: 3600e3, text: 'Свежая запись', audioFile: shared},
    {id: 'twin', age: 40 * DAY, text: 'Старая копия', audioFile: shared}, {id: 'locked', age: 40 * DAY, text: 'Запись с занятым аудио'}]});
  // A folder in place of the audio file: deleting it as a file fails, as for a file another program holds.
  fs.mkdirSync(path.join(data.audio, locked));
  const store = data.saved(); store.history[2].audioFile = locked;
  fs.writeFileSync(path.join(data.dataDir, 'store.json'), JSON.stringify(store));
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: data.dataDir, SHOPOT_HISTORY_PRUNE_MS: '500'}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    // The expired twin goes, but the audio the fresh entry still uses stays.
    expect(data.saved().history.map(e => e.id)).toEqual(['keeper', 'locked']);
    expect(fs.existsSync(path.join(data.audio, shared))).toBe(true);
    await page.waitForTimeout(1200);
    expect(data.saved().history.map(e => e.id)).toEqual(['keeper', 'locked']);
    await expect(page.locator('#recovery-banner')).toBeHidden();
    // Once the audio can go, the next run removes the entry.
    fs.rmSync(path.join(data.audio, locked), {recursive: true});
    await expect.poll(() => data.saved().history.map(e => e.id), {timeout: 10000}).toEqual(['keeper']);
    expect(fs.existsSync(path.join(data.audio, shared))).toBe(true);
    expect(data.journal()).toMatch(/ history-prune trigger=daily days=7 removed=1$/m);
    expect(data.journal()).not.toContain('занятым');
  } finally { await app.close(); }
});

test('history past its period goes when the computer wakes, before the daily timer', async () => {
  const seeded = Date.now();
  const data = seed('retention-resume', {days: 7, history: [{id: 'edge', age: 7 * DAY - MARGIN, text: 'Запись на краю срока'}]});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: data.dataDir}});
  try {
    const page = await app.firstWindow();
    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-list .history-row')).toHaveCount(1);
    // The entry passes its period while the computer sleeps; the default timer is a day away.
    await page.waitForTimeout(Math.max(0, seeded + MARGIN + 500 - Date.now()));
    expect(data.saved().history.map(e => e.id)).toEqual(['edge']);
    await app.evaluate(({powerMonitor}) => powerMonitor.emit('resume'));
    await expect(page.locator('#history-list .history-row')).toHaveCount(0);
    expect(data.saved().history).toEqual([]);
    expect(data.journal()).toMatch(/ history-prune trigger=daily days=7 removed=1$/m);
    expect(data.journal()).not.toContain('trigger=start');
  } finally { await app.close(); }
});

test('a failed removal after «Удалить» shows the stored period and history, and a later save keeps the period', async () => {
  const midAudio = 'a1b2c3d4-0000-4000-8000-000000000021.webm';
  const data = seed('retention-save-fails', {days: 30, history: [{id: 'fresh', age: 3600e3, text: 'Свежая запись'},
    {id: 'mid', age: 10 * DAY, text: 'Запись недельной давности', audioFile: midAudio}]});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: data.dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    // The period is saved, then the save that removes the entry fails once, as when an antivirus holds store.json.
    await app.evaluate(() => {
      const fs = process.mainModule.require('node:fs'), rename = fs.renameSync;
      let saves = 0;
      fs.renameSync = (from, to) => {
        if (String(to).endsWith('store.json') && ++saves === 2) throw Object.assign(new Error('busy'), {code: 'EBUSY'});
        return rename(from, to);
      };
    });
    await answer(app, 1);
    await page.locator('[data-page="settings"]').click();
    const select = page.locator('#history-days');
    await select.selectOption('7');
    await expect(page.locator('#error-text')).toHaveText('Не удалось удалить старые записи');
    await expect(select).toHaveValue('7');
    expect(data.saved().settings.historyDays).toBe(7);
    expect(data.saved().history.map(e => e.id)).toEqual(['fresh', 'mid']);
    expect(data.journal()).toMatch(/ ipc-error channel=settings .*code=EBUSY/m);
    expect(data.journal()).not.toContain('недельной');
    await page.locator('[data-page="history"]').click();
    await expect(page.locator('#history-list .history-row')).toHaveCount(2);
    // Another setting saved later keeps the period that is stored.
    await page.locator('[data-page="settings"]').click();
    await page.locator('#keep-audio').check();
    await expect.poll(() => data.saved().settings.keepAudio).toBe(true);
    expect(data.saved().settings.historyDays).toBe(7);
  } finally { await app.close(); }
});
