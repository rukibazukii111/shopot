// File formats for saving a transcript: plain text, Markdown and SubRip subtitles.
const LINE = 42;

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (value, size = 2) => String(value).padStart(size, '0');
  return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`;
}

// Two lines at most, broken at the space nearest the middle.
function cueLines(text) {
  const clean = String(text).replace(/\s+/g, ' ').trim();
  if (clean.length <= LINE) return [clean];
  const middle = clean.length / 2;
  let best = -1;
  for (let i = clean.indexOf(' '); i !== -1; i = clean.indexOf(' ', i + 1)) if (best < 0 || Math.abs(i - middle) < Math.abs(best - middle)) best = i;
  return best < 0 ? [clean] : [clean.slice(0, best), clean.slice(best + 1)];
}

function toSrt(cues) {
  // Players expect CRLF line breaks; a cue shows for at least half a second.
  return cues.map((cue, i) => [String(i + 1), `${srtTime(cue.start)} --> ${srtTime(Math.max(cue.end, cue.start + 0.5))}`, ...cueLines(cue.text), ''].join('\r\n')).join('\r\n');
}

// Dictation lists use «•»; Markdown wants «-».
function toMarkdown(text) { return String(text).replace(/^• /gm, '- '); }

function exportText(format, entry, text) {
  if (format === 'srt') {
    if (!entry?.cues?.length) throw new Error('Для этой диктовки нет разметки по времени');
    return toSrt(entry.cues);
  }
  return format === 'md' ? toMarkdown(text) : text;
}

module.exports = {exportText, toSrt, toMarkdown, srtTime};
