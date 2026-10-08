// Updates (PRD 6.26): which GitHub release this install may move to, and its installer with a verified checksum.
// Only main uses this module, through a session that reaches GitHub alone; the windows still have no network.
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
  constructor(kind, code) { super(MESSAGES[kind]); this.name = 'UpdateError'; this.kind = kind; if (code !== undefined) this.code = code; }
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

module.exports = {REPO, RELEASES_URL, UpdateError, parseVersion, compareVersions, installerName, notesText, pickRelease, parseSums, allowedUrl};
