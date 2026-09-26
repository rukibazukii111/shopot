// Only OS window identity and the standard paste shortcut cross this boundary.
// No text is typed as commands and Enter is never generated.
// Readable names for common Windows programs; anything else shows its executable name.
const WINDOWS_APP_NAMES = {
  'chrome.exe': 'Google Chrome', 'msedge.exe': 'Microsoft Edge', 'firefox.exe': 'Firefox', 'browser.exe': 'Яндекс Браузер',
  'telegram.exe': 'Telegram', 'code.exe': 'VS Code', 'cursor.exe': 'Cursor', 'winword.exe': 'Word', 'excel.exe': 'Excel',
  'powerpnt.exe': 'PowerPoint', 'outlook.exe': 'Outlook', 'olk.exe': 'Outlook', 'slack.exe': 'Slack', 'discord.exe': 'Discord',
  'notion.exe': 'Notion', 'obsidian.exe': 'Obsidian', 'notepad.exe': 'Блокнот', 'explorer.exe': 'Проводник',
  'windowsterminal.exe': 'Терминал', 'claude.exe': 'Claude', 'chatgpt.exe': 'ChatGPT', 'figma.exe': 'Figma',
};
function windowsBackend(koffi) {
  const lib = koffi.load('user32.dll');
  const kernel = koffi.load('kernel32.dll');
  const openProcess = kernel.func('uintptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const closeHandle = kernel.func('int __stdcall CloseHandle(uintptr_t handle)');
  const imageName = kernel.func('int __stdcall QueryFullProcessImageNameW(uintptr_t process, uint32_t flags, _Out_ uint16_t *name, _Inout_ uint32_t *size)');
  // The program behind a window, for per-app text settings. Unknown (null) is always acceptable.
  function appFor(pid) {
    try {
      const handle = openProcess(0x1000 /* PROCESS_QUERY_LIMITED_INFORMATION */, 0, pid);
      if (!handle) return null;
      try {
        const buffer = new Uint16Array(1024), size = [buffer.length];
        if (!imageName(handle, 0, buffer, size)) return null;
        const file = String.fromCharCode(...buffer.subarray(0, size[0])).split('\\').pop();
        const id = file.toLowerCase();
        return {id, name: WINDOWS_APP_NAMES[id] || file.replace(/\.exe$/i, '')};
      } finally { closeHandle(handle); }
    } catch { return null; }
  }
  const foreground = lib.func('uintptr_t __stdcall GetForegroundWindow()');
  const windowThread = lib.func('uint32_t __stdcall GetWindowThreadProcessId(uintptr_t hwnd, _Out_ uint32_t *pid)');
  const Rect = koffi.struct({left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t'});
  const Gui = koffi.struct({cbSize: 'uint32_t', flags: 'uint32_t', hwndActive: 'uintptr_t', hwndFocus: 'uintptr_t',
    hwndCapture: 'uintptr_t', hwndMenuOwner: 'uintptr_t', hwndMoveSize: 'uintptr_t', hwndCaret: 'uintptr_t', rcCaret: Rect});
  const guiInfo = lib.func('__stdcall', 'GetGUIThreadInfo', 'int', ['uint32_t', koffi.inout(koffi.pointer(Gui))]);
  const keyState = lib.func('int16_t __stdcall GetAsyncKeyState(int key)');
  const Mouse = koffi.struct({dx: 'int32_t', dy: 'int32_t', mouseData: 'uint32_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t'});
  const Key = koffi.struct({wVk: 'uint16_t', wScan: 'uint16_t', dwFlags: 'uint32_t', time: 'uint32_t', dwExtraInfo: 'uintptr_t'});
  const Hardware = koffi.struct({uMsg: 'uint32_t', wParamL: 'uint16_t', wParamH: 'uint16_t'});
  const Input = koffi.struct({type: 'uint32_t', u: koffi.union({mi: Mouse, ki: Key, hi: Hardware})});
  const sendInput = lib.func('__stdcall', 'SendInput', 'uint32_t', ['uint32_t', koffi.pointer(Input), 'int']);
  function capture() {
    const hwnd = foreground();
    const pid = [0]; const thread = windowThread(hwnd, pid);
    if (!hwnd || !thread || pid[0] === process.pid) return null;
    const info = {cbSize: koffi.sizeof(Gui)};
    return {hwnd, pid: pid[0], focus: guiInfo(thread, info) ? info.hwndFocus : 0, app: appFor(pid[0])};
  }
  const key = (wVk, up = false) => ({type: 1, u: {ki: {wVk, wScan: 0, dwFlags: up ? 2 : 0, time: 0, dwExtraInfo: 0}}});
  return {
    capture, appFor, release() {}, permitted: () => true,
    sameTarget(target) {
      const now = capture();
      if (!now || now.hwnd !== target.hwnd || now.pid !== target.pid) return false;
      // Some apps (Qt, custom-drawn UIs) do not report a focus window; the same top-level window is then enough.
      return !now.focus || !target.focus || now.focus === target.focus;
    },
    modifiersDown: () => [0x10, 0x11, 0x12, 0x5B, 0x5C].some(vk => (keyState(vk) & 0x8000) !== 0),
    paste: () => sendInput(4, [key(0x11), key(0x56), key(0x56, true), key(0x11, true)], koffi.sizeof(Input)) === 4,
  };
}

function macBackend(koffi) {
  // AppKit and Accessibility run in the Electron app, so macOS permissions belong to Shopot.
  const appKit = koffi.load('/System/Library/Frameworks/AppKit.framework/AppKit');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const services = koffi.load('/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const cls = objc.func('void *objc_getClass(const char *name)');
  const sel = objc.func('void *sel_registerName(const char *name)');
  const msg = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const msgInt = objc.func('objc_msgSend', 'int', ['void *', 'void *']);
  const trusted = services.func('bool AXIsProcessTrusted()');
  const axApp = services.func('void *AXUIElementCreateApplication(int pid)');
  const axValue = services.func('int AXUIElementCopyAttributeValue(void *element, void *attribute, _Out_ void **value)');
  const string = cf.func('void *CFStringCreateWithCString(void *allocator, const char *text, uint32_t encoding)');
  const release = cf.func('void CFRelease(void *value)');
  const equal = cf.func('bool CFEqual(void *a, void *b)');
  const flags = services.func('uint64_t CGEventSourceFlagsState(int state)');
  const event = services.func('void *CGEventCreateKeyboardEvent(void *source, uint16_t key, bool down)');
  const setFlags = services.func('void CGEventSetFlags(void *event, uint64_t flags)');
  const post = services.func('void CGEventPost(uint32_t tap, void *event)');
  const focusedAttribute = string(null, 'AXFocusedUIElement', 0x08000100);
  // Per-app text settings are optional: if this lookup fails, the app is unknown and paste still works.
  let msgText = null;
  try { msgText = objc.func('objc_msgSend', 'const char *', ['void *', 'void *']); } catch { msgText = null; }
  const frontApp = () => msg(msg(cls('NSWorkspace'), sel('sharedWorkspace')), sel('frontmostApplication'));
  function frontPid() { return msgInt(frontApp(), sel('processIdentifier')); }
  function appInfo() {
    try {
      const application = frontApp();
      const text = name => msgText(msg(application, sel(name)), sel('UTF8String'));
      const id = text('bundleIdentifier');
      return id ? {id: id.toLowerCase(), name: text('localizedName') || id} : null;
    } catch { return null; }
  }
  function focused(pid) {
    const application = axApp(pid); const out = [null];
    try { return axValue(application, focusedAttribute, out) === 0 ? out[0] : null; }
    finally { release(application); }
  }
  return {
    // Retain AppKit's library wrapper for the lifetime of this backend.
    appKit,
    permitted: trusted,
    capture() { const pid = frontPid(); return pid && pid !== process.pid ? {pid, focus: trusted() ? focused(pid) : null, app: msgText ? appInfo() : null} : null; },
    release(target) { if (target?.focus) release(target.focus); },
    sameTarget(target) {
      if (frontPid() !== target.pid) return false;
      // Many apps (Telegram, Electron apps without AX enabled) expose no focused element.
      // The same frontmost app is then enough; when both elements exist they must match.
      if (!target.focus) return true;
      const now = focused(target.pid);
      try { return !now || equal(now, target.focus); }
      finally { if (now) release(now); }
    },
    modifiersDown: () => (BigInt(flags(0)) & 0x1E0000n) !== 0n,
    paste() {
      const down = event(null, 9, true), up = event(null, 9, false);
      try {
        if (!down || !up) return false;
        setFlags(down, 0x100000); setFlags(up, 0x100000);
        post(0, down); post(0, up); return true;
      } finally { if (down) release(down); if (up) release(up); }
    },
  };
}

function createNativeBackend() {
  const koffi = require('koffi');
  if (process.platform === 'win32') return windowsBackend(koffi);
  if (process.platform === 'darwin') return macBackend(koffi);
  throw new Error('Автовставка поддерживается на Windows и macOS');
}
module.exports = {createNativeBackend};
