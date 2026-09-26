const {test, expect, _electron: electron} = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const {Store} = require('../../electron/store.cjs');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

test('fixing a misheard word offers to remember it in the dictionary', async () => {
  const dataDir = path.join(root, '.private', 'ui-test', `corrections-${Date.now()}`);
  fs.mkdirSync(dataDir, {recursive: true});
  const store = new Store(dataDir);
  store.addHistory({id: 'fix-me', createdAt: '2026-09-26T09:00:00Z', source: 'Микрофон', text: 'Залей видосы на гитхаб.',
    rawText: 'Залей видосы на гитхаб.', words: [], duration: 2, elapsed: .2, model: 'gigaam', mode: 'natural', replacements: [], audioFile: null});
  const app = await electron.launch({args: [path.join(root, 'tests/fixtures/harness.cjs')], env: {...env, SHOPOT_DATA_DIR: dataDir}});
  const saved = () => JSON.parse(fs.readFileSync(path.join(dataDir, 'store.json'), 'utf8'));
  try {
    const page = await app.firstWindow();
    await expect(page.locator('#engine-label')).toHaveText('Локальный движок');
    await page.locator('[data-page="history"]').click();
    const editor = page.locator('#history-detail .history-editor');
    const strip = page.locator('#history-detail .suggestions');
    await expect(strip).toBeHidden();
    await editor.fill('Залей видосы на GitHub.');
    await editor.blur();
    await expect(strip).toContainText('гитхаб → GitHub');
    await strip.locator('[data-add-suggestion="0"]').click();
    await expect(strip).toBeHidden();
    // GitHub is already in the starter dictionary: the misheard form joins it as a replacement.
    expect(saved().dictionary.find(e => e.word === 'GitHub').aliases).toEqual(['гитхаб']);
    expect(saved().history[0].text).toBe('Залей видосы на GitHub.');
    // A fix the user does not want remembered is dismissed without touching the dictionary.
    await editor.fill('Залей видео на GitHub.');
    await editor.blur();
    await expect(strip).toContainText('видосы → видео');
    await strip.locator('[data-dismiss-suggestions]').click();
    await expect(strip).toBeHidden();
    expect(saved().dictionary.some(e => e.word === 'видео')).toBe(false);
    expect(saved().history[0].text).toBe('Залей видео на GitHub.');
  } finally { await app.close(); }
});
