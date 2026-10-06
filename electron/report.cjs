// «Сообщить о проблеме» (PRD 6.27): a new GitHub issue in the user's own browser. Shopot sends nothing itself;
// the link carries a short form and the versions, never the journal, a path or anything the user said or typed.
const {repository} = require('../package.json');
const ISSUES = `${repository.url.replace(/\.git$/, '')}/issues/new`;

// `version` is process.getSystemVersion(): 10.0.26200 on Windows, 14.5.0 on macOS.
function systemName(platform, version) {
  if (platform === 'win32') {
    // Windows 11 still reports itself as 10.0; its builds start at 22000.
    const build = Number(String(version).split('.')[2]);
    return Number.isInteger(build) ? `Windows ${build >= 22000 ? 11 : 10} (${version})` : `Windows (${version})`;
  }
  if (platform === 'darwin') return `macOS ${version}`;
  return `${platform} ${version}`;
}

function issueBody({version, system, arch}) {
  return [
    '**Что делал:**', '', '',
    '**Что ожидал:**', '', '',
    '**Что случилось:**', '', '',
    '_Журнал можно приложить: перетащи файл сюда._', '',
    `Шёпот ${version} · ${system} · ${arch}`,
  ].join('\n');
}

function issueUrl(versions) { return `${ISSUES}?body=${encodeURIComponent(issueBody(versions))}`; }

module.exports = {ISSUES, systemName, issueBody, issueUrl};
