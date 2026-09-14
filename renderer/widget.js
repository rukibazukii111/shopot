const api = window.dictationWidget;
const $ = id => document.getElementById(id);
const terminal = ['success', 'error', 'canceled'];
let state;
function render(value) {
  state = value; $('widget').dataset.phase = value.phase;
  const done = terminal.includes(value.phase);
  $('label').textContent = value.message || ({requesting: 'Подключаю микрофон', recording: 'Слушаю тебя', stopping: 'Сохраняю запись', transcribing: 'Распознаю на устройстве'}[value.phase] || 'Шёпот');
  const seconds = Math.floor(value.elapsed || 0);
  $('time').textContent = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  $('time').hidden = done;
  $('hint').textContent = done ? (value.hint || 'Текст доступен в истории') : (value.phase === 'recording' ? `${value.shortcut} — закончить · Esc — отмена` : 'Esc — отменить');
  $('stop').hidden = value.phase !== 'recording';
  $('open').hidden = !done;
  $('cancel').title = done ? 'Закрыть' : 'Отменить'; $('cancel').setAttribute('aria-label', $('cancel').title);
  [...$('wave').children].forEach((bar, i) => bar.style.height = Math.max(4, (value.level || 0) * 25 * [0.35,.6,.8,1,.75,.5,.3][i]) + 'px');
}
$('stop').onclick = () => api.action('stop');
$('cancel').onclick = () => api.action(terminal.includes(state.phase) ? 'hide' : 'cancel');
$('open').onclick = () => api.action('open');
api.onState(render); api.boot().then(render);
