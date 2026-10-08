
// Recordings whose text is worth handing to a chat assistant for notes; renderer/app.js repeats this rule.
const SUMMARY_MIN_SECONDS = 120;
const DICTATION_SOURCES = ['Микрофон', 'Незавершённая запись'];

function kindOf(entry) { return entry.meeting ? 'meeting' : DICTATION_SOURCES.includes(entry.source) ? 'dictation' : 'file'; }
function summaryAvailable(entry) { return kindOf(entry) !== 'dictation' || entry.duration > SUMMARY_MIN_SECONDS; }

// What to paste into a chat assistant; the text stays on this computer until the user does so.
function summaryPrompt(entry) {
  const kind = kindOf(entry);
  const request = kind === 'meeting'
    ? `Сделай краткое резюме созвона${entry.meeting.app ? ` (${entry.meeting.app})` : ''}: главные темы, принятые решения, задачи с ответственными и сроками, открытые вопросы. «Я» — это я, «Собеседники» — остальные участники.`
    : kind === 'file'
      ? `Сделай краткое резюме записи «${entry.source}»: главные темы, принятые решения, задачи с ответственными и сроками, открытые вопросы.`
      : 'Сделай краткое резюме моей надиктованной заметки: главные мысли, решения, задачи и сроки, открытые вопросы.';
  return `${request}\n\n${entry.text}`;
}

module.exports = {SUMMARY_MIN_SECONDS, summaryAvailable, summaryPrompt};
