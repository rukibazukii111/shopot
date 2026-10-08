// What a dictation shortcut may be. Electron accelerators are stored; keys come from KeyboardEvent.code,
// so a shortcut is the same physical keys on any keyboard layout.
const DEFAULT_HOTKEY = 'CommandOrControl+Shift+Space';
const ORDER = {win32: ['Control', 'Alt', 'Shift', 'Super'], darwin: ['Command', 'Control', 'Alt', 'Shift']};
const MODIFIER_LABELS = {win32: {Control: 'Ctrl', Alt: 'Alt', Shift: 'Shift', Super: 'Win'}, darwin: {Command: '⌘', Control: '⌃', Alt: '⌥', Shift: 'Shift'}};
// Virtual key codes of the modifiers for GetAsyncKeyState; Super stands for either Windows key.
const WINDOWS_MODIFIERS = {Control: 0x11, Alt: 0x12, Shift: 0x10, Super: 0x5B};
// Modifier bits of CGEventSourceFlagsState.
const MAC_MODIFIERS = {Shift: 0x20000n, Control: 0x40000n, Alt: 0x80000n, Command: 0x100000n};
// macOS virtual key codes (kVK_ANSI_*, kVK_F*).
const MAC_LETTERS = {A: 0, S: 1, D: 2, F: 3, H: 4, G: 5, Z: 6, X: 7, C: 8, V: 9, B: 11, Q: 12, W: 13, E: 14, R: 15, Y: 16, T: 17,
  O: 31, U: 32, I: 34, P: 35, L: 37, J: 38, K: 40, N: 45, M: 46};
const MAC_DIGITS = {1: 18, 2: 19, 3: 20, 4: 21, 5: 23, 6: 22, 7: 26, 8: 28, 9: 25, 0: 29};
const MAC_F = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90];
const PUNCTUATION = [['Minus', '-', 0xBD, 27], ['Equal', '=', 0xBB, 24], ['BracketLeft', '[', 0xDB, 33], ['BracketRight', ']', 0xDD, 30],
  ['Semicolon', ';', 0xBA, 41], ['Quote', "'", 0xDE, 39], ['Comma', ',', 0xBC, 43], ['Period', '.', 0xBE, 47],
  ['Slash', '/', 0xBF, 44], ['Backslash', '\\', 0xDC, 42], ['Backquote', '`', 0xC0, 50]];
// KeyboardEvent.code → [accelerator key, Windows virtual key, macOS key code or null]
const KEYS = new Map([
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => [`Key${l}`, [l, l.charCodeAt(0), MAC_LETTERS[l]]]),
  ...'0123456789'.split('').map(d => [`Digit${d}`, [d, d.charCodeAt(0), MAC_DIGITS[d]]]),
  ...Array.from({length: 24}, (_, i) => [`F${i + 1}`, [`F${i + 1}`, 0x70 + i, MAC_F[i] ?? null]]),
  ['Space', ['Space', 0x20, 49]], ['Tab', ['Tab', 0x09, 48]], ['Enter', ['Enter', 0x0D, 36]], ['Backspace', ['Backspace', 0x08, 51]],
  ['Delete', ['Delete', 0x2E, 117]], ['Insert', ['Insert', 0x2D, null]], ['Home', ['Home', 0x24, 115]], ['End', ['End', 0x23, 119]],
  ['PageUp', ['PageUp', 0x21, 116]], ['PageDown', ['PageDown', 0x22, 121]],
  ['ArrowLeft', ['Left', 0x25, 123]], ['ArrowUp', ['Up', 0x26, 126]], ['ArrowRight', ['Right', 0x27, 124]], ['ArrowDown', ['Down', 0x28, 125]],
  ...PUNCTUATION.map(([code, key, vk, mac]) => [code, [key, vk, mac]]),
]);
const BY_KEY = new Map([...KEYS.values()].map(entry => [entry[0], entry]));
const KEY_LABELS = {Delete: 'Del', Insert: 'Ins', PageUp: 'PgUp', PageDown: 'PgDn', Left: '←', Up: '↑', Right: '→', Down: '↓'};
// Keys that type a character: with Shift alone (or ⌥ on a Mac) they would stop the user typing it.
const TYPING = new Set([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', ...PUNCTUATION.map(entry => entry[1])]);
// Shortcuts other programs and the system need: copy, paste (Shopot pastes with it too), save, switching windows.
const DANGEROUS = {
  win32: new Set([...'ACVXZYSFNTWOP'.split('').map(k => `Control+${k}`), 'Alt+Tab', 'Alt+F4', 'Alt+Space']),
  darwin: new Set([...'ACVXZSFNTWOPQHM'.split('').map(k => `Command+${k}`), 'Command+Space', 'Command+Tab', 'Command+`',
    ...'345Z'.split('').map(k => `Command+Shift+${k}`), 'Control+Space', 'Command+Control+Space']),
};
const ERRORS = {
  modifier: {win32: 'Добавь Ctrl, Alt, Shift или Win', darwin: 'Добавь ⌘, ⌥, ⌃ или Shift'},
  key: 'Эту клавишу нельзя использовать. Выбери букву, цифру или F1–F24',
  taken: 'Это сочетание нужно другим программам. Выбери другое',
};

const os = platform => platform === 'darwin' ? 'darwin' : 'win32';
function parse(accelerator, platform) {
  if (typeof accelerator !== 'string' || accelerator.length > 100) return null;
  const parts = accelerator.split('+'), key = parts.pop(), mods = new Set();
  for (const part of parts) {
    const mod = part === 'CommandOrControl' ? (os(platform) === 'darwin' ? 'Command' : 'Control') : part;
    if (!ORDER[os(platform)].includes(mod) || mods.has(mod)) return null;
    mods.add(mod);
  }
  return BY_KEY.has(key) ? {mods, key} : null;
}
const canonical = ({mods, key}, platform) => [...ORDER[os(platform)].filter(mod => mods.has(mod)), key].join('+');
function problem(parsed, platform) {
  const system = os(platform), {mods, key} = parsed;
  if (!mods.size) return ERRORS.modifier[system];
  const shiftOnly = mods.size === 1 && mods.has('Shift') && !/^F\d+$/.test(key);
  // On a Mac ⌥ and ⌥Shift type special characters.
  const option = system === 'darwin' && mods.has('Alt') && [...mods].every(mod => mod === 'Alt' || mod === 'Shift') && TYPING.has(key);
  if (shiftOnly || option || DANGEROUS[system].has(canonical(parsed, platform))) return ERRORS.taken;
  return null;
}
function check(accelerator, platform) {
  const parsed = parse(accelerator, platform);
  return parsed ? problem(parsed, platform) : ERRORS.key;
}
function fromKeyEvent(event, platform) {
  const mac = os(platform) === 'darwin', mods = new Set();
  if (event.ctrlKey) mods.add('Control');
  if (event.altKey) mods.add('Alt');
  if (event.shiftKey) mods.add('Shift');
  if (event.metaKey) mods.add(mac ? 'Command' : 'Super');
  const entry = KEYS.get(String(event.code ?? ''));
  if (!mods.size) return {error: ERRORS.modifier[os(platform)]};
  if (!entry) return {error: ERRORS.key};
  const parsed = {mods, key: entry[0]}, error = problem(parsed, platform);
  return error ? {error} : {accelerator: canonical(parsed, platform)};
}
function same(a, b, platform) {
  const left = parse(a, platform), right = parse(b, platform);
  return Boolean(left && right) && canonical(left, platform) === canonical(right, platform);
}
function labels(accelerator, platform) {
  const parsed = parse(accelerator, platform);
  if (!parsed) return [];
  const names = MODIFIER_LABELS[os(platform)];
  return [...ORDER[os(platform)].filter(mod => parsed.mods.has(mod)).map(mod => names[mod]), KEY_LABELS[parsed.key] || parsed.key];
}
function windowsKeys(accelerator) {
  const parsed = parse(accelerator, 'win32');
  if (!parsed) return [];
  return [...ORDER.win32.filter(mod => parsed.mods.has(mod)).map(mod => WINDOWS_MODIFIERS[mod]), BY_KEY.get(parsed.key)[1]];
}
function macKeys(accelerator) {
  const parsed = parse(accelerator, 'darwin');
  if (!parsed) return {flags: 0n, key: null};
  return {flags: [...parsed.mods].reduce((flags, mod) => flags | MAC_MODIFIERS[mod], 0n), key: BY_KEY.get(parsed.key)[2]};
}
// A stored shortcut that no longer passes the rules (edited by hand, or written by another version) falls back to the default.
function normalize(value, platform) { return check(value, platform) === null ? value : DEFAULT_HOTKEY; }

module.exports = {DEFAULT_HOTKEY, parse, check, fromKeyEvent, same, labels, windowsKeys, macKeys, normalize};
