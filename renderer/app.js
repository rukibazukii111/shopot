const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = window.shopot;
// Outline icons from Tabler Icons (MIT), 24px grid.
const icons = {
  mic: '<path d="M9 5a3 3 0 0 1 6 0v5a3 3 0 0 1 -6 0z"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  history: '<path d="M12 8v4l2 2"/><path d="M3.05 11a9 9 0 1 1 .5 4m-.5 5v-5h5"/>',
  book: '<path d="M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0"/><path d="M3 6v13"/><path d="M12 6v13"/><path d="M21 6v13"/>',
  layers: '<path d="M12 4l-8 4l8 4l8 -4l-8 -4"/><path d="M4 12l8 4l8 -4"/><path d="M4 16l8 4l8 -4"/>',
  settings: '<path d="M12 6a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 6h8"/><path d="M16 6h4"/><path d="M6 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 12h2"/><path d="M10 12h10"/><path d="M15 18a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"/><path d="M4 18h11"/><path d="M19 18h1"/>',
  shield: '<path d="M9 12l2 2l4 -4"/><path d="M12 3a12 12 0 0 0 8.5 3a12 12 0 0 1 -8.5 15a12 12 0 0 1 -8.5 -15a12 12 0 0 0 8.5 -3"/>',
  chevron: '<path d="M9 6l6 6l-6 6"/>', 'chevron-down': '<path d="M6 9l6 6l6 -6"/>',
  arrow: '<path d="M5 12h14"/><path d="M13 18l6 -6"/><path d="M13 6l6 6"/>',
  upload: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><path d="M12 11v6"/><path d="M9.5 13.5l2.5 -2.5l2.5 2.5"/>',
  search: '<path d="M3 10a7 7 0 1 0 14 0a7 7 0 1 0 -14 0"/><path d="M21 21l-6 -6"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  cpu: '<path d="M5 6a1 1 0 0 1 1 -1h12a1 1 0 0 1 1 1v12a1 1 0 0 1 -1 1h-12a1 1 0 0 1 -1 -1z"/><path d="M9 9h6v6h-6z"/><path d="M3 10h2"/><path d="M3 14h2"/><path d="M10 3v2"/><path d="M14 3v2"/><path d="M21 10h-2"/><path d="M21 14h-2"/><path d="M14 21v-2"/><path d="M10 21v-2"/>',
  text: '<path d="M14 3v4a1 1 0 0 0 1 1h4"/><path d="M17 21h-10a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2h7l5 5v11a2 2 0 0 1 -2 2z"/><path d="M9 9h1"/><path d="M9 13h6"/><path d="M9 17h6"/>',
  copy: '<path d="M7 9.667a2.667 2.667 0 0 1 2.667 -2.667h8.666a2.667 2.667 0 0 1 2.667 2.667v8.666a2.667 2.667 0 0 1 -2.667 2.667h-8.666a2.667 2.667 0 0 1 -2.667 -2.667z"/><path d="M4.012 16.737a2.005 2.005 0 0 1 -1.012 -1.737v-10c0 -1.1 .9 -2 2 -2h10c.75 0 1.158 .385 1.5 1"/>',
  download: '<path d="M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2 -2v-2"/><path d="M7 11l5 5l5 -5"/><path d="M12 4v12"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M5 7l1 12a2 2 0 0 0 2 2h8a2 2 0 0 0 2 -2l1 -12"/><path d="M9 7v-3a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v3"/>',
  edit: '<path d="M4 20h4l10.5 -10.5a2.828 2.828 0 1 0 -4 -4l-10.5 10.5v4"/><path d="M13.5 6.5l4 4"/>',
  play: '<path d="M7 4v16l13 -8z"/>', stop: '<rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none"/>',
  check: '<path d="M5 12l5 5l10 -10"/>', x: '<path d="M18 6l-12 12"/><path d="M6 6l12 12"/>',
  alert: '<path d="M12 9v4"/><path d="M10.363 3.591l-8.106 13.534a1.914 1.914 0 0 0 1.636 2.871h16.214a1.914 1.914 0 0 0 1.636 -2.87l-8.106 -13.536a1.914 1.914 0 0 0 -3.274 0z"/><path d="M12 16h.01"/>',
  info: '<path d="M3 12a9 9 0 1 0 18 0a9 9 0 0 0 -18 0"/><path d="M12 9h.01"/><path d="M11 12h1v4h1"/>',
  refresh: '<path d="M20 11a8.1 8.1 0 0 0 -15.5 -2m-.5 -4v4h4"/><path d="M4 13a8.1 8.1 0 0 0 15.5 2m.5 4v-4h-4"/>',
  bolt: '<path d="M13 3v7h6l-8 11v-7h-6l8 -11"/>',
  leaf: '<path d="M5 21c.5 -4.5 2.5 -8 7 -10"/><path d="M9 18c6.218 0 10.5 -3.288 11 -12v-2h-4.014c-9 0 -11.986 4 -12 9c0 1 0 3 2 5h3z"/>',
  target: '<path d="M11 12a1 1 0 1 0 2 0a1 1 0 1 0 -2 0"/><path d="M7 12a5 5 0 1 0 10 0a5 5 0 1 0 -10 0"/><path d="M3 12a9 9 0 1 0 18 0a9 9 0 1 0 -18 0"/>',
  database: '<path d="M4 6a8 3 0 1 0 16 0a8 3 0 1 0 -16 0"/><path d="M4 6v6a8 3 0 0 0 16 0v-6"/><path d="M4 12v6a8 3 0 0 0 16 0v-6"/>',
  sparkles: '<path d="M16 18a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm0 -12a2 2 0 0 1 2 2a2 2 0 0 1 2 -2a2 2 0 0 1 -2 -2a2 2 0 0 1 -2 2zm-7 12a6 6 0 0 1 6 -6a6 6 0 0 1 -6 -6a6 6 0 0 1 -6 6a6 6 0 0 1 6 6z"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.text}</svg>`; }
function paintIcons(parent = document) { parent.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon)); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const names = {dictation: 'Диктовка', history: 'История', dictionary: 'Мой словарь', models: 'Модели', settings: 'Настройки'};
const modes = {natural: 'Естественно', minimal: 'Минимум знаков', raw: 'Исходный результат'};
const modelNames = {formatter: 'модель оформления', gigaam: 'GigaAM v3', turbo: 'Whisper large-v3 turbo', small: 'Whisper small', 'large-v3': 'Whisper large-v3'};
const modelInfo = {
  gigaam: {title: 'Быстрая', icon: 'bolt', subtitle: 'GigaAM v3, только русский', size: '216 МБ', tag: 'Рекомендуем', text: 'Короткая фраза распознаётся за доли секунды. Мало памяти, есть пунктуация.'},
  small: {title: 'Лёгкая', icon: 'leaf', subtitle: 'Whisper small', size: '484 МБ', text: 'Меньше загрузка и расход памяти. На сложных словах ошибается чаще.'},
  turbo: {title: 'Точная', icon: 'target', subtitle: 'Whisper large-v3 turbo', size: '1,6 ГБ', text: 'Лучше со сленгом и терминами, понимает английский. Медленнее: несколько секунд даже на короткую фразу.'},
  'large-v3': {title: 'Полная', icon: 'database', subtitle: 'Whisper large-v3', size: '3,1 ГБ', text: 'Полная модель для сравнения качества. Нужно больше памяти и времени.'},
};
// Measured peaks of the Whisper models; on an 8 GB machine they compete with the browser and the system.
const heavyModels = {turbo: 'При загрузке модели нужно до 1,9 ГБ, остальные программы могут тормозить.', 'large-v3': 'Модели нужно около 3,3 ГБ, система может зависать.'};
const state = {settings: {}, dictionary: [], snippets: [], profiles: [], dictionaryTab: 'words', history: [], pendingRecordings: [], engine: null, page: 'dictation', phase: 'idle', operation: 0, hotkeyRegistered: false, selected: null, download: null, flash: null, confirmModel: null, totalMemory: 0};
let recorder, stream, audioContext, analyser, raf, recordingTimer, startedAt, recordingCanceled = false;
let editingWord = null, editingSnippet = null, wordAliases = [], toastTimer, flashTimer, blobUrls = [], contextDirty = false, captureId = null;
const drafts = new Map();

function toast(message, tone = 'ok') {
  const el = $('#toast');
  el.innerHTML = `<span class="${tone === 'ok' ? 'ok' : 'muted'}">${icon(tone === 'ok' ? 'check' : 'info')}</span><span>${escapeHtml(message)}</span>`;
  el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => el.hidden = true, 4000);
}
// Dictation feedback belongs in the recorder status line; on other pages it is a toast.
function notify(message, tone = 'ok') {
  if (state.page !== 'dictation') { toast(message, tone); return; }
  clearTimeout(flashTimer); state.flash = {message, tone}; refreshControls();
  flashTimer = setTimeout(() => { state.flash = null; refreshControls(); }, 4000);
}
function showError(error) { $('#error-text').textContent = (error.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); $('#error-banner').hidden = false; }
async function guard(action) { try { return await action(); } catch (error) { showError(error); } }
function page(name) {
  if (!(name in names)) return;
  if (name !== state.page) { clearTimeout(toastTimer); $('#toast').hidden = true; state.confirmModel = null; }
  state.page = name;
  $$('.page').forEach(el => el.hidden = el.id !== `page-${name}`);
  $$('.nav-item').forEach(el => {
    const active = el.dataset.page === name;
    el.classList.toggle('active', active);
    if (active) el.setAttribute('aria-current', 'page'); else el.removeAttribute('aria-current');
  });
  $(`#page-${name}`).scrollTop = 0;
  if (name === 'history') renderHistory();
  if (name === 'models') renderModels();
}
function isBusy() { return state.phase !== 'idle'; }
function formatBytes(bytes) {
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${(Math.round(gb * 10) / 10).toLocaleString('ru-RU')} ГБ` : `${Math.round(bytes / 1024 ** 2)} МБ`;
}
function memoryRisk(id) {
  const small = state.totalMemory > 0 && state.totalMemory < 9e9;
  return small && heavyModels[id] ? `На этом компьютере ${formatBytes(state.totalMemory)} памяти. ${heavyModels[id]}` : '';
}
function installed() { return Boolean(state.engine?.models?.find(m => m.id === state.settings.model)?.installed); }
function modelSize(id) { return state.engine?.models?.find(m => m.id === id)?.size || modelInfo[id]?.size || ''; }
function duration(seconds) { const s = Math.max(0, Math.round(seconds || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function secondsLabel(value) {
  const s = Math.max(0, Number(value) || 0);
  return s >= 60 ? `${Math.floor(s / 60)} мин ${Math.round(s % 60)} с` : `${(Math.round(s * 10) / 10).toLocaleString('ru-RU')} с`;
}
function dayLabel(iso) {
  const date = new Date(iso), today = new Date(), yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return 'Сегодня';
  if (date.toDateString() === yesterday.toDateString()) return 'Вчера';
  return new Intl.DateTimeFormat('ru', {day: 'numeric', month: 'long', ...(date.getFullYear() !== today.getFullYear() ? {year: 'numeric'} : {})}).format(date);
}
function timeLabel(iso) { return new Intl.DateTimeFormat('ru', {hour: '2-digit', minute: '2-digit'}).format(new Date(iso)); }
function dateLabel(iso) { return `${dayLabel(iso)}, ${timeLabel(iso)}`; }
function pluralWords(number) { return number % 10 === 1 && number % 100 !== 11 ? 'слово' : [2, 3, 4].includes(number % 10) && ![12,13,14].includes(number % 100) ? 'слова' : 'слов'; }
function updateEngine() {
  syncLanguages(); syncFormatting();
  $('#engine-dot').className = 'status-dot' + (state.engine ? '' : state.engineError ? ' error' : ' starting');
  $('#engine-label').textContent = state.engine ? 'Локальный движок' : state.engineError ? 'Движок недоступен' : 'Запускаем движок';
  const id = state.settings.model, info = modelInfo[id] || modelInfo.gigaam, ready = installed();
  $('#active-model').textContent = modelNames[id] || modelNames.gigaam;
  $('#active-model-icon').innerHTML = icon(info.icon);
  const heavy = Boolean(memoryRisk(id));
  $('#active-model-state').textContent = !state.engine ? 'Проверяем модель' : !ready ? ['Нужно скачать', modelSize(id)].filter(Boolean).join(', ')
    : heavy ? `${info.title}, тяжёлая для ${formatBytes(state.totalMemory)} памяти` : `${info.title}, на компьютере`;
  $('#active-model-state').classList.toggle('warn', Boolean(state.engine) && (!ready || heavy));
  refreshControls(); renderModels(); renderProfiles();
}
const phaseText = {
  recording: {status: 'Идёт запись', heading: 'Слушаю тебя', text: 'Говори свободно. Нажми сочетание ещё раз, когда закончишь.', label: 'Закончить запись'},
  requesting: {status: 'Подключаю микрофон', heading: 'Готовлюсь слушать', text: 'Если система запросит доступ, разреши микрофон для Шёпота.', label: 'Подключаем микрофон'},
  stopping: {status: 'Сохраняю запись', heading: 'Собираю твои слова', text: 'Распознавание идёт на твоём компьютере, без интернета.', label: 'Завершаем запись'},
  transcribing: {status: 'Распознаю на устройстве', heading: 'Собираю твои слова', text: 'Распознавание идёт на твоём компьютере, без интернета.', label: 'Распознаю…'},
  opening: {status: 'Открываю запись', heading: 'Открываем запись', text: 'Выбери аудио или видео до 100 МБ.', label: 'Выбираем файл'},
  canceling: {status: 'Отменяю', heading: 'Останавливаем запись', text: 'Подожди немного.', label: 'Отменяем'},
  downloading: {status: 'Загружаю модель', label: 'Модель загружается'},
};
function idleDescription() {
  if (!state.hotkeyRegistered) return 'Сочетание занято другим приложением. Используй кнопку записи или освободи сочетание и перезапусти Шёпот.';
  const where = state.settings.autoPaste ? 'Текст вставится туда, где стоит курсор.' : state.settings.autoCopy ? 'Готовый текст окажется в буфере обмена.' : 'Готовый текст сохранится в истории.';
  return `Сочетание работает в любом окне. ${where}`;
}
function refreshControls() {
  const phase = state.phase, ready = installed();
  const recordingNow = phase === 'recording';
  const processing = ['transcribing', 'stopping', 'opening'].includes(phase);
  $('#recorder-card').classList.toggle('recording', recordingNow);
  $('#recorder-card').classList.toggle('processing', processing);
  $('#record-button').disabled = !['idle', 'recording'].includes(phase) || (!recordingNow && !state.engine);
  const base = !state.engine ? {status: state.engineError ? 'Движок недоступен' : 'Запускаю движок', heading: 'Говори как есть', text: idleDescription()}
    : ready ? {status: 'Готов к диктовке', heading: 'Говори как есть', text: idleDescription()}
    : {status: 'Модель не скачана', heading: 'Начнём с модели', text: 'Скачай модель один раз, и дальше можно диктовать без интернета.'};
  const view = {...base, ...phaseText[phase]};
  const flash = phase === 'idle' ? state.flash : null;
  const status = $('#record-status');
  status.className = 'record-status' + (flash ? (flash.tone === 'ok' ? ' ok' : '') : recordingNow ? ' live' : phase === 'idle' && state.engine && !ready ? ' warn' : '');
  status.innerHTML = (recordingNow ? '<span class="rec-dot"></span>' : icon(flash?.tone === 'ok' ? 'check' : 'mic')) + `<span>${escapeHtml(flash ? flash.message : view.status)}</span>`;
  $('#record-heading').textContent = view.heading;
  $('#record-description').textContent = view.text;
  $('#record-label').textContent = phaseText[phase]?.label || (ready ? 'Начать диктовку' : 'Скачать модель');
  $('#record-button [data-icon]').innerHTML = icon(recordingNow ? 'stop' : phase === 'idle' && state.engine && !ready ? 'download' : 'mic');
  $('#cancel-button').hidden = !['requesting', 'recording', 'transcribing'].includes(phase);
  $('#import-button').hidden = phase !== 'idle' || !ready;
  $('#import-button').disabled = !state.engine;
  $('#record-hint').textContent = recordingNow ? 'Не дольше 15 минут'
    : phase !== 'idle' ? ''
    : ready ? 'Аудио или видео, до 100 МБ'
    : state.engine ? [modelNames[state.settings.model], modelSize(state.settings.model)].filter(Boolean).join(', ') : '';
  $('#quick-language').disabled = isBusy();
  $$('input[name="mode"]').forEach(input => input.disabled = isBusy());
  $('#record-progress').hidden = !processing;
  if (!processing) $('#transcribe-progress').removeAttribute('value');
  if (phase === 'idle') { $('#record-time').textContent = '00:00'; resetWave(); }
  renderRecovery();
}
async function saveSettings(changes) {
  state.settings = await api.settings({...state.settings, ...changes});
  if ('context' in changes) contextDirty = false;
  syncSettings(); updateEngine();
}
function syncFormatting() {
  const formatter = state.engine?.formatter;
  $('#formatting-select').querySelector('[value="llm"]').disabled = !formatter?.installed;
}
function syncLanguages() {
  // Russian-only models (GigaAM) cannot take English or auto-detection. The list arrives with the engine status.
  const languages = state.engine?.models?.find(m => m.id === state.settings.model)?.languages || ['ru', 'en', 'auto'];
  for (const option of $('#quick-language').options) option.disabled = !languages.includes(option.value);
  $('#language-note').textContent = languages.length === 1
    ? `${modelNames[state.settings.model] || 'Эта модель'} понимает только русский. Для английского выбери Whisper.`
    : 'Автоопределение подойдёт, если ты переключаешься между языками.';
}
function updateContextCount() { $('#context-count').textContent = `${$('#context-input').value.length}/200`; }
function syncSettings() {
  $('#quick-language').value = state.settings.language;
  $$('input[name="mode"]').forEach(input => input.checked = input.value === state.settings.mode);
  $('#auto-copy').checked = state.settings.autoCopy;
  $('#auto-paste').checked = state.settings.autoPaste;
  $('#keep-audio').checked = state.settings.keepAudio;
  $('#remove-fillers').checked = state.settings.removeFillers;
  $('#voice-commands').checked = state.settings.voiceCommands;
  $('#formatting-select').value = state.settings.formatting;
  if (!contextDirty) $('#context-input').value = state.settings.context;
  updateContextCount();
  $('#accessibility-row').hidden = state.platform !== 'darwin';
  $('#accessibility-status').textContent = state.pastePermission ? 'Доступ разрешён. Автовставка готова.' : 'Разреши Шёпоту управление в Системных настройках → Конфиденциальность и безопасность → Универсальный доступ.';
  if (state.platform === 'darwin') { $$('.modifier-key').forEach(el => el.textContent = '⌘'); $$('.paste-hint').forEach(el => el.textContent = '⌘V'); }
  $('#hotkey-description').textContent = state.hotkeyRegistered ? 'Открывает виджет, начинает и заканчивает запись. Esc во время записи отменяет её.' : 'Сочетание занято другим приложением. Используй кнопку записи или освободи сочетание и перезапусти Шёпот.';
  $('#hotkey-state').className = 'hotkey-state ' + (state.hotkeyRegistered ? 'ok' : 'warn');
  $('#hotkey-state').innerHTML = state.hotkeyRegistered ? `${icon('check')}Работает` : `${icon('alert')}Занято`;
  $('#hero-keys').classList.toggle('unavailable', !state.hotkeyRegistered);
  renderProfiles();
}

// Apps that dictation was pasted into, newest first: the candidates for a per-app profile.
function recentApps() {
  const seen = new Map();
  for (const entry of state.history) if (entry.app?.id && !seen.has(entry.app.id)) seen.set(entry.app.id, entry.app.name || entry.app.id);
  return [...seen].map(([id, name]) => ({id, name}));
}
function profileRow(profile) {
  const name = escapeHtml(profile.name), llm = state.engine?.formatter?.installed;
  return `<div class="profile-row" data-profile="${escapeHtml(profile.app)}"><span class="profile-name" title="${escapeHtml(profile.app)}">${name}</span>
    <div class="select"><select data-profile-field="mode" aria-label="Как записывать в ${name}"><option value="">Как обычно</option><option value="natural">Естественно</option><option value="minimal">Минимум знаков</option><option value="raw">Исходный результат</option></select><span data-icon="chevron-down"></span></div>
    <div class="select"><select data-profile-field="formatting" aria-label="Оформление в ${name}"><option value="">Как обычно</option><option value="rules">Абзацы и списки</option><option value="off">Одним абзацем</option><option value="llm"${llm ? '' : ' disabled'}>Умное (нейросеть)</option></select><span data-icon="chevron-down"></span></div>
    <label class="profile-check"><span class="switch"><input type="checkbox" role="switch" data-profile-field="dropFinalPeriod"><span></span></span>Без точки в конце</label>
    <button type="button" class="icon-button" data-remove-profile aria-label="Убрать настройки для ${name}" title="Убрать">${icon('x')}</button></div>`;
}
function renderProfiles() {
  $('#profiles-list').innerHTML = state.profiles.length
    ? '<div class="profile-row profile-columns" aria-hidden="true"><span>Приложение</span><span>Как записывать</span><span>Оформление</span><span></span><span></span></div>' + state.profiles.map(profileRow).join('')
    : '<p class="profiles-empty">Пока все приложения получают текст по общим настройкам.</p>';
  paintIcons($('#profiles-list'));
  for (const row of $$('.profile-row[data-profile]')) {
    const profile = state.profiles.find(p => p.app === row.dataset.profile);
    row.querySelector('[data-profile-field="mode"]').value = profile.mode || '';
    row.querySelector('[data-profile-field="formatting"]').value = profile.formatting || '';
    row.querySelector('[data-profile-field="dropFinalPeriod"]').checked = profile.dropFinalPeriod;
  }
  const available = recentApps().filter(app => !state.profiles.some(p => p.app === app.id));
  $('#profile-app').innerHTML = `<option value="">${available.length ? 'Добавить приложение…' : 'Новых приложений нет'}</option>`
    + available.map(app => `<option value="${escapeHtml(app.id)}">${escapeHtml(app.name)}</option>`).join('');
  $('#profile-app').disabled = !available.length;
}
async function saveProfiles(profiles) { state.profiles = await api.profiles(profiles); renderProfiles(); }

// Styles on waveform bars are generated locally; use the CSSOM rather than inline HTML.
const BAR_COUNT = 96;
const idleHeights = Array.from({length: BAR_COUNT}, (_, i) => 3 + Math.round((Math.abs(Math.sin((i + 1) * 12.9898) * 43758.5453) % 1) * 4));
$('#waveform').innerHTML = '<i></i>'.repeat(BAR_COUNT);
const waveBars = $$('#waveform i');
function resetWave() { waveBars.forEach((bar, i) => bar.style.height = idleHeights[i] + 'px'); }
function animateWave() {
  if (!analyser || state.phase !== 'recording') return;
  const data = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(data);
  // Speech sits below about 7 kHz (the first ~40 bins at 48 kHz); mirror it around the centre so the shape reads as a voice.
  const usable = Math.min(data.length, 40), middle = (BAR_COUNT - 1) / 2;
  waveBars.forEach((bar, i) => {
    const value = data[Math.min(usable - 1, Math.floor(Math.abs(i - middle) / (BAR_COUNT / 2) * usable))];
    bar.style.height = Math.max(4, Math.round(value / 255 * 60)) + 'px';
  });
  raf = requestAnimationFrame(animateWave);
}
async function listMicrophones() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'audioinput');
  $('#microphone-select').innerHTML = '<option value="default">Системный по умолчанию</option>' + inputs.filter(d => d.deviceId !== 'default').map((d, i) => `<option value="${escapeHtml(d.deviceId)}">${escapeHtml(d.label || `Микрофон ${i+1}`)}</option>`).join('');
  $('#microphone-select').value = inputs.some(d => d.deviceId === state.settings.microphoneId) ? state.settings.microphoneId : 'default';
}
function releaseMicrophone() {
  cancelAnimationFrame(raf); clearInterval(recordingTimer);
  stream?.getTracks().forEach(track => { track.onended = null; track.stop(); }); stream = null;
  audioContext?.close().catch(() => {}); audioContext = null; analyser = null;
}
async function startRecording(session) {
  if (isBusy()) return;
  if (!session && !installed()) { page('models'); return; }
  const operation = ++state.operation;
  state.phase = 'requesting'; state.flash = null; refreshControls();
  $('#error-banner').hidden = true;
  try {
    session = session || await api.beginRecording();
    if (operation !== state.operation) return;
    captureId = session.id;
    const microphone = session.settings.microphoneId;
    const acquired = await navigator.mediaDevices.getUserMedia({audio: {
      deviceId: microphone !== 'default' ? {exact: microphone} : undefined,
      channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true,
    }});
    if (operation !== state.operation) { acquired.getTracks().forEach(track => track.stop()); return; }
    stream = acquired;
    const chunks = [];
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
    recorder = new MediaRecorder(stream, {mimeType: mime, audioBitsPerSecond: 96000});
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      releaseMicrophone();
      if (recordingCanceled) {
        api.captureUpdate({id: session.id, phase: 'canceled'}); captureId = null;
        state.phase = 'idle'; refreshControls(); notify('Запись отменена', 'muted'); return;
      }
      state.phase = 'transcribing'; refreshControls();
      const operation = ++state.operation;
      try {
        const audio = new Uint8Array(await new Blob(chunks, {type: mime}).arrayBuffer());
        if (!audio.length) {
          api.captureUpdate({id: session.id, phase: 'canceled'});
          state.phase = 'idle'; notify('Запись слишком короткая. Попробуй ещё раз.', 'muted'); return;
        }
        const result = await api.transcribe(session.id, audio);
        if (operation === state.operation) acceptResult(result);
      } catch (error) { if (operation === state.operation) { api.captureUpdate({id: session.id, phase: 'error', message: error.message}); showError(error); } }
      finally { if (operation === state.operation) { captureId = null; state.phase = 'idle'; refreshControls(); } }
    };
    recorder.onerror = event => { showError(event.error || new Error('Запись прервалась')); recordingCanceled = true; if (recorder.state !== 'inactive') recorder.stop(); else { releaseMicrophone(); api.captureUpdate({id: session.id, phase: 'error'}); captureId = null; state.phase = 'idle'; refreshControls(); } };
    stream.getAudioTracks().forEach(track => track.onended = () => {
      showError(new Error('Микрофон отключён. Запись остановлена.'));
      if (recorder?.state === 'recording') stopRecording();
    });
    audioContext = new AudioContext(); analyser = audioContext.createAnalyser(); analyser.fftSize = 256;
    audioContext.createMediaStreamSource(stream).connect(analyser);
    recordingCanceled = false; state.phase = 'recording'; recorder.start(1000); startedAt = Date.now();
    api.captureUpdate({id: session.id, phase: 'recording', elapsed: 0}); refreshControls(); $('#record-time').textContent = '00:00'; animateWave();
    recordingTimer = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000; $('#record-time').textContent = duration(Math.floor(elapsed));
      const samples = new Uint8Array(analyser.frequencyBinCount); analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      api.captureUpdate({id: session.id, phase: 'recording', elapsed, level: Math.min(1, rms * 6)});
      if (elapsed >= 15 * 60) { toast('Достигнут предел записи: 15 минут'); stopRecording(); }
    }, 100);
    await listMicrophones().catch(() => {});
  } catch (error) {
    if (operation !== state.operation) return;
    releaseMicrophone(); state.phase = 'idle'; refreshControls();
    const messages = {NotAllowedError: 'Нет доступа к микрофону. Разреши доступ для Шёпота в настройках системы и попробуй снова.', NotFoundError: 'Микрофон не найден. Подключи его и попробуй снова.', NotReadableError: 'Микрофон занят или недоступен. Проверь другое приложение и повтори запись.', OverconstrainedError: 'Выбранный микрофон недоступен. Выбери системный микрофон в настройках.'};
    const message = messages[error.name] || error.message;
    if (session) api.captureUpdate({id: session.id, phase: 'error', message});
    captureId = null; showError(new Error(message));
  }
}
function stopRecording(cancel = false) {
  if (state.phase !== 'recording' || !recorder || recorder.state === 'inactive') return;
  recordingCanceled = cancel; state.phase = 'stopping'; clearInterval(recordingTimer);
  api.captureUpdate({id: captureId, phase: 'stopping', elapsed: (Date.now() - startedAt) / 1000});
  refreshControls(); recorder.stop();
}
function toggleRecording(session) { if (state.phase === 'recording') stopRecording(); else if (state.phase === 'requesting') guard(cancelOperation); else if (state.phase === 'idle') guard(() => startRecording(session)); }
async function cancelOperation() {
  if (state.phase === 'recording') { stopRecording(true); return; }
  if (['requesting', 'transcribing', 'downloading'].includes(state.phase)) {
    ++state.operation; state.phase = 'canceling'; refreshControls();
    await api.cancel(); captureId = null; state.phase = 'idle'; state.download = null; updateEngine(); notify('Операция отменена', 'muted');
  }
}
function acceptResult(result) {
  if (result.canceled) return;
  if (result.noSpeech) { notify('Речь не обнаружена. Попробуй говорить ближе к микрофону.', 'muted'); return; }
  const entry = result.entry;
  state.history = [entry, ...state.history.filter(e => e.id !== entry.id)]; state.selected = entry.id; renderResults();
  notify(result.message || (result.copied ? 'Готово. Текст скопирован и сохранён в истории' : 'Готово. Диктовка сохранена в истории'));
}
async function importAudio() {
  if (isBusy()) return;
  state.phase = 'opening'; page('dictation'); refreshControls();
  const operation = ++state.operation;
  try { const result = await api.importAudio(); if (operation === state.operation) acceptResult(result); }
  catch (error) { if (operation === state.operation) showError(error); }
  finally { if (operation === state.operation) { state.phase = 'idle'; refreshControls(); } }
}

function renderRecovery() {
  const entries = state.pendingRecordings;
  $('#recovery-banner').hidden = !entries.length || isBusy();
  if (!entries.length) return;
  $('#recovery-title').textContent = entries.length === 1 ? 'Запись сохранена, можно повторить распознавание' : `Ожидают распознавания: ${entries.length}`;
  $('#recovery-detail').textContent = `${dateLabel(entries[0].createdAt)}, ${entries[0].source}. После распознавания текст появится в истории.`;
  $('#retry-recording').disabled = !state.engine || !installed();
}
async function retryRecording() {
  if (isBusy() || !state.pendingRecordings.length) return;
  const id = state.pendingRecordings[0].id, operation = ++state.operation;
  state.phase = 'transcribing'; page('dictation'); refreshControls(); $('#error-banner').hidden = true;
  try { const result = await api.retryRecording(id); if (operation === state.operation) acceptResult(result); }
  catch (error) { if (operation === state.operation) showError(error); }
  finally { if (operation === state.operation) { state.phase = 'idle'; refreshControls(); } }
}

function entryText(entry) { return drafts.has(entry.id) ? drafts.get(entry.id) : entry.text; }
function wordCount(text) { return text.trim().split(/\s+/u).filter(Boolean).length; }
function doubtsOf(entry) { return (entry.words || []).filter(w => w.probability < 0.65).length; }
function isFileSource(entry) { return !['Микрофон', 'Незавершённая запись'].includes(entry.source); }
function rawHtml(entry) {
  // Whisper words carry their leading space; keep it outside the highlight.
  return (entry.words || []).length ? entry.words.map(w => {
    if (w.probability >= 0.65) return escapeHtml(w.word);
    const [, space, word] = String(w.word).match(/^(\s*)([\s\S]*)$/);
    return `${space}<mark class="uncertain" title="Оценка модели ${Math.round(w.probability*100)}%. Это не вероятность правильного слова.">${escapeHtml(word)}</mark>`;
  }).join('') : escapeHtml(entry.rawText);
}
function recognitionLabel(entry) {
  return secondsLabel(entry.elapsed) + (entry.loadElapsed >= 0.1 ? `, из них загрузка модели ${secondsLabel(entry.loadElapsed)}` : '');
}
// Peak RAM of the engine for this dictation (Windows: working set, macOS: the Activity Monitor footprint).
function memoryLabel(entry) {
  return `пик ${formatBytes(entry.memoryPeak)}` + (state.totalMemory ? ` из ${formatBytes(state.totalMemory)}` : '');
}
function rawNote(entry) { return doubtsOf(entry) ? 'Жёлтым отмечены слова, в которых модель не уверена. Исходный результат сохранён без правок.' : 'Исходный результат сохранён без правок. Пунктуацию расставила сама модель.'; }
function replacementsHtml(entry) {
  const replacements = entry.replacements || [], snippets = entry.snippets || [];
  // The same command said twice shows once: the chip explains where the words went.
  const commands = [...new Set(entry.commands || [])];
  const group = (items, one, many, chip) => items.length ? `<span>${items.length === 1 ? one : many}</span>${items.map(item => `<span class="chip-static">${chip(item)}</span>`).join('')}` : '';
  const html = group(replacements, 'Замена из словаря', 'Замены из словаря', r => `${escapeHtml(r.from)} → ${escapeHtml(r.to)}`)
    + group(snippets, 'Сниппет', 'Сниппеты', escapeHtml) + group(commands, 'Команда', 'Команды', escapeHtml);
  return html ? `<div class="replacements">${html}</div>` : '';
}
function tabsHtml(kind, entry) {
  const doubts = doubtsOf(entry);
  return `<div class="pill-tabs"><button class="pill-tab active" data-${kind}-tab="text">Текст</button><button class="pill-tab" data-${kind}-tab="raw">Исходник${doubts ? `<span class="doubt-count">${doubts}</span>` : ''}</button></div>`;
}
function entryActions(entry, primary) {
  const copy = primary
    ? `<button class="button-primary copy-button" data-action="copy"><span class="copy-check">${icon('check')}</span><span class="copy-label">Скопировать</span><kbd>Enter</kbd></button>`
    : `<button class="button copy-button" data-action="copy"><span class="copy-icon">${icon('copy')}</span><span class="copy-check">${icon('check')}</span><span class="copy-label">Скопировать</span></button>`;
  return `${entry.audioFile ? `<button class="icon-button" data-action="play" aria-label="Прослушать запись" title="Прослушать">${icon('play')}</button>` : ''}<button class="icon-button" data-action="export" aria-label="Сохранить в .txt" title="Сохранить в .txt">${icon('download')}</button><button class="icon-button" data-action="delete" aria-label="Удалить диктовку" title="Удалить">${icon('trash')}</button>${copy}`;
}
function latestCard(entry) {
  const text = entryText(entry), count = wordCount(text), id = escapeHtml(entry.id);
  return `<article class="result-card" data-entry="${id}">
    <div class="latest-head"><h2>Последняя диктовка</h2><span class="latest-date">${escapeHtml(dateLabel(entry.createdAt))}</span>${tabsHtml('result', entry)}<span class="head-divider"></span><button class="link-button" id="all-history">Вся история${icon('arrow')}</button></div>
    <div class="result-body"><div class="result-panel" data-result-panel="text"><textarea class="transcript-editor" data-entry="${id}" aria-label="Текст диктовки" spellcheck="false">${escapeHtml(text)}</textarea>${replacementsHtml(entry)}</div>
    <div class="result-panel" data-result-panel="raw" hidden><p class="raw-text">${rawHtml(entry)}</p><p class="review-note">${rawNote(entry)}</p></div><div class="audio-slot"></div></div>
    <div class="result-foot"><span class="metric"><b>${duration(entry.duration)}</b> аудио</span><span class="metric"><b>${count}</b> ${pluralWords(count)}</span><span class="metric"><b>${secondsLabel(entry.elapsed)}</b> на распознавание</span><div class="result-actions">${entryActions(entry, false)}</div></div></article>`;
}
function renderResults() {
  blobUrls.forEach(url => URL.revokeObjectURL(url)); blobUrls = [];
  $('#history-count').textContent = state.history.length;
  $('#latest-result').innerHTML = state.history.length ? latestCard(state.history[0])
    : `<div class="latest-head"><h2>Последняя диктовка</h2></div><div class="result-body"><div class="empty-state"><span class="tile">${icon('text')}</span><div><strong>Здесь появятся твои слова</strong><p>Текст можно будет поправить, скопировать или сохранить в файл.</p></div></div></div>`;
  if (state.page === 'history') renderHistory();
}

function filteredHistory() {
  const query = $('#history-search').value.trim().toLocaleLowerCase();
  if (!query) return state.history;
  return state.history.filter(e => [entryText(e), e.text, e.rawText].some(value => (value || '').toLocaleLowerCase().includes(query)));
}
function renderHistory() {
  const query = $('#history-search').value.trim();
  const entries = filteredHistory();
  if (!entries.some(e => e.id === state.selected)) state.selected = entries[0]?.id ?? null;
  let group = '', html = '';
  for (const entry of entries) {
    const label = dayLabel(entry.createdAt), doubts = doubtsOf(entry), selected = entry.id === state.selected;
    if (label !== group) { group = label; html += `<div class="group-label">${escapeHtml(label)}</div>`; }
    html += `<button class="history-row${selected ? ' selected' : ''}" data-select-entry="${escapeHtml(entry.id)}" aria-pressed="${selected}"><span class="tile">${icon(isFileSource(entry) ? 'text' : 'mic')}</span><span class="row-text"><span class="row-title">${escapeHtml(entryText(entry).replace(/\s+/g, ' ').trim() || 'Пустая диктовка')}</span><span class="row-meta"><span class="mono">${timeLabel(entry.createdAt)}</span><span class="mono">${duration(entry.duration)}</span><span>${escapeHtml(modelNames[entry.model] || entry.model)}</span></span></span>${doubts ? `<span class="badge-warn">${doubts} проверить</span>` : '<span></span>'}</button>`;
  }
  $('#history-list').innerHTML = html || `<div class="list-empty"><strong>${query ? 'Ничего не нашлось' : 'Пока здесь тихо'}</strong><span>${query ? 'Попробуй другое слово или часть фразы.' : 'Начни с первой диктовки, и она появится здесь.'}</span></div>`;
  renderHistoryDetail();
}
function renderHistoryDetail() {
  const entry = state.history.find(e => e.id === state.selected);
  if (!entry) {
    $('#history-detail').innerHTML = `<div class="detail-empty"><span class="tile">${icon('history')}</span><div><strong>Здесь будет текст диктовки</strong><p>Выбери диктовку в списке, чтобы поправить, скопировать или сохранить её.</p></div></div>`;
    return;
  }
  const text = entryText(entry), count = wordCount(text), id = escapeHtml(entry.id);
  $('#history-detail').innerHTML = `<div class="detail" data-entry="${id}">
    <div class="detail-head"><h1>${escapeHtml(dateLabel(entry.createdAt))}</h1><span class="detail-source">${escapeHtml(entry.source)}</span>${tabsHtml('detail', entry)}</div>
    <div class="detail-body"><div class="detail-panel" data-detail-panel="text"><textarea class="history-editor" data-entry="${id}" aria-label="Текст диктовки" spellcheck="false">${escapeHtml(text)}</textarea>${replacementsHtml(entry)}</div>
    <div class="detail-panel" data-detail-panel="raw" hidden><p class="history-raw">${rawHtml(entry)}</p><p class="review-note">${rawNote(entry)}</p></div><div class="audio-slot"></div>
    <dl class="meta-list"><dt>Длительность</dt><dd class="mono">${duration(entry.duration)}</dd><dt>Текст</dt><dd>${count} ${pluralWords(count)}</dd><dt>Распознавание</dt><dd>${recognitionLabel(entry)}</dd>${entry.memoryPeak ? `<dt>Память</dt><dd>${memoryLabel(entry)}</dd>` : ''}<dt>Модель</dt><dd>${escapeHtml(modelNames[entry.model] || entry.model)}</dd><dt>Режим</dt><dd>${escapeHtml(modes[entry.mode] || '')}</dd><dt>Источник</dt><dd>${escapeHtml(entry.source)}</dd>${entry.app ? `<dt>Приложение</dt><dd>${escapeHtml(entry.app.name)}${entry.app.profile ? ' · свои настройки' : ''}</dd>` : ''}</dl></div>
    <div class="action-bar"><span class="action-note">${icon('edit')}Правки в тексте сохраняются сами</span><span class="spacer"></span>${entryActions(entry, true)}</div></div>`;
}
function selectEntry(id, focus = false) {
  state.selected = id;
  $$('.history-row').forEach(row => {
    const selected = row.dataset.selectEntry === id;
    row.classList.toggle('selected', selected); row.setAttribute('aria-pressed', selected);
    if (selected) { row.scrollIntoView({block: 'nearest'}); if (focus) row.focus(); }
  });
  renderHistoryDetail();
}
function moveSelection(delta) {
  const ids = filteredHistory().map(e => e.id);
  if (!ids.length) return;
  const index = Math.max(0, Math.min(ids.length - 1, ids.indexOf(state.selected) + delta));
  selectEntry(ids[index], document.activeElement !== $('#history-search'));
}
function markCopied(button) {
  if (!button?.querySelector('.copy-label')) return;
  button.classList.add('copied'); button.querySelector('.copy-label').textContent = 'Скопировано';
  clearTimeout(button.copyTimer);
  button.copyTimer = setTimeout(() => { button.classList.remove('copied'); button.querySelector('.copy-label').textContent = 'Скопировать'; }, 1600);
}
async function entryAction(button) {
  const holder = button.closest('[data-entry]');
  const entry = state.history.find(e => e.id === holder?.dataset.entry);
  if (!entry) return;
  const text = holder.querySelector('textarea')?.value ?? entryText(entry);
  const action = button.dataset.action;
  if (action === 'copy') { await api.copy(text); markCopied(button); }
  if (action === 'export') { if (await api.saveText(text)) toast('Текст сохранён в файл'); }
  if (action === 'delete' && await api.deleteEntry(entry.id)) { state.history = state.history.filter(e => e.id !== entry.id); drafts.delete(entry.id); renderResults(); }
  if (action === 'play') {
    const existing = holder.querySelector('audio'); if (existing) { existing.paused ? await existing.play() : existing.pause(); return; }
    const data = await api.readAudio(entry.id); if (!data) { toast('Аудиозапись не найдена', 'muted'); return; }
    const url = URL.createObjectURL(new Blob([data])); blobUrls.push(url);
    const audio = document.createElement('audio'); audio.className = 'audio-player'; audio.controls = true; audio.src = url;
    holder.querySelector('.audio-slot').append(audio); await audio.play();
  }
}
function switchTab(tab) {
  const kind = tab.dataset.resultTab ? 'result' : 'detail', value = tab.dataset.resultTab || tab.dataset.detailTab;
  const holder = tab.closest('[data-entry]');
  holder.querySelectorAll(`[data-${kind}-tab]`).forEach(el => el.classList.toggle('active', el === tab));
  holder.querySelectorAll(`[data-${kind}-panel]`).forEach(el => el.hidden = el.dataset[`${kind}Panel`] !== value);
}

const dictionaryTabs = {
  words: {add: 'Добавить слово', columns: ['Как писать', 'Что заменять'], info: 'Замены работают с любой моделью. Подсказки для распознавания понимает только Whisper.', foot: 'До 100 слов. В подсказку Whisper попадают первые 500 символов словаря.'},
  snippets: {add: 'Добавить сниппет', columns: ['Фраза', 'Текст'], info: 'Скажи фразу во время диктовки, и вместо неё вставится сохранённый текст: почта, реквизиты, шаблон ответа.', foot: 'До 50 сниппетов по 4000 символов. Работают с любой моделью, кроме режима «Исходный результат».'},
};
function dictionaryTab(name, focus = false) {
  state.dictionaryTab = name;
  const tab = dictionaryTabs[name];
  $$('[data-dictionary-tab]').forEach(el => { const active = el.dataset.dictionaryTab === name; el.classList.toggle('active', active); el.setAttribute('aria-selected', active); });
  $('#add-label').textContent = tab.add; $('#dictionary-info').textContent = tab.info; $('#dictionary-foot').textContent = tab.foot;
  [$('#dictionary-column-a').textContent, $('#dictionary-column-b').textContent] = tab.columns;
  $('#dictionary-form').hidden = name !== 'words'; $('#snippet-form').hidden = name !== 'snippets';
  if (name === 'words') openWord(state.dictionary.find(e => e.id === editingWord) || state.dictionary[0] || null, focus);
  else openSnippet(state.snippets.find(e => e.id === editingSnippet) || state.snippets[0] || null, focus);
}
function renderSnippets() {
  $('#dictionary-count').textContent = `${state.snippets.length} из 50`;
  $('#dictionary-list').innerHTML = state.snippets.length ? state.snippets.map(entry => {
    const selected = entry.id === editingSnippet;
    return `<button type="button" class="dictionary-row${selected ? ' selected' : ''}" data-snippet-id="${escapeHtml(entry.id)}" aria-pressed="${selected}"><span class="dictionary-word">${escapeHtml(entry.trigger)}</span><span class="dictionary-aliases">${escapeHtml(entry.text.replace(/\s+/g, ' '))}</span><span class="chevron">${icon('chevron')}</span></button>`;
  }).join('') : '<div class="list-empty"><strong>Сниппетов пока нет</strong><span>Добавь фразу для почты, реквизитов или частого ответа.</span></div>';
}
function openSnippet(entry, focus = false) {
  editingSnippet = entry?.id ?? null;
  $('#snippet-title').textContent = entry ? 'Изменить сниппет' : 'Новый сниппет';
  $('#snippet-trigger').value = entry?.trigger ?? ''; $('#snippet-text').value = entry?.text ?? '';
  $('#delete-snippet').hidden = !entry;
  validateSnippet(); renderSnippets();
  if (focus) $('#snippet-trigger').focus();
}
// Same folding as the store: case, «ё» and punctuation between words do not make a new phrase.
function foldPhrase(text) { return text.toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function validateSnippet(serverError = '') {
  const trigger = foldPhrase($('#snippet-trigger').value), text = $('#snippet-text').value;
  const duplicate = Boolean(trigger) && state.snippets.some(e => e.id !== editingSnippet && foldPhrase(e.trigger) === trigger);
  const message = serverError || (duplicate ? 'Такая фраза уже есть' : '');
  $('#snippet-error').innerHTML = message ? `${icon('alert')}<span>${escapeHtml(message)}</span>` : '';
  $('#snippet-trigger').classList.toggle('invalid', duplicate);
  $('#snippet-count').textContent = `${text.length}/4000`;
  const valid = $('#snippet-trigger').value.trim().length >= 2 && Boolean(trigger) && Boolean(text.trim()) && !duplicate;
  $('#save-snippet').disabled = !valid;
  return valid;
}
function renderDictionary() {
  if (state.dictionaryTab === 'snippets') { renderSnippets(); return; }
  $('#dictionary-count').textContent = `${state.dictionary.length} из 100`;
  $('#dictionary-list').innerHTML = state.dictionary.length ? state.dictionary.map(entry => {
    const selected = entry.id === editingWord;
    return `<button type="button" class="dictionary-row${selected ? ' selected' : ''}" data-word-id="${escapeHtml(entry.id)}" aria-pressed="${selected}"><span class="dictionary-word">${escapeHtml(entry.word)}</span><span class="dictionary-aliases${entry.aliases.length ? '' : ' none'}">${entry.aliases.length ? escapeHtml(entry.aliases.join(', ')) : 'Только подсказка для Whisper'}</span><span class="chevron">${icon('chevron')}</span></button>`;
  }).join('') : '<div class="list-empty"><strong>Словарь пока пуст</strong><span>Добавь слово, которое модель часто путает.</span></div>';
}
function openWord(entry, focus = false) {
  editingWord = entry?.id ?? null; wordAliases = entry ? [...entry.aliases] : [];
  $('#word-dialog-title').textContent = entry ? 'Изменить слово' : 'Новое слово';
  $('#word-input').value = entry?.word ?? ''; $('#alias-input').value = '';
  $('#delete-word').hidden = !entry;
  renderAliases(); validateWord(); renderDictionary();
  if (focus) $('#word-input').focus();
}
function renderAliases() {
  $('#alias-chips').innerHTML = wordAliases.map((alias, index) => `<span class="chip">${escapeHtml(alias)}<button type="button" data-remove-alias="${index}" aria-label="Убрать вариант ${escapeHtml(alias)}">${icon('x')}</button></span>`).join('');
}
function validateWord(serverError = '') {
  const word = $('#word-input').value.trim().toLocaleLowerCase();
  const duplicate = Boolean(word) && state.dictionary.some(e => e.id !== editingWord && e.word.toLocaleLowerCase() === word);
  const message = serverError || (duplicate ? 'Это слово уже есть в словаре' : '');
  $('#word-error').innerHTML = message ? `${icon('alert')}<span>${escapeHtml(message)}</span>` : '';
  $('#word-input').classList.toggle('invalid', duplicate);
  $('#save-word').disabled = !word || duplicate;
  return Boolean(word) && !duplicate;
}
function addAliases(text) {
  for (const part of text.split(',').map(s => s.trim()).filter(Boolean)) {
    if (!wordAliases.some(a => a.toLocaleLowerCase() === part.toLocaleLowerCase())) wordAliases.push(part);
  }
  renderAliases();
}

function modelCard(card) {
  // A heavy model on a small machine takes a second click: the first one only asks.
  const label = card.confirm ? (card.installed ? 'Всё равно выбрать' : 'Всё равно скачать') : card.installed ? card.selectLabel : `${icon('download')}Скачать`;
  const action = card.downloading ? '<button class="button-outline" id="cancel-download">Остановить</button>'
    : card.installed && card.selected ? `<span class="badge-success" ${card.attr}>${icon('check')}Используется</span>`
    : `<button class="button-outline${card.confirm ? ' confirm' : ''}" ${card.attr} ${card.busy ? 'disabled' : ''}>${label}</button>`;
  const meta = card.downloading
    ? '<div class="model-progress"><progress id="download-progress"></progress><div class="model-progress-text"><span id="download-detail">Подключаемся…</span><span id="download-percent"></span></div></div>'
    : `<div class="model-meta">${card.note ? `<span>${card.note}</span>` : `<b>${escapeHtml(card.size)}</b><span>${card.installed ? 'на компьютере' : card.source}</span>`}</div>`;
  const warning = card.warning ? `<p class="model-warning">${icon('alert')}<span>${escapeHtml(card.warning)}</span></p>` : '';
  return `<article class="model-card${card.installed && card.selected ? ' selected' : ''}"><span class="tile">${icon(card.icon)}</span><div class="model-card-text"><div class="model-title"><h2>${card.title}</h2>${card.tag ? `<span class="badge-info">${card.tag}</span>` : ''}</div><span class="model-sub">${card.subtitle}</span><p class="model-desc">${card.text}</p>${warning}${meta}</div><div class="model-action">${action}</div></article>`;
}
function renderModels() {
  const busy = isBusy() || !state.engine;
  $('#models-list').innerHTML = ['gigaam', 'small', 'turbo', 'large-v3'].map(id => {
    const model = state.engine?.models?.find(m => m.id === id);
    return modelCard({...modelInfo[id], size: model?.size || modelInfo[id].size, installed: Boolean(model?.installed), selected: state.settings.model === id,
      downloading: state.download?.id === id, busy, attr: `data-model="${id}"`, selectLabel: 'Выбрать', source: 'загрузка с Hugging Face',
      warning: memoryRisk(id), confirm: state.confirmModel === id});
  }).join('');
  const formatter = state.engine?.formatter, unsupported = formatter?.supported === false;
  $('#formatter-list').innerHTML = modelCard({icon: 'sparkles', title: 'Умное оформление', subtitle: 'Qwen3-4B, локальная нейросеть',
    text: 'Абзацы и списки расставляет нейросеть на видеокарте, около секунды на диктовку. Слова не меняются. Без видеокарты работает медленно.',
    size: formatter?.size || '2,4 ГБ', installed: Boolean(formatter?.installed), selected: state.settings.formatting === 'llm',
    downloading: state.download?.id === 'formatter', busy: busy || unsupported, attr: 'data-formatter', selectLabel: 'Включить',
    source: 'загрузка llama.cpp и модели с Hugging Face', note: unsupported ? 'Пока только для Windows' : ''});
  updateDownloadProgress();
}
function updateDownloadProgress() {
  const download = state.download, bar = $('#download-progress');
  if (!download || !bar) return;
  if (download.total > 0) {
    bar.max = download.total; bar.value = download.completed;
    $('#download-detail').textContent = `${Math.round(download.completed / 1e6).toLocaleString('ru-RU')} из ${Math.round(download.total / 1e6).toLocaleString('ru-RU')} МБ`;
    $('#download-percent').textContent = `${Math.floor(download.completed / download.total * 100)}%`;
  } else {
    bar.removeAttribute('value'); $('#download-detail').textContent = download.message || 'Подключаемся…'; $('#download-percent').textContent = '';
  }
}
async function selectFormatter() {
  if (isBusy()) return;
  if (state.engine.formatter?.installed) { await saveSettings({formatting: 'llm'}); renderModels(); toast('Умное оформление включено'); return; }
  const operation = ++state.operation;
  state.phase = 'downloading'; state.download = {id: 'formatter', completed: 0, total: 0}; refreshControls(); renderModels();
  try {
    const engine = await api.download('formatter');
    if (operation === state.operation) { state.engine = engine; await saveSettings({formatting: 'llm'}); toast('Умное оформление готово и включено'); }
  } catch (error) { if (operation === state.operation) showError(error); }
  finally { if (operation === state.operation) { state.phase = 'idle'; state.download = null; updateEngine(); } }
}
async function selectModel(id) {
  if (isBusy()) return;
  if (memoryRisk(id) && state.confirmModel !== id) { state.confirmModel = id; renderModels(); return; }
  state.confirmModel = null;
  const model = state.engine.models.find(m => m.id === id);
  // Russian-only models switch the language along with the model.
  const changes = {model: id, ...(model.languages?.includes(state.settings.language) === false ? {language: 'ru'} : {})};
  if (model.installed) { await saveSettings(changes); renderModels(); toast('Модель выбрана'); return; }
  const operation = ++state.operation;
  state.phase = 'downloading'; state.download = {id, completed: 0, total: 0}; refreshControls(); renderModels();
  try {
    const engine = await api.download(id);
    if (operation === state.operation) { state.engine = engine; await saveSettings(changes); toast('Модель готова. Можно диктовать.'); }
  } catch (error) { if (operation === state.operation) showError(error); }
  finally { if (operation === state.operation) { state.phase = 'idle'; state.download = null; updateEngine(); } }
}

document.addEventListener('click', event => {
  const target = event.target;
  const nav = target.closest('[data-page]'); if (nav) { page(nav.dataset.page); return; }
  if (target.closest('#brand')) { page('dictation'); return; }
  if (target.closest('#all-history')) { page('history'); return; }
  if (target.closest('#cancel-download')) { guard(cancelOperation); return; }
  const modelButton = target.closest('button[data-model]'); if (modelButton) { guard(() => selectModel(modelButton.dataset.model)); return; }
  if (target.closest('button[data-formatter]')) { guard(selectFormatter); return; }
  const row = target.closest('[data-select-entry]'); if (row) { selectEntry(row.dataset.selectEntry); return; }
  const word = target.closest('[data-word-id]'); if (word) { openWord(state.dictionary.find(e => e.id === word.dataset.wordId)); return; }
  const snippet = target.closest('[data-snippet-id]'); if (snippet) { openSnippet(state.snippets.find(e => e.id === snippet.dataset.snippetId)); return; }
  const dictionaryTabButton = target.closest('[data-dictionary-tab]'); if (dictionaryTabButton) { dictionaryTab(dictionaryTabButton.dataset.dictionaryTab); return; }
  const removeProfile = target.closest('[data-remove-profile]');
  if (removeProfile) { const app = removeProfile.closest('.profile-row').dataset.profile; guard(() => saveProfiles(state.profiles.filter(p => p.app !== app))); return; }
  const remove = target.closest('[data-remove-alias]');
  if (remove) { wordAliases.splice(Number(remove.dataset.removeAlias), 1); renderAliases(); $('#alias-input').focus(); return; }
  if (target.closest('#alias-box') && !target.closest('input')) { $('#alias-input').focus(); return; }
  const tab = target.closest('[data-result-tab], [data-detail-tab]'); if (tab) { switchTab(tab); return; }
  const button = target.closest('[data-action]'); if (button) guard(() => entryAction(button));
});
document.addEventListener('change', event => {
  const target = event.target;
  if (target.matches('.transcript-editor, .history-editor')) guard(async () => {
    const id = target.dataset.entry, text = target.value;
    const entry = await api.updateEntry(id, text);
    if (drafts.get(id) === text) drafts.delete(id);
    state.history = state.history.map(e => e.id === id ? entry : e);
    $$('.transcript-editor, .history-editor').filter(el => el.dataset.entry === id && el !== target).forEach(el => el.value = text);
    const title = $(`[data-select-entry="${CSS.escape(id)}"] .row-title`);
    if (title) title.textContent = text.replace(/\s+/g, ' ').trim() || 'Пустая диктовка';
  });
  if (target.matches('input[name="mode"]')) guard(() => saveSettings({mode: target.value}));
  const profileField = target.closest('[data-profile-field]');
  if (profileField) guard(() => {
    const app = profileField.closest('.profile-row').dataset.profile, field = profileField.dataset.profileField;
    const value = field === 'dropFinalPeriod' ? profileField.checked : profileField.value || null;
    return saveProfiles(state.profiles.map(p => p.app === app ? {...p, [field]: value} : p));
  });
  if (target === $('#profile-app') && target.value) guard(() => {
    const app = recentApps().find(a => a.id === target.value);
    return saveProfiles([...state.profiles, {app: app.id, name: app.name, mode: null, formatting: null, dropFinalPeriod: false}]);
  });
});
document.addEventListener('input', event => {
  if (event.target.matches('.transcript-editor, .history-editor')) drafts.set(event.target.dataset.entry, event.target.value);
});
document.addEventListener('keydown', event => {
  const mod = (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey;
  const typing = event.target.closest?.('input, textarea, select');
  // Physical key codes keep the shortcuts working on the Russian layout.
  if (mod && event.code === 'KeyF' && state.page === 'history') { event.preventDefault(); $('#history-search').focus(); $('#history-search').select(); return; }
  if (mod && event.code === 'KeyN' && state.page === 'dictionary') { event.preventDefault(); newDictionaryItem(); return; }
  if (mod && event.key === 'Enter' && event.target === $('#snippet-text')) { event.preventDefault(); $('#snippet-form').requestSubmit(); return; }
  if (event.key === 'Escape' && !typing && ['requesting', 'transcribing'].includes(state.phase)) { guard(cancelOperation); return; }
  if (state.page !== 'history' || mod || event.altKey) return;
  const fromSearch = event.target === $('#history-search');
  if (typing && !fromSearch) return;
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(event.key === 'ArrowDown' ? 1 : -1); return; }
  if (event.key === 'Enter' && state.selected && (!event.target.closest('button') || event.target.closest('.history-row'))) {
    event.preventDefault();
    const button = $('#history-detail [data-action="copy"]');
    if (button) guard(() => entryAction(button));
  }
});
$('#record-button').addEventListener('click', () => toggleRecording());
$('#cancel-button').addEventListener('click', () => guard(cancelOperation));
$('#import-button').addEventListener('click', () => guard(importAudio));
$('#model-link').addEventListener('click', () => page('models'));
$('#dismiss-error').addEventListener('click', () => $('#error-banner').hidden = true);
$('#quick-language').addEventListener('change', event => guard(() => saveSettings({language: event.target.value})));
$('#auto-copy').addEventListener('change', event => guard(() => saveSettings({autoCopy: event.target.checked})));
$('#auto-paste').addEventListener('change', event => guard(() => saveSettings({autoPaste: event.target.checked})));
$('#accessibility-button').addEventListener('click', () => guard(async () => { state.pastePermission = await api.pastePermission(); syncSettings(); }));
$('#context-input').addEventListener('input', () => { contextDirty = true; updateContextCount(); });
$('#formatting-select').addEventListener('change', event => guard(() => saveSettings({formatting: event.target.value})));
$('#remove-fillers').addEventListener('change', event => guard(() => saveSettings({removeFillers: event.target.checked})));
$('#voice-commands').addEventListener('change', event => guard(() => saveSettings({voiceCommands: event.target.checked})));
$('#keep-audio').addEventListener('change', event => guard(() => saveSettings({keepAudio: event.target.checked})));
$('#microphone-select').addEventListener('change', event => guard(() => saveSettings({microphoneId: event.target.value})));
$('#save-context').addEventListener('click', () => guard(async () => {
  await saveSettings({context: $('#context-input').value.trim()});
  const button = $('#save-context');
  button.classList.add('done'); button.innerHTML = `${icon('check')}<span>Сохранено</span>`;
  clearTimeout(button.doneTimer);
  button.doneTimer = setTimeout(() => { button.classList.remove('done'); button.textContent = 'Сохранить контекст'; }, 1800);
}));
$('#history-search').addEventListener('input', renderHistory);
function newDictionaryItem() { if (state.dictionaryTab === 'snippets') openSnippet(null, true); else openWord(null, true); }
$('#add-word').addEventListener('click', newDictionaryItem);
$('#snippet-trigger').addEventListener('input', () => validateSnippet());
$('#snippet-text').addEventListener('input', () => validateSnippet());
$('#cancel-snippet').addEventListener('click', () => openSnippet(state.snippets.find(e => e.id === editingSnippet) || null));
$('#delete-snippet').addEventListener('click', () => guard(async () => {
  if (!editingSnippet) return;
  state.snippets = await api.snippets(state.snippets.filter(e => e.id !== editingSnippet));
  openSnippet(state.snippets[0] || null); toast('Сниппет удалён');
}));
$('#snippet-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!validateSnippet()) return;
  const entry = {id: editingSnippet || crypto.randomUUID(), trigger: $('#snippet-trigger').value.trim(), text: $('#snippet-text').value};
  const entries = editingSnippet ? state.snippets.map(e => e.id === editingSnippet ? entry : e) : [...state.snippets, entry];
  try {
    state.snippets = await api.snippets(entries);
    openSnippet(state.snippets.find(e => e.id === entry.id) || null);
    toast('Сниппет сохранён');
  } catch (error) { validateSnippet((error.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
});
$('#word-input').addEventListener('input', () => validateWord());
$('#alias-input').addEventListener('keydown', event => {
  const input = event.target;
  if ((event.key === 'Enter' || event.key === ',') && input.value.trim()) { event.preventDefault(); addAliases(input.value); input.value = ''; }
  else if (event.key === 'Backspace' && !input.value && wordAliases.length) { wordAliases.pop(); renderAliases(); }
});
$('#cancel-word').addEventListener('click', () => openWord(state.dictionary.find(e => e.id === editingWord) || null));
$('#delete-word').addEventListener('click', () => guard(async () => {
  if (!editingWord) return;
  state.dictionary = await api.dictionary(state.dictionary.filter(e => e.id !== editingWord));
  openWord(state.dictionary[0] || null); toast('Слово удалено из словаря');
}));
$('#dictionary-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (!validateWord()) return;
  addAliases($('#alias-input').value); $('#alias-input').value = '';
  const entry = {id: editingWord || crypto.randomUUID(), word: $('#word-input').value.trim(), aliases: [...wordAliases]};
  const entries = editingWord ? state.dictionary.map(e => e.id === editingWord ? entry : e) : [...state.dictionary, entry];
  try {
    state.dictionary = await api.dictionary(entries);
    openWord(state.dictionary.find(e => e.id === entry.id) || state.dictionary.find(e => e.word === entry.word) || null);
    toast('Словарь обновлён');
  } catch (error) { validateWord((error.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')); }
});
api.onToggle(toggleRecording); api.onCancel(() => guard(cancelOperation));
api.onEngine(({status, error}) => { state.engine = status || null; state.engineError = error; updateEngine(); if (error) showError(new Error(error)); });
api.onSnapshot(snapshot => { state.history = snapshot.history; state.pendingRecordings = snapshot.pendingRecordings; renderResults(); renderRecovery(); renderProfiles(); });
api.onProgress(progress => {
  if (state.phase === 'opening') { state.phase = 'transcribing'; refreshControls(); }
  if (state.phase === 'transcribing') {
    if (progress.message) $('#record-description').textContent = progress.message;
    if (typeof progress.fraction === 'number') $('#transcribe-progress').value = progress.fraction;
    else $('#transcribe-progress').removeAttribute('value');
  }
  if (state.phase === 'downloading' && state.download) {
    if (progress.unit === 'B' && progress.total > 0) Object.assign(state.download, {completed: progress.completed, total: progress.total});
    else state.download.message = progress.message;
    updateDownloadProgress();
  }
});
window.addEventListener('beforeunload', releaseMicrophone);
$('#retry-recording').addEventListener('click', () => guard(retryRecording));
$('#delete-recording').addEventListener('click', () => guard(async () => {
  if (!isBusy() && state.pendingRecordings.length) await api.deleteRecording(state.pendingRecordings[0].id);
}));
paintIcons(); resetWave(); refreshControls(); openWord(null); renderResults();
guard(async () => {
  Object.assign(state, await api.boot());
  syncSettings(); openWord(state.dictionary[0] || null); renderResults(); updateEngine();
  if (state.engineError) showError(new Error(state.engineError));
  await listMicrophones();
});
