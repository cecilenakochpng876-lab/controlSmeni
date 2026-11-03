/** ShiftControl — Cloudflare Worker + existing D1 schema, no migration required. */
const USERS = {
  Ker: { id: 0, name: 'Ker', role: 'worker', password: 'FKo2mf3FR' },
  Sanyo: { id: 1, name: 'Sanyo', role: 'worker', password: 'LVEzVe93deL' },
  Admin: { id: -1, name: 'Admin', role: 'admin', password: 'Amderof33' }
};
const BREAK_MS = 50 * 60 * 1000;
const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const GRANT_MS = 24 * 60 * 60 * 1000;
const securityHeaders = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'display-capture=(self)',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"
};

class HttpError extends Error {
  constructor(status, message, code = 'request_error') { super(message); this.status = status; this.code = code; }
}
const fail = (status, message, code) => { throw new HttpError(status, message, code); };
const J = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...securityHeaders, ...extra }
});
const ok = (data, extra) => J({ ok: true, ...data }, 200, extra);
const q = (env, sql, args = []) => env.DB.prepare(sql).bind(...args).run();
const one = (env, sql, args = []) => env.DB.prepare(sql).bind(...args).first();
const all = async (env, sql, args = []) => (await env.DB.prepare(sql).bind(...args).all()).results;
const changed = result => Number(result?.meta?.changes || 0) > 0;
const who = id => id === 0 ? 'Ker' : id === 1 ? 'Sanyo' : 'Admin';
const shiftKey = (id, startedAt) => `shiftDuration:${id}:${startedAt}`;
const epochKey = id => `screenEpoch:${id}`;
const screenKey = token => `screen:${token}`;

const initializedBindings = new WeakMap();
async function init(env) {
  // Uses exactly the four tables and columns from the supplied schema.sql.
  await q(env, 'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL)');
  await q(env, 'CREATE TABLE IF NOT EXISTS workers(id INTEGER PRIMARY KEY,name TEXT NOT NULL,startedAt INTEGER,endedAt INTEGER,mealStarted INTEGER,mealFinished INTEGER DEFAULT 0,mealAck INTEGER DEFAULT 0,restRemaining INTEGER NOT NULL,restRunning INTEGER DEFAULT 0,restLast INTEGER,notice TEXT,noticeAt INTEGER,noticeRead INTEGER DEFAULT 0)');
  await q(env, 'CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,workerId INTEGER,at INTEGER,text TEXT)');
  await q(env, 'CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY,userId INTEGER,role TEXT,expiresAt INTEGER)');
  await q(env, "INSERT OR IGNORE INTO settings(key,value) VALUES('shiftHours','8')");
  await q(env, 'INSERT OR IGNORE INTO workers(id,name,restRemaining) VALUES(?,?,?)', [0, 'Ker', BREAK_MS]);
  await q(env, 'INSERT OR IGNORE INTO workers(id,name,restRemaining) VALUES(?,?,?)', [1, 'Sanyo', BREAK_MS]);
}
async function ensureInit(env) {
  let promise = initializedBindings.get(env.DB);
  if (!promise) {
    promise = init(env).catch(error => { initializedBindings.delete(env.DB); throw error; });
    initializedBindings.set(env.DB, promise);
  }
  await promise;
}
const cookie = req => /(?:^|;\s*)sc_session=([^;]+)/.exec(req.headers.get('Cookie') || '')?.[1] || null;
async function session(req, env) {
  const token = cookie(req);
  if (!token) return null;
  const row = await one(env, 'SELECT userId,role,expiresAt FROM sessions WHERE token=? AND expiresAt>?', [token, Date.now()]);
  if (!row || !((row.role === 'admin' && row.userId === -1) || (row.role === 'worker' && (row.userId === 0 || row.userId === 1)))) return null;
  return { ...row, token };
}
async function log(env, workerId, text, at = Date.now()) {
  await q(env, 'INSERT INTO events(workerId,at,text) VALUES(?,?,?)', [workerId, at, text]);
}
async function getSetting(env, key) { return (await one(env, 'SELECT value FROM settings WHERE key=?', [key]))?.value ?? null; }
async function setSetting(env, key, value) {
  await q(env, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, String(value)]);
}
async function shiftHours(env) {
  const hours = Number(await getSetting(env, 'shiftHours'));
  return Number.isFinite(hours) && hours >= 1 && hours <= 24 ? hours : 8;
}
async function worker(env, id) {
  const row = await one(env, 'SELECT * FROM workers WHERE id=?', [id]);
  if (!row) fail(404, 'Работник не найден', 'worker_missing');
  return row;
}
async function settleWorker(env, id, now) {
  let w = await worker(env, id);
  if (w.startedAt && !w.endedAt) {
    if (w.mealStarted != null && !w.mealFinished && now >= w.mealStarted + BREAK_MS) {
      const result = await q(env, 'UPDATE workers SET mealFinished=1 WHERE id=? AND mealStarted=? AND mealFinished=0 AND endedAt IS NULL', [id, w.mealStarted]);
      if (changed(result)) await log(env, id, 'Обеденные 50 минут закончились; ожидается «Я тут»', w.mealStarted + BREAK_MS);
    }
    if (w.restRunning && w.restLast != null && now >= w.restLast + w.restRemaining) {
      const result = await q(env, 'UPDATE workers SET restRemaining=0,restRunning=0,restLast=NULL WHERE id=? AND restRunning=1 AND restLast=? AND endedAt IS NULL', [id, w.restLast]);
      if (changed(result)) await log(env, id, 'Лимит Daily Rest (50 минут) израсходован', w.restLast + w.restRemaining);
    }
  }
  return worker(env, id);
}
async function durationFor(env, w) {
  if (w.startedAt == null) return shiftHours(env);
  const key = shiftKey(w.id, w.startedAt);
  // Legacy active shifts have no snapshot: pin their current duration on first access.
  const existing = await getSetting(env, key);
  if (existing !== null) return Number(existing) || 8;
  await q(env, 'INSERT OR IGNORE INTO settings(key,value) VALUES(?,?)', [key, String(await shiftHours(env))]);
  return Number(await getSetting(env, key)) || 8;
}
async function stateWorker(env, id, now = Date.now(), includeEvents = true) {
  const w = await settleWorker(env, id, now);
  const rest = Math.max(0, Number(w.restRemaining) - (w.restRunning && w.restLast != null ? Math.max(0, now - w.restLast) : 0));
  const mealElapsed = w.mealStarted != null ? Math.max(0, now - w.mealStarted) : 0;
  let status = 'not_started';
  if (w.startedAt != null) {
    if (w.endedAt != null) status = 'done';
    else if (w.mealStarted != null && !w.mealAck) status = mealElapsed >= BREAK_MS ? 'awaiting_return' : 'meal';
    else if (w.restRunning && rest > 0) status = 'rest';
    else status = 'active';
  }
  const durationHours = await durationFor(env, w);
  const elapsed = w.startedAt == null ? 0 : Math.max(0, (w.endedAt ?? now) - w.startedAt);
  const result = {
    id: w.id, name: w.name, status,
    startedAt: w.startedAt, endedAt: w.endedAt,
    shiftHours: durationHours, shiftElapsedMs: elapsed,
    shiftRemainingMs: Math.max(0, durationHours * 3600000 - elapsed),
    meal: w.mealStarted == null ? null : {
      startedAt: w.mealStarted, finished: !!w.mealFinished || mealElapsed >= BREAK_MS,
      ack: !!w.mealAck, remainingMs: Math.max(0, BREAK_MS - mealElapsed)
    },
    restRunning: !!w.restRunning && rest > 0,
    restRemaining: Number(w.restRemaining),
    restLast: w.restLast,
    restRemainingMs: rest,
    notice: w.notice ? { text: w.notice, at: w.noticeAt, read: !!w.noticeRead } : null
  };
  if (includeEvents) {
    result.events = await all(env, 'SELECT at,text FROM events WHERE workerId=? ORDER BY at DESC,id DESC LIMIT 80', [id]);
  }
  return result;
}
async function adminState(env, now = Date.now()) {
  const workers = await Promise.all([stateWorker(env, 0, now, false), stateWorker(env, 1, now, false)]);
  const events = (await all(env, 'SELECT workerId,at,text FROM events ORDER BY at DESC,id DESC LIMIT 150'))
    .map(e => ({ ...e, name: who(e.workerId) }));
  return { workers, shiftHours: await shiftHours(env), events };
}
async function snapshot(env, s) {
  const now = Date.now();
  return { serverNow: now, state: s.role === 'admin' ? await adminState(env, now) : await stateWorker(env, s.userId, now) };
}
async function jsonBody(req) {
  if (!(req.headers.get('Content-Type') || '').toLowerCase().includes('application/json')) fail(415, 'Требуется JSON', 'bad_content_type');
  const raw = await req.text();
  if (raw.length > 8192) fail(413, 'Слишком большой запрос', 'request_too_large');
  try {
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch { fail(400, 'Некорректный JSON', 'invalid_json'); }
}
function requireMethod(req, method) {
  if (req.method !== method) fail(405, 'Неверный метод запроса', 'method_not_allowed');
}
function requireWorker(s) { if (s.role !== 'worker') fail(403, 'Доступ запрещён', 'forbidden'); }
function requireAdmin(s) { if (s.role !== 'admin') fail(403, 'Доступ запрещён', 'forbidden'); }
async function rotateEpoch(env, id) { await setSetting(env, epochKey(id), crypto.randomUUID()); }
async function requireScreen(req, env, s) {
  requireWorker(s);
  const proof = req.headers.get('X-Screen-Grant') || '';
  if (!/^[a-f0-9-]{36}$/i.test(proof)) fail(428, 'Необходимо разрешить демонстрацию всего монитора', 'screen_required');
  const item = await getSetting(env, screenKey(s.token));
  let grant;
  try { grant = JSON.parse(item); } catch { /* invalid or missing grant */ }
  if (!grant || grant.proof !== proof || grant.userId !== s.userId || grant.expiresAt < Date.now() || grant.epoch !== ((await getSetting(env, epochKey(s.userId))) ?? '0')) {
    fail(428, 'Демонстрацию экрана необходимо включить повторно', 'screen_required');
  }
}
async function handleApi(req, env, url) {
  const path = url.pathname;
  if (req.method === 'POST') {
    const origin = req.headers.get('Origin');
    if (origin && origin !== url.origin) fail(403, 'Недопустимый источник запроса', 'bad_origin');
  }
  if (path === '/api/login') {
    requireMethod(req, 'POST');
    const { login, password } = await jsonBody(req);
    const u = Object.hasOwn(USERS, login) ? USERS[login] : null;
    if (!u || typeof password !== 'string' || password !== u.password) fail(401, 'Неверный логин или пароль', 'bad_credentials');
    const token = crypto.randomUUID();
    await q(env, 'DELETE FROM sessions WHERE expiresAt<?', [Date.now()]);
    await q(env, "DELETE FROM settings WHERE key LIKE 'screen:%' AND CAST(json_extract(value,'$.expiresAt') AS INTEGER)<?", [Date.now()]);
    await q(env, 'INSERT INTO sessions(token,userId,role,expiresAt) VALUES(?,?,?,?)', [token, u.id, u.role, Date.now() + SESSION_MS]);
    await log(env, u.id, `Вход в систему: ${u.name}`);
    const s = { userId: u.id, role: u.role, token };
    return ok({ user: { id: u.id, name: u.name, role: u.role }, ...(await snapshot(env, s)) }, {
      'Set-Cookie': `sc_session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${SESSION_MS / 1000}`
    });
  }
  const s = await session(req, env);
  if (!s) fail(401, 'Сессия истекла. Войдите заново.', 'unauthorized');
  if (path === '/api/session') {
    requireMethod(req, 'GET');
    return ok({ user: { id: s.userId, name: who(s.userId), role: s.role }, ...(await snapshot(env, s)) });
  }
  if (path === '/api/logout') {
    requireMethod(req, 'POST');
    await q(env, 'DELETE FROM sessions WHERE token=?', [s.token]);
    await q(env, 'DELETE FROM settings WHERE key=?', [screenKey(s.token)]);
    await log(env, s.userId, 'Выход из системы');
    return ok({}, { 'Set-Cookie': 'sc_session=; Max-Age=0; HttpOnly; Secure; SameSite=Lax; Path=/' });
  }

  if (path.startsWith('/api/worker/')) {
    requireWorker(s);
    if (path === '/api/worker/state') {
      requireMethod(req, 'GET');
      return ok(await snapshot(env, s));
    }
    requireMethod(req, 'POST');
    if (path === '/api/worker/screen-grant') {
      const { displaySurface } = await jsonBody(req);
      // Important: cannot attest to real capture server-side. Browser verifies its actual track.
      if (displaySurface !== 'monitor') fail(400, 'Выберите «Весь экран / Монитор»', 'monitor_required');
      const epoch = (await getSetting(env, epochKey(s.userId))) ?? '0';
      const proof = crypto.randomUUID();
      await setSetting(env, screenKey(s.token), JSON.stringify({ proof, userId: s.userId, epoch, expiresAt: Date.now() + GRANT_MS }));
      await log(env, s.userId, 'Разрешена демонстрация всего экрана (подтверждено браузером)');
      return ok({ screenGrant: proof });
    }
    if (path === '/api/worker/screen-revoke') {
      const proof = req.headers.get('X-Screen-Grant') || '';
      const item = await getSetting(env, screenKey(s.token));
      try {
        if (item && JSON.parse(item)?.proof === proof) {
          await q(env, 'DELETE FROM settings WHERE key=?', [screenKey(s.token)]);
          await log(env, s.userId, 'Демонстрация экрана остановлена');
        }
      } catch { /* already revoked */ }
      return ok({});
    }
    if (path === '/api/worker/notice-read') {
      const w = await worker(env, s.userId);
      if (w.startedAt != null && w.endedAt == null) await requireScreen(req, env, s);
      await q(env, 'UPDATE workers SET noticeRead=1 WHERE id=?', [s.userId]);
      return ok(await snapshot(env, s));
    }
    await requireScreen(req, env, s);
    const id = s.userId;
    const now = Date.now();
    const w = await settleWorker(env, id, now);
    let result;
    if (path === '/api/worker/start') {
      result = await q(env, `UPDATE workers SET startedAt=?,endedAt=NULL,mealStarted=NULL,mealFinished=0,mealAck=0,
        restRemaining=?,restRunning=0,restLast=NULL WHERE id=? AND (startedAt IS NULL OR endedAt IS NOT NULL)`, [now, BREAK_MS, id]);
      if (!changed(result)) fail(409, 'Смена уже начата', 'already_started');
      await setSetting(env, shiftKey(id, now), await shiftHours(env));
      await log(env, id, 'Смена начата', now);
    } else if (path === '/api/worker/end') {
      result = await q(env, `UPDATE workers SET endedAt=?,restRemaining=CASE WHEN restRunning=1 AND restLast IS NOT NULL
        THEN MAX(0, restRemaining - MAX(0, ?-restLast)) ELSE restRemaining END,restRunning=0,restLast=NULL
        WHERE id=? AND startedAt IS NOT NULL AND endedAt IS NULL`, [now, now, id]);
      if (!changed(result)) fail(409, 'Нет активной смены', 'not_active');
      await rotateEpoch(env, id);
      await log(env, id, 'Смена завершена', now);
    } else if (path === '/api/worker/meal') {
      result = await q(env, `UPDATE workers SET mealStarted=?,mealFinished=0,mealAck=0 WHERE id=?
        AND startedAt IS NOT NULL AND endedAt IS NULL AND mealStarted IS NULL AND restRunning=0`, [now, id]);
      if (!changed(result)) fail(409, 'Сейчас нельзя начать обед', 'meal_unavailable');
      await log(env, id, 'Обед начат — 50 минут', now);
    } else if (path === '/api/worker/back') {
      result = await q(env, `UPDATE workers SET mealFinished=1,mealAck=1 WHERE id=?
        AND startedAt IS NOT NULL AND endedAt IS NULL AND mealStarted IS NOT NULL AND mealAck=0
        AND mealStarted<=?`, [id, now - BREAK_MS]);
      if (!changed(result)) fail(409, 'Обед не завершён или возвращение уже подтверждено', 'not_ready');
      await log(env, id, 'Работник подтвердил возвращение: «Я тут»', now);
    } else if (path === '/api/worker/rest-start') {
      result = await q(env, `UPDATE workers SET restRunning=1,restLast=? WHERE id=? AND startedAt IS NOT NULL
        AND endedAt IS NULL AND restRunning=0 AND restRemaining>0 AND (mealStarted IS NULL OR mealAck=1)`, [now, id]);
      if (!changed(result)) fail(409, 'Daily Rest сейчас недоступен', 'rest_unavailable');
      await log(env, id, w.restLast == null && w.restRemaining === BREAK_MS ? 'Daily Rest начат' : 'Daily Rest продолжен', now);
    } else if (path === '/api/worker/rest-pause') {
      result = await q(env, `UPDATE workers SET restRemaining=MAX(0,restRemaining-MAX(0,?-restLast)),restRunning=0,restLast=NULL
        WHERE id=? AND startedAt IS NOT NULL AND endedAt IS NULL AND restRunning=1 AND restLast IS NOT NULL`, [now, id]);
      if (!changed(result)) fail(409, 'Daily Rest уже остановлен', 'rest_not_running');
      await log(env, id, 'Daily Rest поставлен на паузу', now);
    } else fail(404, 'Неизвестная операция', 'not_found');
    return ok(await snapshot(env, s));
  }

  if (path.startsWith('/api/admin/')) {
    requireAdmin(s);
    if (path === '/api/admin/state') {
      requireMethod(req, 'GET');
      return ok(await snapshot(env, s));
    }
    requireMethod(req, 'POST');
    const body = await jsonBody(req);
    if (path === '/api/admin/settings') {
      const h = body.shiftHours;
      if (typeof h !== 'number' || !Number.isFinite(h) || h < 1 || h > 24 || !Number.isInteger(h * 2)) {
        fail(400, 'Введите от 1 до 24 часов с шагом 0,5', 'bad_setting');
      }
      // Pin every active shift's existing duration before changing the global default.
      await Promise.all([0, 1].map(async id => { const w = await worker(env, id); if (w.startedAt != null) await durationFor(env, w); }));
      await setSetting(env, 'shiftHours', h);
      await log(env, -1, `Admin изменил длительность новых смен: ${h} ч`);
      return ok(await snapshot(env, s));
    }
    if (path === '/api/admin/notify') {
      const target = body.target;
      const ids = target === 'all' ? [0, 1] : (target === 0 || target === '0' ? [0] : target === 1 || target === '1' ? [1] : null);
      const message = typeof body.text === 'string' ? body.text.trim() : '';
      if (!ids) fail(400, 'Выберите работника', 'bad_target');
      if (!message || message.length > 2000) fail(400, 'Введите сообщение до 2000 символов', 'bad_message');
      const now = Date.now();
      for (const id of ids) {
        await q(env, 'UPDATE workers SET notice=?,noticeAt=?,noticeRead=0 WHERE id=?', [message, now, id]);
        await log(env, id, `Admin отправил уведомление: ${message}`, now);
      }
      return ok(await snapshot(env, s));
    }
    if (path === '/api/admin/reset') {
      const id = body.target === 0 || body.target === '0' ? 0 : body.target === 1 || body.target === '1' ? 1 : null;
      if (id == null) fail(400, 'Неверный работник', 'bad_target');
      await q(env, `UPDATE workers SET startedAt=NULL,endedAt=NULL,mealStarted=NULL,mealFinished=0,mealAck=0,
        restRemaining=?,restRunning=0,restLast=NULL WHERE id=?`, [BREAK_MS, id]);
      await rotateEpoch(env, id);
      await log(env, id, `Admin сбросил смену ${who(id)}; история сохранена`);
      return ok(await snapshot(env, s));
    }
    fail(404, 'Неизвестная операция', 'not_found');
  }
  fail(404, 'Страница не найдена', 'not_found');
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (!url.pathname.startsWith('/api/')) {
        const response = await env.ASSETS.fetch(req);
        const headers = new Headers(response.headers);
        for (const [name, value] of Object.entries(securityHeaders)) headers.set(name, value);
        if (url.pathname === '/' || /\.(?:html|css|js)$/.test(url.pathname)) headers.set('Cache-Control', 'no-cache');
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
      }
      await ensureInit(env);
      return await handleApi(req, env, url);
    } catch (e) {
      if (e instanceof HttpError) return J({ ok: false, code: e.code, error: e.message }, e.status);
      console.error('ShiftControl API error:', e);
      return J({ ok: false, code: 'internal_error', error: 'Ошибка сервера. Повторите попытку.' }, 500);
    }
  }
};
