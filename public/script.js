'use strict';
// ShiftControl browser client. Time displayed = last server timestamp + monotonic elapsed.
const BREAK_MS = 50 * 60 * 1000;
const $ = id => document.getElementById(id);
let me = null;
let state = null;
let activeStream = null;
let screenGrant = null;           // Memory-only: never save to localStorage or sessionStorage.
let serverBase = Date.now();
let perfBase = performance.now();
let lastRefresh = 0;
let requestGeneration = 0;
let pending = false;
let toastTimer;
let refreshRunning = false;

function now() { return serverBase + (performance.now() - perfBase); }
function syncClock(timestamp) { serverBase = timestamp; perfBase = performance.now(); }
function fmt(ms, compact = false) {
  let sec = Math.floor(Math.max(0, ms) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = n => String(n).padStart(2, '0');
  return compact ? `${pad(h * 60 + m)}:${pad(s)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function stamp(t, timeOnly = false) {
  if (t == null) return '—';
  return new Date(t).toLocaleString('ru-RU', timeOnly ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}
function escapeHTML(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
}
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3900);
}
function offline(message = '') {
  $('connection').textContent = message;
  $('connection').classList.toggle('hidden', !message);
}
async function api(path, options = {}, includeScreen = false) {
  let response;
  try {
    response = await fetch(`/api${path}`, {
      credentials: 'same-origin',
      cache: 'no-store',
      ...options,
      headers: { ...(options.method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        ...(includeScreen && screenGrant ? { 'X-Screen-Grant': screenGrant } : {}), ...(options.headers || {}) },
      ...(options.method === 'POST' && !options.body ? { body: '{}' } : {})
    });
  } catch {
    offline('Нет соединения с сервером');
    throw new Error('Нет интернета или сервер недоступен. Таймеры не обнуляются.');
  }
  let payload;
  try { payload = await response.json(); } catch { payload = {}; }
  if (!response.ok || !payload.ok) {
    const error = new Error(payload.error || `Ошибка сервера (${response.status})`);
    error.code = payload.code;
    error.status = response.status;
    throw error;
  }
  offline('');
  return payload;
}
function consume(payload) {
  if (typeof payload.serverNow === 'number') syncClock(payload.serverNow);
  if (payload.state) state = payload.state;
  render();
}
function show(view) {
  for (const id of ['loginScreen', 'workerView', 'adminView']) $(id).classList.toggle('hidden', id !== view);
}
function isActiveShift() { return !!(me?.role === 'worker' && state?.startedAt != null && state?.endedAt == null); }
function streamLive() {
  return !!(activeStream && activeStream.getVideoTracks().some(track => track.readyState === 'live' && track.getSettings()?.displaySurface === 'monitor'));
}
function lockGate(message = '') {
  const locked = isActiveShift() && !(screenGrant && streamLive());
  $('screenGate').classList.toggle('hidden', !locked);
  $('workerView').inert = locked;
  if (message) { $('screenError').textContent = message; $('screenError').classList.remove('hidden'); }
  else $('screenError').classList.add('hidden');
  return locked;
}
function stopStream() {
  const grant = screenGrant;
  screenGrant = null;
  const stream = activeStream;
  activeStream = null;
  if (stream) for (const track of stream.getTracks()) { track.onended = null; track.stop(); }
  if (grant && me?.role === 'worker') {
    api('/worker/screen-revoke', { method: 'POST', headers: { 'X-Screen-Grant': grant } }).catch(() => {});
  }
}
async function acquireMonitor() {
  if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('Этот браузер не поддерживает демонстрацию экрана. Откройте сайт через HTTPS в современном браузере.');
  // Call immediately from the user's click; browsers require transient user activation.
  let stream;
  try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); }
  catch (e) {
    if (e?.name === 'NotAllowedError') throw new Error('Демонстрация отменена. Выберите весь монитор для продолжения.');
    throw new Error('Не удалось включить демонстрацию. Проверьте разрешения браузера.');
  }
  const track = stream.getVideoTracks()[0];
  if (!track || track.readyState !== 'live' || track.getSettings()?.displaySurface !== 'monitor') {
    stream.getTracks().forEach(t => t.stop());
    throw new Error('Выбрано окно или вкладка. Необходимо выбрать «Весь экран / Монитор».');
  }
  // A previous browser stream may no longer be needed.
  stopStream();
  activeStream = stream;
  track.addEventListener('ended', () => {
    if (activeStream !== stream) return;
    stopStream();
    if (lockGate('Демонстрация остановлена. Для продолжения выберите весь монитор.')) toast('Демонстрация экрана остановлена');
  });
  try {
    const response = await api('/worker/screen-grant', { method: 'POST', body: JSON.stringify({ displaySurface: track.getSettings().displaySurface }) });
    if (!streamLive()) throw new Error('Демонстрация прекратилась. Повторите попытку.');
    screenGrant = response.screenGrant;
    lockGate();
  } catch (e) {
    stopStream();
    throw e;
  }
}
function setBusy(value) {
  pending = value;
  document.querySelectorAll('button').forEach(btn => {
    if (btn.dataset.busy === 'true') { btn.disabled = value; if (!value) delete btn.dataset.busy; }
  });
}
async function workerAction(path, button) {
  if (pending) return;
  if (!screenGrant || !streamLive()) { lockGate('Для этого действия нужно предоставить демонстрацию всего экрана.'); return; }
  button.dataset.busy = 'true';
  button.disabled = true;
  setBusy(true);
  try {
    const response = await api(path, { method: 'POST' }, true);
    requestGeneration++;
    consume(response);
    if (path === '/worker/end') stopStream();
    lockGate();
  } catch (e) { handleError(e); }
  finally { setBusy(false); render(); }
}
function handleError(error) {
  if (error.status === 401) { toLogin('Сессия истекла. Войдите заново.'); return; }
  if (error.code === 'screen_required') { stopStream(); lockGate(error.message); }
  toast(error.message || 'Неизвестная ошибка');
}
async function startShift() {
  if (pending) return;
  pending = true;
  $('startShift').disabled = true;
  try {
    await acquireMonitor();
    const response = await api('/worker/start', { method: 'POST' }, true);
    requestGeneration++;
    consume(response);
    toast('Смена началась');
  } catch (e) { stopStream(); handleError(e); }
  finally { pending = false; render(); }
}
async function resumeScreen() {
  if (pending) return;
  pending = true;
  $('resumeScreen').disabled = true;
  try { await acquireMonitor(); toast('Демонстрация разрешена — смена продолжается'); }
  catch (e) { lockGate(e.message); toast(e.message); }
  finally { pending = false; $('resumeScreen').disabled = false; render(); }
}
function toLogin(message = '') {
  stopStream();
  requestGeneration++;
  me = null; state = null;
  $('screenGate').classList.add('hidden');
  $('loginError').textContent = message;
  $('loginError').classList.toggle('hidden', !message);
  $('password').value = '';
  show('loginScreen');
}
async function logout() {
  if (pending) return;
  pending = true;
  try {
    await api('/logout', { method: 'POST' });
    toLogin();
  } catch (e) {
    if (e.status === 401) toLogin();
    else toast('Выход не подтверждён сервером. Проверьте соединение и повторите.');
  } finally {
    pending = false;
    render();
  }
}
async function login(event) {
  event.preventDefault();
  $('loginButton').disabled = true;
  $('loginError').classList.add('hidden');
  try {
    const result = await api('/login', { method: 'POST', body: JSON.stringify({ login: $('login').value.trim(), password: $('password').value }) });
    me = result.user;
    consume(result);
    show(me.role === 'admin' ? 'adminView' : 'workerView');
    lockGate();
    $('password').value = '';
  } catch (e) {
    $('loginError').textContent = e.message;
    $('loginError').classList.remove('hidden');
  } finally { $('loginButton').disabled = false; }
}
async function refresh(showError = false) {
  if (!me || refreshRunning || pending) return;
  refreshRunning = true;
  const generation = requestGeneration;
  try {
    const result = await api(me.role === 'admin' ? '/admin/state' : '/worker/state');
    if (generation === requestGeneration && me) {
      if (me.role === 'worker' && state?.startedAt != null && result.state.startedAt == null) stopStream();
      consume(result);
      lockGate();
      lastRefresh = performance.now();
    }
  } catch (e) {
    if (e.status === 401) toLogin('Сессия истекла. Войдите заново.');
    else if (showError) toast(e.message);
  } finally { refreshRunning = false; }
}
function statusInfo(s) {
  return ({ not_started: ['Не начал смену', ''], active: ['Активен', 'on'], meal: ['На обеде', 'meal'], awaiting_return: ['Ожидает подтверждения', 'wait'], rest: ['На перерыве', 'pause'], done: ['Завершена', 'done'] })[s.status] || ['Неизвестно', ''];
}
function dynamicWorker() {
  if (me?.role !== 'worker' || !state) return;
  const s = state;
  const time = now();
  const elapsed = s.startedAt == null ? 0 : Math.max(0, (s.endedAt ?? time) - s.startedAt);
  const duration = s.shiftHours * 3600000;
  $('shiftTime').textContent = fmt(elapsed);
  $('shiftRemaining').textContent = fmt(Math.max(0, duration - elapsed));
  const progress = duration > 0 ? Math.min(100, elapsed / duration * 100) : 0;
  $('shiftProgress').style.width = `${progress}%`;
  $('progressTrack').setAttribute('aria-valuenow', String(Math.round(progress)));
  const mealRemaining = s.meal ? Math.max(0, BREAK_MS - (time - s.meal.startedAt)) : BREAK_MS;
  $('mealTime').textContent = fmt(mealRemaining, true);
  const restRemaining = Math.max(0, s.restRemaining - (s.restRunning && s.restLast != null ? Math.max(0, time - s.restLast) : 0));
  $('restTime').textContent = fmt(restRemaining, true);
  // Status transitions happen on server; reflect deadlines immediately while offline too.
  const computed = { ...s };
  if (s.status === 'meal' && mealRemaining === 0) computed.status = 'awaiting_return';
  if (s.status === 'rest' && restRemaining === 0) computed.status = 'active';
  const [label, klass] = statusInfo(computed);
  const tag = $('workerStatus');
  tag.textContent = label;
  tag.className = `status ${klass}`;
  $('mealState').textContent = s.meal == null ? 'Не начат' : s.meal.ack ? 'Возвращение подтверждено' : mealRemaining > 0 ? 'Идёт обеденный перерыв' : 'Ожидается подтверждение';
  $('restState').textContent = restRemaining === 0 ? 'Лимит исчерпан' : (s.restRunning ? 'Перерыв идёт' : restRemaining < BREAK_MS ? 'На паузе' : 'Перерыв не начат');
  const active = s.startedAt != null && s.endedAt == null;
  const mealBlocks = !!s.meal && !s.meal.ack;
  $('startShift').disabled = pending || active;
  $('startShift').classList.toggle('hidden', active);
  $('endShift').disabled = pending || !active;
  $('mealBtn').classList.toggle('hidden', !!s.meal);
  $('mealBtn').disabled = pending || !active || mealBlocks || s.restRunning || !!s.meal;
  $('backBtn').classList.toggle('hidden', !active || !mealBlocks || mealRemaining > 0);
  $('backBtn').disabled = pending;
  $('mealNotice').classList.toggle('hidden', !active || !mealBlocks || mealRemaining > 0);
  $('restStart').classList.toggle('hidden', !!s.restRunning && restRemaining > 0);
  $('restPause').classList.toggle('hidden', !s.restRunning || restRemaining === 0);
  $('restStart').textContent = restRemaining < BREAK_MS ? '▶ Продолжить' : '▶ Начать перерыв';
  $('restStart').disabled = pending || !active || mealBlocks || restRemaining === 0;
  $('restPause').disabled = pending || !active;
}
function eventHTML(e, withName = false) {
  return `<div class="event"><span class="event-time">${escapeHTML(stamp(e.at))}</span>${withName ? `<span class="event-name">${escapeHTML(e.name)}</span>` : ''}<span>${escapeHTML(e.text)}</span></div>`;
}
function renderWorker() {
  const s = state;
  $('workerName').textContent = me.name;
  $('workerDate').textContent = new Date(now()).toLocaleDateString('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' });
  $('shiftStartedAt').textContent = stamp(s.startedAt);
  $('shiftPlanned').textContent = `${s.shiftHours} ч`;
  const notice = $('workerNotice');
  notice.classList.toggle('hidden', !s.notice || s.notice.read);
  if (s.notice) {
    $('workerNoticeText').textContent = s.notice.text;
    $('workerNoticeAt').textContent = stamp(s.notice.at);
  }
  $('myEvents').innerHTML = (s.events?.length ? s.events.map(e => eventHTML(e)).join('') : '<div class="event muted">Событий пока нет.</div>');
  dynamicWorker();
}
function calcRest(s, t = now()) {
  return Math.max(0, s.restRemaining - (s.restRunning && s.restLast != null ? Math.max(0, t - s.restLast) : 0));
}
function renderAdminDynamic() {
  if (me?.role !== 'admin' || !state) return;
  const workers = state.workers;
  const counters = { active: 0, meal: 0, rest: 0, done: 0 };
  for (const s of workers) {
    let status = s.status;
    if (status === 'meal' && s.meal && now() >= s.meal.startedAt + BREAK_MS) status = 'awaiting_return';
    if (status === 'rest' && calcRest(s) <= 0) status = 'active';
    if (status === 'active') counters.active++;
    if (status === 'meal' || status === 'awaiting_return') counters.meal++;
    if (status === 'rest') counters.rest++;
    if (status === 'done') counters.done++;
    const [title, klass] = statusInfo({ status });
    const tag = $(`adminStatus${s.id}`);
    if (tag) { tag.className = `status ${klass}`; tag.textContent = title; }
    const elapsed = s.startedAt == null ? 0 : Math.max(0, (s.endedAt ?? now()) - s.startedAt);
    $(`adminShift${s.id}`).textContent = fmt(elapsed);
    $(`adminRest${s.id}`).textContent = fmt(calcRest(s), true);
    const mealLeft = s.meal == null ? BREAK_MS : Math.max(0, BREAK_MS - (now() - s.meal.startedAt));
    $(`adminMeal${s.id}`).textContent = s.meal == null ? 'Не начат' : s.meal.ack ? 'Вернулся ✓' : mealLeft > 0 ? fmt(mealLeft, true) : 'Ждёт «Я тут»';
  }
  $('statActive').textContent = counters.active;
  $('statMeal').textContent = counters.meal;
  $('statRest').textContent = counters.rest;
  $('statDone').textContent = counters.done;
}
function renderAdmin() {
  if (document.activeElement !== $('shiftHours')) $('shiftHours').value = state.shiftHours;
  $('adminWorkers').innerHTML = state.workers.map(s => `<article class="admin-worker"><div class="aw-head"><h2>${escapeHTML(s.name)}</h2><span class="status" id="adminStatus${s.id}"></span></div><div class="aw-time" id="adminShift${s.id}">00:00:00</div><div class="aw-sub">Начало: ${escapeHTML(stamp(s.startedAt))} · План: ${escapeHTML(s.shiftHours)} ч</div><div class="mini"><div><small>🍽️ Обед</small><b id="adminMeal${s.id}">—</b></div><div><small>☕ Daily Rest</small><b id="adminRest${s.id}">—</b></div></div><button class="danger reset-button" type="button" data-reset="${s.id}">Сбросить смену ${escapeHTML(s.name)}</button></article>`).join('');
  $('allEvents').innerHTML = state.events?.length ? state.events.map(e => eventHTML(e, true)).join('') : '<div class="event muted">Событий пока нет.</div>';
  renderAdminDynamic();
}
function render() {
  if (!me || !state) return;
  if (me.role === 'worker') renderWorker(); else renderAdmin();
  lockGate();
}
async function adminAction(path, body, button, success) {
  if (pending) return;
  pending = true;
  button.disabled = true;
  try {
    const response = await api(path, { method: 'POST', body: JSON.stringify(body) });
    requestGeneration++;
    consume(response);
    if (success) toast(success);
  } catch (e) { handleError(e); }
  finally { pending = false; button.disabled = false; render(); }
}

$('loginForm').addEventListener('submit', login);
for (const btn of document.querySelectorAll('.logout')) btn.addEventListener('click', logout);
$('gateLogout').addEventListener('click', logout);
$('startShift').addEventListener('click', startShift);
$('resumeScreen').addEventListener('click', resumeScreen);
for (const [id, path] of [['endShift','/worker/end'], ['mealBtn','/worker/meal'], ['backBtn','/worker/back'], ['restStart','/worker/rest-start'], ['restPause','/worker/rest-pause']]) {
  $(id).addEventListener('click', () => workerAction(path, $(id)));
}
$('markNotice').addEventListener('click', async () => {
  if (isActiveShift()) return workerAction('/worker/notice-read', $('markNotice'));
  if (pending) return;
  pending = true;
  $('markNotice').disabled = true;
  try {
    const response = await api('/worker/notice-read', { method: 'POST' });
    requestGeneration++;
    consume(response);
  } catch (e) { handleError(e); }
  finally { pending = false; $('markNotice').disabled = false; render(); }
});
$('saveSettings').addEventListener('click', () => adminAction('/admin/settings', { shiftHours: Number($('shiftHours').value) }, $('saveSettings'), 'Настройки сохранены'));
$('sendNotify').addEventListener('click', async () => {
  const message = $('notifyText').value.trim();
  if (!message) return toast('Введите сообщение');
  await adminAction('/admin/notify', { target: $('notifyWorker').value, text: message }, $('sendNotify'), 'Уведомление отправлено');
  // On success the latest notification is visible in state; preserve input on error.
  if (state?.events?.[0]?.text.includes(message)) $('notifyText').value = '';
});
$('adminWorkers').addEventListener('click', e => {
  const button = e.target.closest('button[data-reset]');
  if (!button) return;
  const id = Number(button.dataset.reset);
  const name = id === 0 ? 'Ker' : id === 1 ? 'Sanyo' : null;
  if (name && window.confirm(`Сбросить текущую смену, обед и Daily Rest работника ${name}? История событий останется сохранённой.`)) {
    adminAction('/admin/reset', { target: id }, button, `Смена ${name} сброшена`);
  }
});
window.addEventListener('online', () => refresh());
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(() => {
  $('clock').textContent = new Date().toLocaleTimeString('ru-RU');
  if (me?.role === 'worker') dynamicWorker();
  if (me?.role === 'admin') renderAdminDynamic();
}, 1000);
setInterval(() => { if (me && !document.hidden) refresh(); }, 12000);
(async () => {
  $('clock').textContent = new Date().toLocaleTimeString('ru-RU');
  try {
    const payload = await api('/session');
    me = payload.user;
    consume(payload);
    show(me.role === 'admin' ? 'adminView' : 'workerView');
    lockGate();  // Every newly opened page needs a NEW getDisplayMedia gesture.
  } catch (e) {
    if (e.status !== 401) toast(e.message);
    show('loginScreen');
  }
})();
