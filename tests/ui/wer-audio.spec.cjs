const {test, expect} = require('@playwright/test');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;

// 48 kHz mono 16-bit WAV: a 440 Hz tone every other half second over faint noise.
function tone(file, seconds) {
  const rate = 48000, count = Math.round(rate * seconds), data = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const on = Math.floor(i / (rate / 2)) % 2 === 0;
    const value = (on ? 0.3 * Math.sin(2 * Math.PI * 440 * i / rate) : 0) + (Math.random() - 0.5) * 0.004;
    data.writeInt16LE(Math.round(value * 32767), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + data.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34); header.write('data', 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

const off = {autoGainControl: false, noiseSuppression: false, echoCancellation: false};
const all = {autoGainControl: true, noiseSuppression: true, echoCancellation: true};
for (const [variant, settings] of [['none', off], ['agc+ns+ec', all]]) {
  test(`WER capture records a file through Chromium processing: ${variant}`, () => {
    const dir = path.join(root, '.private', 'ui-test', `wer-audio-${Date.now()}`);
    fs.mkdirSync(dir, {recursive: true});
    try {
      const input = path.join(dir, 'tone.wav'), output = path.join(dir, 'out.webm');
      tone(input, 2);
      const run = spawnSync(require('electron'), [path.join(root, 'scripts', 'wer-audio.cjs'), `--wer-input=${input}`,
        `--wer-output=${output}`, `--wer-variant=${variant}`, '--wer-seconds=2.5', `--wer-profile=${path.join(dir, 'profile')}`],
      {env, encoding: 'utf8', timeout: 60000, windowsHide: true});
      const line = run.stdout.split(/\r?\n/).find(text => text.startsWith('SHOPOT_WER '));
      expect(line, run.stdout + run.stderr).toBeTruthy();
      const report = JSON.parse(line.slice('SHOPOT_WER '.length));
      expect(report).toMatchObject({ok: true, settings});
      expect(report.startDelay).toBeLessThan(0.8);  // scripts/wer_audio.py MAX_START_DELAY
      expect(run.status).toBe(0);
      const bytes = fs.readFileSync(output);
      expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3');  // WebM starts with the EBML header
      expect(bytes.length).toBeGreaterThan(10000);  // 2.5 s at 96 kbit/s is about 30 KB
    } finally {
      // Chromium's helpers may hold the profile for a moment after Electron exits.
      fs.rmSync(dir, {recursive: true, force: true, maxRetries: 10, retryDelay: 200});
    }
  });
}
