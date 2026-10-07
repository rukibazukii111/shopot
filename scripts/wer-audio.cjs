// Records one recording as Shopot records the microphone, with one combination of Chromium's processing
// (PRD 6.19), for the WER measurement in scripts/wer_audio.py. The file stands in for the microphone through
// Chromium's fake capture, in real time, in a window that is never shown; no real microphone or speaker is used.
const {app, BrowserWindow, session} = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const MARK = 'SHOPOT_WER ';
const option = name => process.argv.find(value => value.startsWith(`--wer-${name}=`))?.slice(name.length + 7);
const parts = new Set((option('variant') || '').split('+'));
const wanted = {autoGainControl: parts.has('agc'), noiseSuppression: parts.has('ns'), echoCancellation: parts.has('ec')};

function finish(result) {
  process.stdout.write(`${MARK}${JSON.stringify(result)}\n`, () => app.exit(result.ok ? 0 : 1));
}

// Each process gets its own profile: parallel runs do not share caches, and the user's Electron folder stays untouched.
app.setPath('userData', option('profile'));
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
app.commandLine.appendSwitch('use-fake-device-for-media-stream');
app.commandLine.appendSwitch('use-file-for-fake-audio-capture', `${option('input')}%noloop`);
app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  app.dock?.hide();
  // As in the app: nothing from this session reaches the network.
  session.defaultSession.webRequest.onBeforeRequest({urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*']},
    (details, callback) => callback({cancel: true}));
  const win = new BrowserWindow({show: false, webPreferences: {backgroundThrottling: false}});
  try {
    await win.loadFile(path.join(__dirname, 'wer-audio.html'));
    const result = await win.webContents.executeJavaScript(`record(${JSON.stringify(wanted)}, ${Number(option('seconds'))})`);
    if (result.error) return finish({ok: false, error: result.error});
    const pieces = [];
    for (let i = 0; i < result.chunks; i++) {
      pieces.push(Buffer.from(await win.webContents.executeJavaScript(`chunk(${i})`), 'base64'));
    }
    fs.writeFileSync(option('output'), Buffer.concat(pieces));
    const same = Object.keys(wanted).every(key => result.settings[key] === wanted[key]);
    finish({ok: same, settings: result.settings, bytes: result.bytes,
      ...(same ? {} : {error: 'Chromium применил другие настройки обработки'})});
  } catch (error) {
    finish({ok: false, error: String(error?.message || error)});
  }
});
