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
function render(value) {
  state = value; $('widget').dataset.phase = value.phase;
  const done = terminal.includes(value.phase), recording = value.phase === 'recording';
  const meeting = value.phase === 'meeting', offer = value.phase === 'meeting-offer';
  $('label').textContent = value.message || labels[value.phase] || 'Шёпот';
  const seconds = Math.floor(value.elapsed || 0);
  const hours = Math.floor(seconds / 3600), clock = `${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('time').textContent = hours ? `${hours}:${clock}` : clock;
  $('time').hidden = !recording && !meeting;
  $('state-icon').innerHTML = done || offer ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${stateIcons[value.phase]}</svg>` : '';
  renderHint(value);
  $('stop').hidden = !recording && !meeting;
  $('stop').title = meeting ? 'Закончить запись созвона' : 'Закончить диктовку';
  $('open').hidden = !done;
  $('offer-record').hidden = $('offer-ignore').hidden = !offer;
  // During a call the cross only hides the widget: the recording goes on.
  const closes = done || offer || meeting || value.phase === 'meeting-finishing';
  $('cancel').title = closes ? (meeting ? 'Скрыть, запись продолжится' : 'Закрыть') : 'Отменить';
  $('cancel').setAttribute('aria-label', closes ? $('cancel').title : 'Отменить диктовку');
  [...$('wave').children].forEach((bar, i) => bar.style.height = (recording ? Math.max(5, (value.level || 0) * 24 * waveShape[i] / 24) : waveShape[i]) + 'px');
}
$('stop').onclick = () => api.action('stop');
$('cancel').onclick = () => api.action(state.phase === 'meeting-offer' ? 'meeting-dismiss'
  : terminal.includes(state.phase) || ['meeting', 'meeting-finishing'].includes(state.phase) ? 'hide' : 'cancel');
$('offer-record').onclick = () => api.action('meeting-record');
$('offer-ignore').onclick = () => api.action('meeting-ignore');
$('open').onclick = () => api.action('open');
api.onState(render); api.boot().then(render);
