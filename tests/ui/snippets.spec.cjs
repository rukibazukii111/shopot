const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('snippets: added in the dictionary, saved to disk and sent with the dictation', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `snippets-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs'), '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream'],
    env: {...env, SHOPOT_DATA_DIR: dataDir}});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await page.locator('[data-page="dictionary"]').click();
    await page.locator('[data-dictionary-tab="snippets"]').click();
    await expect(page.locator('#add-label')).toHaveText('Добавить сниппет');
    await expect(page.locator('#dictionary-list')).toContainText('Сниппетов пока нет');
    await page.keyboard.press('Control+KeyN');
    await expect(page.locator('#snippet-trigger')).toBeFocused();
    await page.locator('#snippet-trigger').fill('Моя почта');
    await expect(page.locator('#save-snippet')).toBeDisabled();
    await page.locator('#snippet-text').fill('ivan@example.com');
    await page.locator('#snippet-text').press('Control+Enter');
    await expect(page.locator('[data-snippet-id]')).toContainText('Моя почта');
    // The same spoken phrase is refused before saving: case and commas do not matter.
    await page.locator('#add-word').click();
    await page.locator('#snippet-trigger').fill('моя, почта');
    await expect(page.locator('#snippet-error')).toContainText('Такая фраза уже есть');
    await expect(page.locator('#save-snippet')).toBeDisabled();
    const persisted = JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
    expect(persisted.snippets.map(s => [s.trigger, s.text])).toEqual([['Моя почта', 'ivan@example.com']]);
    // The words tab keeps its own list and form.
    await page.locator('[data-dictionary-tab="words"]').click();
    await expect(page.locator('#add-label')).toHaveText('Добавить слово');
    await expect(page.locator('#dictionary-form')).toBeVisible();
    await expect(page.locator('#snippet-form')).toBeHidden();
    // A dictation sends the snippets to the engine and shows which ones were used. The clipboard stays untouched.
    await page.evaluate(async () => { const boot = await window.shopot.boot(); await window.shopot.settings({...boot.settings, autoCopy: false}); });
    await page.locator('[data-page="dictation"]').click();
    await page.locator('#record-button').click();
    await expect(page.locator('#record-label')).toHaveText('Закончить запись');
    await expect(page.locator('#record-time')).not.toHaveText('00:00');
    await page.locator('#record-button').click();
    await expect.poll(() => app.evaluate(() => globalThis.__test.requests.length)).toBe(1);
    const request = await app.evaluate(() => globalThis.__test.requests[0]);
    expect(request.payload.snippets).toEqual([{trigger: 'Моя почта', text: 'ivan@example.com'}]);
    expect(request.payload.voiceCommands).toBe(true);
    await app.evaluate(() => globalThis.__test.resolve({text: 'Пиши на ivan@example.com.', rawText: 'Пиши на моя почта.',
      snippets: ['Моя почта'], words: [], duration: 2, elapsed: .1, model: 'gigaam', replacements: []}));
    await expect(page.locator('.transcript-editor')).toHaveValue('Пиши на ivan@example.com.');
    await expect(page.locator('#latest-result .replacements')).toContainText('Моя почта');
  } finally { await app.close(); }
});
