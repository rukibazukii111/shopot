const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const api = window.shopot;
const icons = {
  mic: '<rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/>',
  history: '<path d="M3 11a9 9 0 1 1 2.8 7M3 4v7h7M12 7v5l3 2"/>',
  book: '<path d="M12 5v16M12 5C9 2 4 3 2 4v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-2-10 1Z"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5Zm-10 10 10 5 10-5M2 17l10 5 10-5"/>',
  shield: '<path d="m12 2 9 4v6c0 5-9 10-9 10S3 17 3 12V6l9-4Z"/><path d="m8 12 3 3 5-6"/>',
  settings: '<path d="m9 3 1-1h4l1 3 3 1 3 1v4l-2 2 1 3-2 3-3-1-2 3H9l-1-3-3-1-2-3 2-3-1-3 3-2 2-3Z"/><circle cx="12" cy="12" r="3"/>',
  sparkle: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Zm7-2v4m-2-2h4"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>', arrow: '<path d="M4 12h16m-6-6 6 6-6 6"/>',
  upload: '<path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5"/>',
  search: '<circle cx="10.5" cy="10.5" r="7.5"/><path d="m16 16 5 5"/>',
  plus: '<path d="M12 4v16M4 12h16"/>', cpu: '<rect x="5" y="5" width="14" height="14" rx="3"/><path d="M9 1v4m6-4v4M9 19v4m6-4v4M1 9h4m-4 6h4m14-6h4m-4 6h4"/><rect x="9" y="9" width="6" height="6" rx="1"/>',
  text: '<path d="M5 3h10l4 4v14H5V3Zm9 0v5h5M8 12h8m-8 4h6"/>',
  copy: '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  download: '<path d="M12 3v13m-5-5 5 5 5-5M4 16v5h16v-5"/>',
  trash: '<path d="M3 6h18M5 6l1 15h12l1-15M9 6V3h6v3M10 10v7m4-7v7"/>',
  edit: '<path d="m15 4 5 5M3 21l5-1L21 7a3.5 3.5 0 0 0-5-5L3 15v6Z"/>',
  play: '<path d="m8 3 13 9-13 9V3Z"/>', stop: '<rect x="5" y="5" width="14" height="14" rx="2"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
};
function icon(name) { return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.text}</svg>`; }
function paintIcons(parent = document) { parent.querySelectorAll('[data-icon]').forEach(el => el.innerHTML = icon(el.dataset.icon)); }
function escapeHtml(value) { return String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const names = {dictation: 'Диктовка', history: 'История', dictionary: 'Мой словарь', models: 'Модели', settings: 'Настройки'};
const modes = {natural: 'Естественно', minimal: 'Минимум знаков', raw: 'Исходный результат'};
const modelNames = {gigaam: 'GigaAM', turbo: 'Whisper turbo', small: 'Whisper small', 'large-v3': 'Whisper large-v3'};
const state = {settings: {}, dictionary: [], history: [], pendingRecordings: [], engine: null, page: 'dictation', phase: 'idle', operation: 0, hotkeyRegistered: false};
let recorder, stream, audioContext, analyser, raf, recordingTimer, startedAt, recordingCanceled = false;
let editingWord = null, toastTimer, blobUrls = [], contextDirty = false, captureId = null;
const drafts = new Map();

function toast(message) { $('#toast').textContent = message; $('#toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').hidden = true, 4000); }
function showError(error) { $('#error-text').textContent = (error.message || String(error)).replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''); $('#error-banner').hidden = false; }
async function guard(action) { try { return await action(); } catch (error) { showError(error); } }
function page(name) {
  if (!(name in names)) return;
  state.page = name;
  $$('.page').forEach(el => el.hidden = el.id !== `page-${name}`);
  $$('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.page === name));
  $('#breadcrumb').textContent = names[name];
  window.scrollTo({top: 0, left: 0, behavior: 'instant'});
  if (name === 'history') renderHistory();
  if (name === 'models') renderModels();
}
function isBusy() { return state.phase !== 'idle'; }
function installed() { return Boolean(state.engine?.models?.find(m => m.id === state.settings.model)?.installed); }
function duration(seconds) { const s = Math.max(0, Math.round(seconds || 0)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; }
function dateLabel(iso) { return new Intl.DateTimeFormat('ru', {day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit'}).format(new Date(iso)); }
function pluralWords(number) { return number % 10 === 1 && number % 100 !== 11 ? 'слово' : [2, 3, 4].includes(number % 10) && ![12,13,14].includes(number % 100) ? 'слова' : 'слов'; }
function updateEngine() {
  syncLanguages();
  $('#engine-dot').className = 'status-dot' + (state.engine ? '' : state.engineError ? ' error' : ' starting');
  $('#engine-label').textContent = state.engine ? 'Локальный движок' : state.engineError ? 'Движок недоступен' : 'Запускаем движок';
  $('#active-model').textContent = modelNames[state.settings.model] || 'Whisper turbo';
  $('#active-model-state').textContent = installed() ? 'На устройстве · CPU' : 'Нужно скачать модель';
  refreshControls(); renderModels();
}
function refreshControls() {
  const phase = state.phase;
  const recordingNow = phase === 'recording';
  const processing = ['transcribing', 'stopping', 'opening'].includes(phase);
  $('#recorder-card').classList.toggle('recording', recordingNow);
  $('#recorder-card').classList.toggle('processing', processing);
  $('#record-button').disabled = !['idle', 'recording'].includes(phase) || (!recordingNow && !state.engine);
  $('#record-label').textContent = ({recording: 'Закончить запись', requesting: 'Подключаем микрофон',
    stopping: 'Завершаем запись', transcribing: 'Распознаём', canceling: 'Отменяем',
    downloading: 'Модель загружается', opening: 'Выбираем файл'})[phase] || (!installed() ? 'Скачать модель' : 'Начать диктовку');
  $('#record-button [data-icon]').innerHTML = icon(recordingNow ? 'stop' : 'mic');
  $('#cancel-button').hidden = !['requesting', 'recording', 'transcribing'].includes(phase);
  $('#import-button').disabled = isBusy() || !state.engine || !installed();
  $('#quick-language').disabled = isBusy(); $('#quick-mode').disabled = isBusy();
  $('#record-progress').hidden = !processing;
  $('#download-panel').hidden = phase !== 'downloading';
  renderRecovery();
  if (recordingNow) {
    $('#record-status').innerHTML = '<span class="status-dot"></span>Идёт запись';
    $('#record-heading').textContent = 'Слушаю тебя';
    $('#record-description').textContent = 'Говори свободно. Когда закончишь — нажми ещё раз.';
  } else if (phase === 'requesting') {
    $('#record-status').textContent = 'Подключаем микрофон';
    $('#record-heading').textContent = 'Готовлюсь слушать';
    $('#record-description').textContent = 'Если система запросит доступ — разреши микрофон для Шёпота.';
  } else if (phase === 'canceling') {
    $('#record-status').textContent = 'Отменяем операцию';
    $('#record-heading').textContent = 'Останавливаем запись';
    $('#record-description').textContent = 'Подожди немного.';
  } else if (processing) {
    $('#record-status').textContent = 'Обрабатываем запись';
    $('#record-heading').textContent = phase === 'opening' ? 'Открываем запись' : 'Собираем твои слова';
    $('#record-description').textContent = 'Распознавание выполняется на твоём компьютере.';
  } else {
    $('#record-status').innerHTML = '<span class="status-dot"></span>' + (installed() ? 'Готов к диктовке' : 'Сначала выбери модель');
    $('#record-heading').textContent = installed() ? 'Пусть мысли звучат' : 'Начнём с модели';
    $('#record-description').textContent = installed() ? 'Нажми на микрофон или используй горячую клавишу' : 'Один раз скачай модель — и можно диктовать без интернета.';
  }
}
async function saveSettings(changes) {
  state.settings = await api.settings({...state.settings, ...changes});
  if ('context' in changes) contextDirty = false;
  syncSettings(); updateEngine();
}
function syncLanguages() {
  // Russian-only models (GigaAM) cannot take English or auto-detection. The list arrives with the engine status.
  const languages = state.engine?.models?.find(m => m.id === state.settings.model)?.languages || ['ru', 'en', 'auto'];
  for (const option of $('#quick-language').options) option.disabled = !languages.includes(option.value);
}
function syncSettings() {
  $('#quick-language').value = state.settings.language;
  $('#quick-mode').value = state.settings.mode;
  $('#auto-copy').checked = state.settings.autoCopy;
  $('#auto-paste').checked = state.settings.autoPaste;
  $('#keep-audio').checked = state.settings.keepAudio;
  $('#formatting-select').value = state.settings.formatting;
  if (!contextDirty) $('#context-input').value = state.settings.context;
  $('#accessibility-row').hidden = state.platform !== 'darwin';
  $('#accessibility-status').textContent = state.pastePermission ? 'Доступ разрешён. Автовставка готова.' : 'Разреши Шёпоту управление в Системных настройках → Конфиденциальность и безопасность → Универсальный доступ.';
  $('#mode-description').textContent = {natural: 'Пунктуация модели и замены из твоего словаря. Слова сохраняются.', minimal: 'Убираем большинство знаков в конце слов. Написание версий и адресов сохраняется.', raw: 'Текст, который вернула модель, включая её пунктуацию. Без наших замен и правок.'}[state.settings.mode];
  if (state.platform === 'darwin') { $$('.modifier-key').forEach(el => el.textContent = '⌘'); $$('.paste-hint').forEach(el => el.textContent = '⌘V'); }
  $('#hotkey-description').textContent = state.hotkeyRegistered ? 'Открывает виджет, начинает и заканчивает запись. Escape во время записи — отменить её.' : 'Сочетание занято другим приложением. Используй кнопку записи или освободи сочетание и перезапусти Шёпот.';
  $('.shortcut-anywhere').textContent = state.hotkeyRegistered ? 'из любого приложения' : 'сочетание занято';
}

const idleHeights = [5,8,13,9,19,27,16,32,41,26,45,53,32,46,65,43,57,71,50,64,47,38,58,42,29,35,22,32,17,24,13,8,12,6,4];
// Styles on waveform bars are generated locally; use the CSSOM rather than inline HTML.
$('#waveform').innerHTML = idleHeights.map(() => '<i></i>').join('');
function resetWave() { $$('#waveform i').forEach((bar, i) => bar.style.height = idleHeights[i] + 'px'); }
resetWave();
function animateWave() {
  if (!analyser || state.phase !== 'recording') return;
  const data = new Uint8Array(analyser.frequencyBinCount); analyser.getByteFrequencyData(data);
  $$('#waveform i').forEach((bar, i) => { const value = data[Math.floor(i * data.length / 55)]; bar.style.height = Math.max(4, value / 3.2) + 'px'; });
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
  resetWave();
}
async function startRecording(session) {
  if (isBusy()) return;
  if (!session && !installed()) { page('models'); return; }
  const operation = ++state.operation;
  state.phase = 'requesting'; refreshControls();
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
        state.phase = 'idle'; refreshControls(); toast('Запись отменена'); return;
      }
      state.phase = 'transcribing'; refreshControls();
      const operation = ++state.operation;
      try {
        const audio = new Uint8Array(await new Blob(chunks, {type: mime}).arrayBuffer());
        if (!audio.length) {
          api.captureUpdate({id: session.id, phase: 'canceled'});
          toast('Запись слишком короткая. Попробуй ещё раз.'); return;
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
    $('#record-time').textContent = '00:00'; api.captureUpdate({id: session.id, phase: 'recording', elapsed: 0}); refreshControls(); animateWave();
    recordingTimer = setInterval(() => {
      const elapsed = (Date.now() - startedAt) / 1000; $('#record-time').textContent = duration(Math.floor(elapsed));
      const samples = new Uint8Array(analyser.frequencyBinCount); analyser.getByteTimeDomainData(samples);
      const rms = Math.sqrt(samples.reduce((sum, value) => sum + ((value - 128) / 128) ** 2, 0) / samples.length);
      api.captureUpdate({id: session.id, phase: 'recording', elapsed, level: Math.min(1, rms * 6)});
      if (elapsed >= 15 * 60) { toast('Достигнут предел записи — 15 минут'); stopRecording(); }
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
    await api.cancel(); captureId = null; state.phase = 'idle'; updateEngine(); toast('Операция отменена');
  }
}
function acceptResult(result) {
  if (result.canceled) return;
  if (result.noSpeech) { toast('Речь не обнаружена. Попробуй говорить ближе к микрофону.'); return; }
  const entry = result.entry;
  state.history = [entry, ...state.history.filter(e => e.id !== entry.id)]; renderResults();
  toast(result.message || (result.copied ? 'Текст скопирован' : 'Диктовка готова и сохранена в истории'));
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
  $('#recovery-title').textContent = entries.length === 1 ? 'Запись сохранена — можно повторить распознавание' : `Ожидают распознавания: ${entries.length}`;
  $('#recovery-detail').textContent = `${dateLabel(entries[0].createdAt)} · ${entries[0].source}. После распознавания текст появится в истории.`;
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

function resultCard(entry) {
  if (drafts.has(entry.id)) entry = {...entry, text: drafts.get(entry.id)};
  const count = entry.text.trim().split(/\s+/u).filter(Boolean).length;
  const raw = (entry.words || []).length ? entry.words.map(w => w.probability < 0.65
    ? `<mark class="uncertain" title="Оценка модели ${Math.round(w.probability*100)}%. Это не вероятность правильного слова.">${escapeHtml(w.word)}</mark>` : escapeHtml(w.word)).join('') : escapeHtml(entry.rawText);
  const doubts = (entry.words || []).filter(w => w.probability < 0.65).length;
  return `<article class="result-card" data-entry="${escapeHtml(entry.id)}">
    <div class="result-head"><span>${icon('text')}</span><span class="result-date">${escapeHtml(dateLabel(entry.createdAt))}</span><span class="pill">${escapeHtml(modelNames[entry.model] || entry.model)}</span><span class="pill">${escapeHtml(modes[entry.mode] || '')}</span></div>
    <div class="result-body"><div class="result-tabs"><button class="result-tab active" data-result-tab="text">Текст</button><button class="result-tab" data-result-tab="raw">Исходник${doubts ? ` · ${doubts} проверить` : ''}</button></div>
    <div data-result-panel="text"><textarea class="transcript-editor" aria-label="Текст диктовки" rows="${Math.min(7, Math.max(3, Math.ceil(entry.text.length / 100)))}">${escapeHtml(entry.text)}</textarea>${entry.replacements?.length ? `<div class="replacement-note">Замены из словаря: ${entry.replacements.map(r => `${escapeHtml(r.from)} → ${escapeHtml(r.to)}`).join(', ')}</div>` : ''}</div>
    <div data-result-panel="raw" hidden><p class="raw-text">${raw}</p><div class="review-note">${doubts ? 'Жёлтым — слова с низкой оценкой модели. ' : ''}Исходный результат сохранён без правок. Пунктуацию добавила сама модель.</div></div>
    <div class="audio-slot"></div></div>
    <div class="result-foot"><span class="result-metrics">${duration(entry.duration)} аудио · ${count} ${pluralWords(count)} · ${Math.round(entry.elapsed)} с обработки</span><div class="result-actions">${entry.audioFile ? `<button class="icon-button" data-action="play" aria-label="Прослушать запись" title="Прослушать">${icon('play')}</button>` : ''}<button class="icon-button" data-action="export" aria-label="Сохранить текст в файл" title="Сохранить .txt">${icon('download')}</button><button class="icon-button" data-action="delete" aria-label="Удалить диктовку" title="Удалить">${icon('trash')}</button><button class="copy-button" data-action="copy">${icon('copy')}Скопировать</button></div></div></article>`;
}
function renderResults() {
  blobUrls.forEach(url => URL.revokeObjectURL(url)); blobUrls = [];
  $('#history-count').textContent = state.history.length;
  $('#latest-result').innerHTML = state.history.length ? resultCard(state.history[0]) : `<div class="empty-state"><span class="empty-icon">${icon('text')}</span><div><strong>Здесь появятся твои слова</strong><p>Первая диктовка — и чистый лист станет началом чего-то хорошего.</p></div></div>`;
  if (state.page === 'history') renderHistory();
}
function renderHistory() {
  const query = $('#history-search').value.toLocaleLowerCase();
  const entries = state.history.filter(e => e.text.toLocaleLowerCase().includes(query) || e.rawText.toLocaleLowerCase().includes(query));
  $('#history-list').innerHTML = entries.length ? entries.map(resultCard).join('') : `<div class="empty-page">${icon('history')}${query ? 'По этому запросу ничего не найдено' : 'Пока здесь тихо. Начни с первой диктовки.'}</div>`;
}
function renderDictionary() {
  $('#dictionary-list').innerHTML = state.dictionary.length ? state.dictionary.map(entry => `<div class="dictionary-row" data-word-id="${escapeHtml(entry.id)}"><span class="dictionary-word">${escapeHtml(entry.word)}</span><span>${entry.aliases.length ? entry.aliases.map(escapeHtml).join(', ') : 'Только подсказка модели'}</span><div><button class="icon-button" data-word-action="edit" aria-label="Изменить ${escapeHtml(entry.word)}">${icon('edit')}</button><button class="icon-button" data-word-action="delete" aria-label="Удалить ${escapeHtml(entry.word)}">${icon('trash')}</button></div></div>`).join('') : '<div class="empty-page">Добавь первое слово, которое модель часто путает.</div>';
}
function wordDialog(entry = null) {
  editingWord = entry?.id ?? null;
  $('#word-dialog-title').textContent = entry ? 'Изменить слово' : 'Новое слово';
  $('#word-input').value = entry?.word ?? ''; $('#alias-input').value = entry?.aliases.join(', ') ?? '';
  $('#word-error').textContent = ''; $('#dictionary-dialog').showModal(); $('#word-input').focus();
}
function renderModels() {
  const descriptions = {
    gigaam: {title: 'Быстрая', subtitle: 'GIGAAM V3 · ТОЛЬКО РУССКИЙ', text: 'Короткая фраза распознаётся за доли секунды. Мало памяти, есть пунктуация.', tag: 'РЕКОМЕНДУЕМ'},
    turbo: {title: 'Точная', subtitle: 'WHISPER LARGE-V3 TURBO', text: 'Лучше со сленгом и терминами, понимает английский. Распознаёт медленнее: несколько секунд даже на короткую фразу.', tag: '1,6 ГБ'},
    small: {title: 'Лёгкая', subtitle: 'WHISPER SMALL', text: 'Меньше загрузка и расход памяти. На сложных словах может ошибаться чаще.', tag: '484 МБ'},
    'large-v3': {title: 'Полная', subtitle: 'WHISPER LARGE-V3', text: 'Полная модель для сравнения качества. Требует больше памяти и времени.', tag: '3,1 ГБ'},
  };
  $('#models-list').innerHTML = ['gigaam', 'small', 'turbo', 'large-v3'].map(id => {
    const desc = descriptions[id]; const model = state.engine?.models?.find(m => m.id === id); const selected = state.settings.model === id;
    return `<article class="card model-card ${selected ? 'selected' : ''}"><div class="model-topline"><span class="model-symbol">${icon(id === 'small' ? 'sparkle' : 'layers')}</span><span class="model-tag">${selected ? 'ВЫБРАНА' : desc.tag}</span></div><h2>${desc.title}</h2><p class="model-subtitle">${desc.subtitle}</p><p class="model-summary">${desc.text}</p><div class="model-size">${model?.installed ? '✓ Уже на компьютере' : `${model?.size || (id === 'turbo' ? '1,6 ГБ' : desc.tag)} · загрузка с Hugging Face`}</div><button class="${selected && model?.installed ? 'secondary' : 'primary'}-button" data-model="${id}" ${isBusy() || !state.engine || (selected && model?.installed) ? 'disabled' : ''}>${model?.installed ? (selected ? 'Используется' : 'Выбрать модель') : `${icon('download')}Скачать`}</button></article>`;
  }).join('');
}
async function selectModel(id) {
  if (isBusy()) return;
  const model = state.engine.models.find(m => m.id === id);
  // Russian-only models switch the language along with the model.
  const changes = {model: id, ...(model.languages?.includes(state.settings.language) === false ? {language: 'ru'} : {})};
  if (model.installed) { await saveSettings(changes); renderModels(); toast('Модель выбрана'); return; }
  const operation = ++state.operation;
  state.phase = 'downloading'; refreshControls(); renderModels();
  $('#download-title').textContent = 'Скачиваем ' + modelNames[id];
  $('#download-detail').textContent = 'Подключаемся…'; $('#download-progress').removeAttribute('value');
  try {
    const engine = await api.download(id);
    if (operation === state.operation) { state.engine = engine; await saveSettings(changes); toast('Модель готова. Можно диктовать.'); }
  } catch (error) { if (operation === state.operation) showError(error); }
  finally { if (operation === state.operation) { state.phase = 'idle'; updateEngine(); } }
}

document.addEventListener('click', event => {
  const nav = event.target.closest('[data-page]'); if (nav) page(nav.dataset.page);
  const modelButton = event.target.closest('[data-model]'); if (modelButton) guard(() => selectModel(modelButton.dataset.model));
  const wordButton = event.target.closest('[data-word-action]');
  if (wordButton) {
    const id = wordButton.closest('[data-word-id]').dataset.wordId;
    const entry = state.dictionary.find(e => e.id === id);
    if (wordButton.dataset.wordAction === 'edit') wordDialog(entry);
    else guard(async () => { state.dictionary = await api.dictionary(state.dictionary.filter(e => e.id !== id)); renderDictionary(); toast('Слово удалено из словаря'); });
  }
  const tab = event.target.closest('[data-result-tab]');
  if (tab) { const card = tab.closest('.result-card'); card.querySelectorAll('[data-result-tab]').forEach(el => el.classList.toggle('active', el === tab)); card.querySelectorAll('[data-result-panel]').forEach(el => el.hidden = el.dataset.resultPanel !== tab.dataset.resultTab); }
  const button = event.target.closest('[data-action]');
  if (button) guard(async () => {
    const card = button.closest('.result-card'); const entry = state.history.find(e => e.id === card.dataset.entry);
    const text = card.querySelector('.transcript-editor').value;
    if (button.dataset.action === 'copy') { await api.copy(text); toast('Скопировано'); }
    if (button.dataset.action === 'export') { if (await api.saveText(text)) toast('Текст сохранён в файл'); }
    if (button.dataset.action === 'delete' && await api.deleteEntry(entry.id)) { state.history = state.history.filter(e => e.id !== entry.id); renderResults(); }
    if (button.dataset.action === 'play') {
      const existing = card.querySelector('audio'); if (existing) { existing.paused ? await existing.play() : existing.pause(); return; }
      const data = await api.readAudio(entry.id); if (!data) { toast('Аудиозапись не найдена'); return; }
      const url = URL.createObjectURL(new Blob([data])); blobUrls.push(url);
      const audio = document.createElement('audio'); audio.className = 'audio-player'; audio.controls = true; audio.src = url;
      card.querySelector('.audio-slot').append(audio); await audio.play();
    }
  });
});
document.addEventListener('change', event => {
  if (event.target.matches('.transcript-editor')) guard(async () => {
    const id = event.target.closest('.result-card').dataset.entry; const text = event.target.value;
    const entry = await api.updateEntry(id, text);
    if (drafts.get(id) === text) drafts.delete(id);
    state.history = state.history.map(e => e.id === id ? entry : e);
    $$('.result-card').filter(c => c.dataset.entry === id).forEach(c => c.querySelector('.transcript-editor').value = text);
  });
});
document.addEventListener('input', event => {
  if (event.target.matches('.transcript-editor')) drafts.set(event.target.closest('.result-card').dataset.entry, event.target.value);
});
$('#record-button').addEventListener('click', () => toggleRecording());
$('#cancel-button').addEventListener('click', () => guard(cancelOperation));
$('#cancel-download').addEventListener('click', () => guard(cancelOperation));
$('#import-button').addEventListener('click', () => guard(importAudio));
$('#model-link').addEventListener('click', () => page('models'));
$('#all-history').addEventListener('click', () => page('history'));
$('.brand').addEventListener('click', event => { event.preventDefault(); page('dictation'); });
$('#dismiss-error').addEventListener('click', () => $('#error-banner').hidden = true);
$('#quick-language').addEventListener('change', event => guard(() => saveSettings({language: event.target.value})));
$('#quick-mode').addEventListener('change', event => guard(() => saveSettings({mode: event.target.value})));
$('#auto-copy').addEventListener('change', event => guard(() => saveSettings({autoCopy: event.target.checked})));
$('#auto-paste').addEventListener('change', event => guard(() => saveSettings({autoPaste: event.target.checked})));
$('#accessibility-button').addEventListener('click', () => guard(async () => { state.pastePermission = await api.pastePermission(); syncSettings(); }));
$('#context-input').addEventListener('input', () => { contextDirty = true; });
$('#formatting-select').addEventListener('change', event => guard(() => saveSettings({formatting: event.target.value})));
$('#keep-audio').addEventListener('change', event => guard(() => saveSettings({keepAudio: event.target.checked})));
$('#microphone-select').addEventListener('change', event => guard(() => saveSettings({microphoneId: event.target.value})));
$('#save-context').addEventListener('click', () => guard(async () => { await saveSettings({context: $('#context-input').value.trim()}); toast('Контекст сохранён'); }));
$('#history-search').addEventListener('input', renderHistory);
$('#add-word').addEventListener('click', () => wordDialog());
['#close-word', '#cancel-word'].forEach(id => $(id).addEventListener('click', () => $('#dictionary-dialog').close()));
$('#dictionary-form').addEventListener('submit', async event => {
  event.preventDefault();
  const entry = {id: editingWord || crypto.randomUUID(), word: $('#word-input').value.trim(), aliases: $('#alias-input').value.split(',').map(s => s.trim()).filter(Boolean)};
  const entries = editingWord ? state.dictionary.map(e => e.id === editingWord ? entry : e) : [...state.dictionary, entry];
  try { state.dictionary = await api.dictionary(entries); renderDictionary(); $('#dictionary-dialog').close(); toast('Словарь обновлён'); }
  catch (error) { $('#word-error').textContent = error.message; }
});
api.onToggle(toggleRecording); api.onCancel(() => guard(cancelOperation));
api.onEngine(({status, error}) => { state.engine = status || null; state.engineError = error; updateEngine(); if (error) showError(new Error(error)); });
api.onSnapshot(snapshot => { state.history = snapshot.history; state.pendingRecordings = snapshot.pendingRecordings; renderResults(); renderRecovery(); });
api.onProgress(progress => {
  if (state.phase === 'opening') { state.phase = 'transcribing'; refreshControls(); }
  if (state.phase === 'transcribing') {
    $('#record-description').textContent = progress.message;
    if (typeof progress.fraction === 'number') $('#transcribe-progress').value = progress.fraction;
    else $('#transcribe-progress').removeAttribute('value');
  }
  if (state.phase === 'downloading') {
    if (progress.unit === 'B' && progress.total > 0) {
      $('#download-progress').max = progress.total; $('#download-progress').value = progress.completed;
      $('#download-detail').textContent = `${Math.round(progress.completed/1e6)} / ${Math.round(progress.total/1e6)} МБ`;
    } else $('#download-detail').textContent = progress.message;
  }
});
window.addEventListener('beforeunload', releaseMicrophone);
$('#retry-recording').addEventListener('click', () => guard(retryRecording));
$('#delete-recording').addEventListener('click', () => guard(async () => {
  if (!isBusy() && state.pendingRecordings.length) await api.deleteRecording(state.pendingRecordings[0].id);
}));
paintIcons();
guard(async () => {
  Object.assign(state, await api.boot());
  syncSettings(); renderDictionary(); renderResults(); updateEngine();
  if (state.engineError) showError(new Error(state.engineError));
  await listMicrophones();
});
