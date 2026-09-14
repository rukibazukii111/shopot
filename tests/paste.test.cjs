const {test} = require('node:test');
const assert = require('node:assert/strict');
const {PasteService} = require('../electron/paste.cjs');
function fixture(overrides = {}, wait) {
  let clipboardText = 'previous', inputs = 0;
  const clipboard = {writeText: async text => { clipboardText = text; }, readText: async () => clipboardText};
  const native = {capture: () => ({pid: 42}), release() {}, permitted: () => true,
    sameTarget: () => true, modifiersDown: () => false, paste: () => { inputs++; return true; }, ...overrides};
  return {service: new PasteService({clipboard, native, wait}), clipboard, inputs: () => inputs};
}
const settings = {autoCopy: false, autoPaste: true, target: {pid: 42}};
test('global dictation copies Unicode and requests one paste; manual mode does not inject keys', async () => {
  const f = fixture();
  const result = await f.service.deliver('Видосы для GitHub готовы.', settings);
  assert.equal(result.pasted, true); assert.equal(f.inputs(), 1);
  assert.equal(await f.clipboard.readText(), 'Видосы для GitHub готовы.');
  await f.service.deliver('Manual', {...settings, autoPaste: false, autoCopy: false});
  assert.equal(f.inputs(), 1); assert.equal(await f.clipboard.readText(), 'Видосы для GitHub готовы.');
});
for (const [name, overrides, code] of [
  ['changed foreground window', {sameTarget: () => false}, 'focus-changed'],
  ['missing macOS permission', {permitted: () => false}, 'permission'],
  ['held modifiers', {modifiersDown: () => true}, 'modifiers'],
]) test(`${name} keeps text available without injecting keys`, async () => {
  const f = fixture(overrides, async () => {});
  assert.equal((await f.service.deliver('Текст', settings)).code, code);
  assert.equal(f.inputs(), 0); assert.equal(await f.clipboard.readText(), 'Текст');
});
test('cancellation during modifier release wait prevents a delayed paste', async () => {
  let active = true, held = true;
  const f = fixture({modifiersDown: () => held}, async () => { held = false; active = false; });
  assert.equal((await f.service.deliver('Текст', settings, () => active)).code, 'canceled');
  assert.equal(f.inputs(), 0);
});
test('clipboard changed by another app during wait is neither replaced nor pasted', async () => {
  let held = true;
  const f = fixture({modifiersDown: () => held}, async () => { held = false; f.clipboard.writeText('new clipboard'); });
  assert.equal((await f.service.deliver('Текст', settings)).code, 'clipboard-changed');
  assert.equal(f.inputs(), 0); assert.equal(await f.clipboard.readText(), 'new clipboard');
});
test('failed native input is reported as a copy fallback', async () => {
  const f = fixture({paste: () => false});
  assert.equal((await f.service.deliver('Текст', settings)).code, 'blocked');
});
