const {test} = require('node:test');
const assert = require('node:assert/strict');
const h = require('../electron/hotkey.cjs');
const ev = (code, mods = {}) => ({code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods});

test('a key with a modifier becomes an accelerator', () => {
  assert.deepEqual(h.fromKeyEvent(ev('KeyK', {ctrlKey: true, altKey: true}), 'win32'), {accelerator: 'Control+Alt+K'});
  assert.deepEqual(h.fromKeyEvent(ev('Digit7', {metaKey: true, shiftKey: true}), 'darwin'), {accelerator: 'Command+Shift+7'});
  assert.deepEqual(h.fromKeyEvent(ev('F9', {shiftKey: true}), 'win32'), {accelerator: 'Shift+F9'});
  assert.deepEqual(h.fromKeyEvent(ev('Space', {metaKey: true}), 'win32'), {accelerator: 'Super+Space'});
  assert.deepEqual(h.fromKeyEvent(ev('Slash', {ctrlKey: true, shiftKey: true}), 'win32'), {accelerator: 'Control+Shift+/'});
});
test('single keys, unknown keys and dangerous combos are refused with a message', () => {
  assert.equal(h.fromKeyEvent(ev('KeyK'), 'win32').error, 'Добавь Ctrl, Alt, Shift или Win');
  assert.equal(h.fromKeyEvent(ev('KeyK'), 'darwin').error, 'Добавь ⌘, ⌥, ⌃ или Shift');
  assert.equal(h.fromKeyEvent(ev('Numpad5', {ctrlKey: true}), 'win32').error, 'Эту клавишу нельзя использовать. Выбери букву, цифру или F1–F24');
  assert.equal(h.fromKeyEvent(ev('Escape', {ctrlKey: true}), 'win32').error, 'Эту клавишу нельзя использовать. Выбери букву, цифру или F1–F24');
  const busy = 'Это сочетание нужно другим программам. Выбери другое';
  for (const [code, mods, platform] of [
    ['KeyC', {ctrlKey: true}, 'win32'], ['KeyV', {ctrlKey: true}, 'win32'], ['KeyS', {ctrlKey: true}, 'win32'],
    ['Tab', {altKey: true}, 'win32'], ['F4', {altKey: true}, 'win32'], ['KeyA', {shiftKey: true}, 'win32'], ['Space', {shiftKey: true}, 'win32'],
    ['KeyV', {metaKey: true}, 'darwin'], ['Space', {metaKey: true}, 'darwin'], ['Digit4', {metaKey: true, shiftKey: true}, 'darwin'],
    ['Space', {ctrlKey: true}, 'darwin'], ['KeyE', {altKey: true}, 'darwin'], ['KeyE', {altKey: true, shiftKey: true}, 'darwin'],
  ]) assert.equal(h.fromKeyEvent(ev(code, mods), platform).error, busy, `${code} ${JSON.stringify(mods)} ${platform}`);
  // Ctrl+Shift+C is not on the list; ⌥Space and Shift+F-keys are allowed.
  assert.ok(h.fromKeyEvent(ev('KeyC', {ctrlKey: true, shiftKey: true}), 'win32').accelerator);
  assert.ok(h.fromKeyEvent(ev('Space', {altKey: true}), 'darwin').accelerator);
});
test('the default and its platform spelling are the same shortcut', () => {
  assert.ok(h.same(h.DEFAULT_HOTKEY, 'Control+Shift+Space', 'win32'));
  assert.ok(h.same(h.DEFAULT_HOTKEY, 'Command+Shift+Space', 'darwin'));
  assert.ok(!h.same(h.DEFAULT_HOTKEY, 'Control+Shift+Space', 'darwin'));
});
test('labels follow the platform', () => {
  assert.deepEqual(h.labels(h.DEFAULT_HOTKEY, 'win32'), ['Ctrl', 'Shift', 'Space']);
  assert.deepEqual(h.labels(h.DEFAULT_HOTKEY, 'darwin'), ['⌘', 'Shift', 'Space']);
  assert.deepEqual(h.labels('Super+Alt+Up', 'win32'), ['Alt', 'Win', '↑']);
  assert.deepEqual(h.labels('Control+Alt+PageDown', 'darwin'), ['⌃', '⌥', 'PgDn']);
});
test('key codes for the hold check', () => {
  assert.deepEqual(h.windowsKeys('Control+Shift+Space'), [0x11, 0x10, 0x20]);
  assert.deepEqual(h.windowsKeys('Alt+Super+F13'), [0x12, 0x5B, 0x7C]);
  assert.deepEqual(h.macKeys('Command+Shift+Space'), {flags: 0x120000n, key: 49});
  assert.deepEqual(h.macKeys('Control+Alt+K'), {flags: 0xC0000n, key: 40});
  assert.equal(h.macKeys('Command+F24').key, null);
});
test('a broken or dangerous stored value falls back to the default', () => {
  for (const value of [undefined, 42, '', 'Control+', 'Control+C', 'K', 'Control+Shift+Space+X'])
    assert.equal(h.normalize(value, 'win32'), h.DEFAULT_HOTKEY, String(value));
  assert.equal(h.normalize('Control+Alt+K', 'win32'), 'Control+Alt+K');
});
