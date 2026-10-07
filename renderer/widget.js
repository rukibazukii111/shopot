const api = window.dictationWidget;
const $ = id => document.getElementById(id);
const terminal = ['success', 'error', 'canceled'];
const labels = {requesting: 'Подключаю микрофон', recording: 'Слушаю тебя', stopping: 'Сохраняю запись', transcribing: 'Распознаю на устройстве'};
// Tabler Icons (MIT).
const stateIcons = {
  'meeting-offer': '<path d="M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0"/><path d="M3 21v-2a4 4 0 0 1 4 -4h4a4 4 0 0 1 4 4v2"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/><path d="M21 21v-2a4 4 0 0 0 -3 -3.85"/>',
  success: '<path d="M5 12l5 5l10 -10"/>',
  error: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>',
  canceled: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
};
const waveShape = [7, 13, 19, 24, 17, 11, 6];
let state;
function keycap(text) { const key = document.createElement('kbd'); key.textContent = text; return key; }
function note(text, gap = false) { const span = document.createElement('span'); span.textContent = text; if (gap) span.className = 'gap'; return span; }
// 'Ctrl⇧Space' becomes Ctrl, Shift, Space; '⌘⇧Space' becomes ⌘, ⇧, Space.
function shortcutKeys(shortcut = '') {
  const mac = shortcut.includes('⌘');
  return shortcut.replace('⇧', ' ⇧ ').split(/\s+/).filter(Boolean).map(key => key === '⇧' && !mac ? 'Shift' : key);
}
function renderHint(value) {
  const hint = $('hint');
  // Push-to-talk: the keys are held down, so releasing them is the way to finish.
  if (value.phase === 'recording' && value.holding) hint.replaceChildren(note('Отпусти клавиши, чтобы закончить', true), keycap('Esc'), note('отменить'));
  else if (value.phase === 'recording') hint.replaceChildren(...shortcutKeys(value.shortcut).map(keycap), note('закончить', true), keycap('Esc'), note('отменить'));
  else if (value.phase === 'requesting') hint.replaceChildren(keycap('Esc'), note('отменить'));
  else if (value.phase === 'meeting') hint.replaceChildren(note('Предупреди собеседников о записи'));
  else if (terminal.includes(value.phase)) hint.replaceChildren(note(value.hint || 'Текст доступен в истории'));
  else hint.replaceChildren();
}
// A recording stopped at the limit: the widget stays with its recognition, and the cross only hides it (PRD 6.2).
function stoppedAtLimit(value) { return value.limit === true && ['stopping', 'transcribing'].includes(value.phase); }
// The cross hides the widget instead of canceling: after the result, during a call, and after a stop at the limit.
function closes(value) { return terminal.includes(value.phase) || ['meeting-offer', 'meeting', 'meeting-finishing'].includes(value.phase) || stoppedAtLimit(value); }
function render(value) {
  state = value; $('widget').dataset.phase = value.phase;
  const done = terminal.includes(value.phase), recording = value.phase === 'recording';
  const meeting = value.phase === 'meeting', offer = value.phase === 'meeting-offer';
  // The last minute before the dictation limit (PRD 6.2).
  const lastMinute = recording && value.warning === true;
  $('widget').toggleAttribute('data-warning', lastMinute);
  $('label').textContent = value.message || (lastMinute ? 'Осталась минута' : labels[value.phase]) || 'Шёпот';
  const seconds = Math.floor(value.elapsed || 0);
  const hours = Math.floor(seconds / 3600), clock = `${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('time').textContent = hours ? `${hours}:${clock}` : clock;
  $('time').hidden = !recording && !meeting;
  // The recognition's progress when the engine reports it; until then the bar slides.
  const fraction = value.phase === 'transcribing' && Number.isFinite(value.progress) ? value.progress : null;
  $('progress').classList.toggle('determinate', fraction !== null);
  $('progress').firstElementChild.style.width = fraction === null ? '' : `${Math.round(fraction * 100)}%`;
  $('state-icon').innerHTML = done || offer ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${stateIcons[value.phase]}</svg>` : '';
  renderHint(value);
  $('stop').hidden = !recording && !meeting;
  $('stop').title = meeting ? 'Закончить запись созвона' : 'Закончить диктовку';
  $('open').hidden = !done;
  $('offer-record').hidden = $('offer-ignore').hidden = !offer;
  const closing = closes(value);
  $('cancel').title = closing ? (meeting ? 'Скрыть, запись продолжится' : stoppedAtLimit(value) ? 'Скрыть, распознавание продолжится' : 'Закрыть') : 'Отменить';
  $('cancel').setAttribute('aria-label', closing ? $('cancel').title : 'Отменить диктовку');
  [...$('wave').children].forEach((bar, i) => bar.style.height = (recording ? Math.max(5, (value.level || 0) * 24 * waveShape[i] / 24) : waveShape[i]) + 'px');
}
$('stop').onclick = () => api.action('stop');
$('cancel').onclick = () => api.action(state.phase === 'meeting-offer' ? 'meeting-dismiss' : closes(state) ? 'hide' : 'cancel');
$('offer-record').onclick = () => api.action('meeting-record');
$('offer-ignore').onclick = () => api.action('meeting-ignore');
$('open').onclick = () => api.action('open');
api.onState(render); api.boot().then(render);
