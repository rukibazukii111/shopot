// Meeting recording: noticing a call and turning two recorded channels into a dialog.
// The microphone channel is the user; the system audio channel is everyone else in the call.
const {EventEmitter} = require('node:events');

// Emits 'start' when an app begins using the microphone and 'stop' when it lets go.
class MicWatcher extends EventEmitter {
  constructor(read, interval = 4000) { super(); this.read = read; this.interval = interval; this.active = new Map(); this.timer = null; }
  start() { this.poll(); this.timer = setInterval(() => this.poll(), this.interval); }
  stop() { clearInterval(this.timer); this.timer = null; }
  poll() {
    let users;
    try { users = this.read() || []; } catch { return; }
    const now = new Map(users.map(user => [user.id, user]));
    for (const user of users) if (!this.active.has(user.id)) this.emit('start', user);
    for (const [id, user] of this.active) if (!now.has(id)) this.emit('stop', user);
    this.active = now;
  }
}

function fold(text) { return String(text).toLocaleLowerCase('ru').replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || []; }
// Share of the shorter text's words that the other text also has.
function similarity(a, b) {
  const left = fold(a), right = new Set(fold(b));
  if (!left.length || !right.size) return 0;
  const shorter = left.length <= right.size ? left : [...right];
  const other = shorter === left ? right : new Set(left);
  return shorter.filter(word => other.has(word)).length / shorter.length;
}
const overlaps = (a, b) => a.start < b.end + 1 && b.start < a.end + 1;

// Cues of both channels (seconds from the start of the meeting) become speaker turns in time order.
function meetingTurns(mine, theirs) {
  // Without headphones the microphone also hears the other side: such a cue repeats system audio.
  const own = mine.filter(cue => !theirs.some(other => overlaps(cue, other) && similarity(cue.text, other.text) >= 0.5));
  const cues = [...own.map(cue => ({...cue, speaker: 'me'})), ...theirs.map(cue => ({...cue, speaker: 'them'}))]
    .filter(cue => cue.text?.trim()).sort((a, b) => a.start - b.start);
  const turns = [];
  for (const cue of cues) {
    const last = turns[turns.length - 1];
    if (last && last.speaker === cue.speaker && cue.start - last.end < 2.5) { last.text += ' ' + cue.text.trim(); last.end = Math.max(last.end, cue.end); }
    else turns.push({speaker: cue.speaker, start: cue.start, end: cue.end, text: cue.text.trim()});
  }
  return turns;
}

function clock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const pad = value => String(value).padStart(2, '0');
  return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`;
}
const SPEAKERS = {me: 'Я', them: 'Собеседники'};
function meetingText(turns) { return turns.map(turn => `[${clock(turn.start)}] ${SPEAKERS[turn.speaker]}: ${turn.text}`).join('\n\n'); }

// What to paste into a chat assistant to get meeting notes; the transcript stays on this computer until the user does so.
function summaryPrompt(text, app) {
  return `Сделай краткое резюме созвона${app ? ` (${app})` : ''}: главные темы, принятые решения, задачи с ответственными и сроками, открытые вопросы. «Я» — это я, «Собеседники» — остальные участники.\n\n${text}`;
}

module.exports = {MicWatcher, meetingTurns, meetingText, summaryPrompt, similarity, clock};
