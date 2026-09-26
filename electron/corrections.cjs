// Dictionary suggestions from the user's own corrections of a transcript: «гитхаб» → «GitHub».
// Only a word-level substitution of 1–3 words counts; a rewrite, punctuation or a lone capital does not.
const WORD = /[\p{L}\p{N}](?:[\p{L}\p{N}'’+#.-]*[\p{L}\p{N}+#])?/gu;
const MAX_WORDS = 3;

function words(text) { return String(text).match(WORD) || []; }
function fold(value) { return String(value).toLocaleLowerCase('ru').replace(/ё/g, 'е'); }

// Replaced runs between two word lists: common head and tail first (edits are local), then an LCS on the rest.
function replacedRuns(before, after) {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let endBefore = before.length, endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) { endBefore--; endAfter--; }
  const a = before.slice(start, endBefore), b = after.slice(start, endAfter);
  if (a.length > 300 || b.length > 300) return [];
  const table = Array.from({length: a.length + 1}, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
  }
  const runs = [];
  let i = 0, j = 0, removed = [], added = [];
  const flush = () => { if (removed.length && added.length) runs.push({from: removed, to: added}); removed = []; added = []; };
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { flush(); i++; j++; }
    else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) added.push(b[j++]);
    else removed.push(a[i++]);
  }
  flush();
  return runs;
}

function suggestCorrections(before, after, dictionary = []) {
  const suggestions = [];
  for (const {from, to} of replacedRuns(words(before), words(after))) {
    if (from.length > MAX_WORDS || to.length > MAX_WORDS || [...from, ...to].some(w => /^\p{N}+$/u.test(w))) continue;
    const alias = from.join(' '), word = to.join(' ');
    if (alias.length > 80 || word.length > 80) continue;
    const caseOnly = fold(alias) === fold(word);
    // A case-only fix matters for unusual spellings (iPhone, GitHub, NASA), not for a capital at a sentence start.
    if (caseOnly && !/\p{Lu}/u.test(word.slice(1))) continue;
    const known = dictionary.find(e => fold(e.word) === fold(word));
    if (known && (caseOnly || known.aliases.some(a => fold(a) === fold(alias)))) continue;
    const suggestion = caseOnly ? {word} : {word, alias};
    if (!suggestions.some(s => s.word === word && fold(s.alias ?? '') === fold(suggestion.alias ?? ''))) suggestions.push(suggestion);
  }
  return suggestions.slice(0, 3);
}

module.exports = {suggestCorrections};
