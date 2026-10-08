// Updates (PRD 6.26): which GitHub release this install may move to, and its installer with a verified checksum.
// Only main uses this module, through a session that reaches GitHub alone; the windows still have no network.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {EventEmitter} = require('node:events');
const {Readable, Transform} = require('node:stream');
const {pipeline} = require('node:stream/promises');
const {repository} = require('../package.json');

const REPO = new URL(repository.url.replace(/\.git$/, '')).pathname.slice(1);
const RELEASES_URL = `https://api.github.com/repos/${REPO}/releases?per_page=30`;
const DOWNLOADS = `https://github.com/${REPO}/releases/download/`;
// GitHub serves release files from github.com through a redirect to its file hosts.
const HOSTS = ['api.github.com', 'github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
const MESSAGES = {
  offline: 'Не удалось связаться с GitHub. Проверь интернет и попробуй ещё раз.',
  'rate-limit': 'GitHub временно ограничил проверки. Попробуй через час.',
  http: 'GitHub ответил неожиданно. Попробуй позже.',
  format: 'GitHub ответил неожиданно. Попробуй позже.',
  checksum: 'Файл обновления не прошёл проверку и удалён. Попробуй скачать ещё раз.',
  open: 'Не удалось открыть установщик',
};
class UpdateError extends Error {
  constructor(kind, code) { super(MESSAGES[kind]); this.kind = kind; if (code !== undefined) this.code = code; }
}

function parseVersion(text) {
  const clean = String(text ?? '').trim().replace(/^v/, '');
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(clean);
  return match && {core: match.slice(1, 4).map(Number), beta: match[4] === undefined ? null : Number(match[4]), text: clean};
}
// 1.0.0-beta.1 < 1.0.0-beta.2 < 1.0.0 < 1.0.1-beta.1
function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (a.beta === b.beta) return 0;
  if (a.beta === null) return 1;
  if (b.beta === null) return -1;
  return a.beta - b.beta;
}
// As electron-builder names them: artifactName in package.json.
function installerName(version, platform, arch) {
  const system = {win32: ['win', 'exe'], darwin: ['mac', 'dmg']}[platform];
  return system ? `Shopot-${version}-${system[0]}-${arch}.${system[1]}` : null;
}
// Release notes are Markdown; the banner shows plain text.
function notesText(body) {
  const text = String(body ?? '').replace(/\r\n?/g, '\n').split('\n')
    .map(line => line.replace(/^#{1,6}\s+/, '').replace(/^\s*[-*]\s+/, '• ').replace(/\*\*(.+?)\*\*/g, '$1')
      .replace(/`([^`]+)`/g, '$1').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').trimEnd())
    .join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return text.length > 1200 ? text.slice(0, 1200).replace(/\s+\S*$/, '') + ' …' : text;
}
const asset = (assets, name) => {
  const found = assets.find(item => item?.name === name);
  return found && typeof found.browser_download_url === 'string' && found.browser_download_url.startsWith(DOWNLOADS) ? found : null;
};
// The newest release this install may move to: a stable install sees stable releases only, a beta sees both.
function pickRelease(releases, {current, platform, arch, skipped = null, manual = false}) {
  const installed = parseVersion(current);
  if (!installed || !Array.isArray(releases)) return null;
  let best = null;
  for (const release of releases) {
    const version = parseVersion(release?.tag_name);
    if (!version || release.draft || compareVersions(version, installed) <= 0) continue;
    const beta = version.beta !== null;
    // The tag and GitHub's pre-release flag must agree, or the release is not trusted to be either.
    if (beta !== (release.prerelease === true) || (beta && installed.beta === null)) continue;
    const assets = Array.isArray(release.assets) ? release.assets : [];
    const installer = asset(assets, installerName(version.text, platform, arch)), sums = asset(assets, 'SHA256SUMS.txt');
    if (!installer || !sums) continue;
    if (!best || compareVersions(version, best.parsed) > 0) best = {parsed: version, release, installer, sums};
  }
  if (!best || (!manual && best.parsed.text === skipped)) return null;
  return {version: best.parsed.text, beta: best.parsed.beta !== null, notes: notesText(best.release.body),
    installer: {name: best.installer.name, url: best.installer.browser_download_url, size: Number(best.installer.size) || 0},
    sums: best.sums.browser_download_url};
}
// SHA256SUMS.txt as scripts/checksum-release.cjs writes it: "<hash>  <file>" per line.
function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})\s+\*?(\S.*)$/i.exec(line.trim());
    if (match) sums.set(match[2], match[1].toLowerCase());
  }
  return sums;
}
function allowedUrl(url) {
  try { const parsed = new URL(url); return parsed.protocol === 'https:' && HOSTS.includes(parsed.hostname); } catch { return false; }
}

// The offer shown in the main window and its installer. States: none, available, downloading, ready;
// `hidden` is «Позже» until the next check, `error` a failed download.
class Updater extends EventEmitter {
  constructor({fetch, dir, current, platform, arch}) {
    super();
    Object.assign(this, {fetchImpl: fetch, dir, current, platform, arch});
    this.offer = null; this.ready = null; this.checking = null; this.downloading = null;
    this.state = {phase: 'none', hidden: false};
  }
  set(state) { this.state = state; this.emit('state', state); }
  offerState(extra = {}) {
    const {version, beta, notes} = this.offer;
    return {phase: this.ready?.version === version ? 'ready' : 'available', version, beta, notes, hidden: false, ...extra};
  }
  async request(url, init = {}) {
    // 30 s for a check or the sums; the installer passes `signal: null` and has no overall limit.
    const signal = 'signal' in init ? init.signal ?? undefined : AbortSignal.timeout(30000);
    let response;
    try { response = await this.fetchImpl(url, {...init, signal}); }
    catch (error) { throw new UpdateError('offline', error?.code ?? error?.cause?.code); }
    if ([403, 429].includes(response.status)) throw new UpdateError('rate-limit', response.status);
    if (!response.ok) throw new UpdateError('http', response.status);
    return response;
  }
  // One check at a time; a download in progress is left alone.
  check({manual = false, skipped = null} = {}) {
    this.checking ??= (async () => {
      let releases;
      try { releases = await (await this.request(RELEASES_URL, {headers: {accept: 'application/vnd.github+json'}})).json(); }
      catch (error) { throw error instanceof UpdateError ? error : new UpdateError('format'); }
      const offer = pickRelease(releases, {current: this.current, platform: this.platform, arch: this.arch, skipped, manual});
      if (this.downloading) return offer;
      if (!offer) { this.offer = null; this.set({phase: 'none', hidden: false}); return null; }
      if (this.ready && this.ready.version !== offer.version) this.ready = null;
      this.offer = offer; this.set(this.offerState());
      return offer;
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  hide() { if (this.state.phase !== 'none') this.set({...this.state, hidden: true}); }
  readyFile() { return this.ready && fs.existsSync(this.ready.file) ? this.ready.file : null; }
  download() {
    if (!this.offer) return Promise.resolve();
    this.downloading ??= this.fetchInstaller(this.offer).finally(() => { this.downloading = null; });
    return this.downloading;
  }
  async fetchInstaller(offer) {
    const file = path.join(this.dir, offer.installer.name), part = file + '.part';
    this.set(this.offerState({phase: 'downloading', progress: 0}));
    try {
      fs.mkdirSync(this.dir, {recursive: true});
      const expected = parseSums(await (await this.request(offer.sums)).text()).get(offer.installer.name);
      if (!expected) throw new UpdateError('format');
      const response = await this.request(offer.installer.url, {signal: null});
      const total = Number(response.headers.get('content-length')) || offer.installer.size;
      const hash = crypto.createHash('sha256');
      let received = 0, shown = 0;
      const count = new Transform({transform: (chunk, _, done) => {
        hash.update(chunk); received += chunk.length;
        const progress = total ? Math.min(99, Math.floor(received / total * 100)) : 0;
        if (progress !== shown) { shown = progress; this.set(this.offerState({phase: 'downloading', progress})); }
        done(null, chunk);
      }});
      try { await pipeline(Readable.fromWeb(response.body), count, fs.createWriteStream(part)); }
      catch (error) { throw new UpdateError('offline', error?.code); }
      if (hash.digest('hex') !== expected) throw new UpdateError('checksum');
      fs.renameSync(part, file);
      this.ready = {version: offer.version, file};
      this.set(this.offerState());
    } catch (error) {
      fs.rmSync(part, {force: true});
      this.set(this.offerState({error: error.message}));
      throw error;
    }
  }
  // Installers left by the previous update; one still held by a finishing installer stays until next time.
  clean() {
    let names = [];
    try { names = fs.readdirSync(this.dir); } catch { return; }
    for (const name of names) { try { fs.rmSync(path.join(this.dir, name), {force: true}); } catch {} }
  }
}

// Windows: electron-builder's NSIS installer, silent, into the folder the app is in now, then starts Shopot again.
// macOS: the DMG opens; the user drags Shopot into Applications.
async function launchInstaller(file, platform, {spawn, openPath}) {
  if (platform === 'win32') { spawn(file, ['--updated', '/S', '--force-run'], {detached: true, stdio: 'ignore'}).unref(); return 'quit'; }
  if (await openPath(file)) throw new UpdateError('open');
  return 'opened';
}

module.exports = {REPO, RELEASES_URL, UpdateError, Updater, launchInstaller, parseVersion, compareVersions, installerName, notesText, pickRelease, parseSums, allowedUrl};
