import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { emptyState, publicState, validateRoad, validateDistrict, validateBusiness, validateBuilding, validateBuildingInfo, buildingKey, validateCityObject, validateReview, verifyPassword, id } from './model.mjs';

export function createAdminApi({ root }) {
  const dataDir = path.join(root, 'data'), dataFile = path.join(dataDir, 'edits.json');
  const sessions = new Map(), limits = new Map(), clients = new Set();
  let state, queue = Promise.resolve();
  const loaded = readFile(dataFile, 'utf8').then(raw => { state = { ...emptyState(), ...JSON.parse(raw) }; }).catch(error => { if (error.code !== 'ENOENT') throw error; state = emptyState(); });
  const authenticated = req => { const token = req.headers.cookie?.match(/(?:^|;\s*)atlas_admin=([a-f0-9]{64})(?:;|$)/)?.[1]; const session = sessions.get(token); if (session && session.expires > Date.now()) return { ...session, token }; if (token) sessions.delete(token); return null; };
  const send = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
  const notify = () => { for (const client of clients) { if (client.admin && (!sessions.has(client.token) || sessions.get(client.token).expires < Date.now())) { client.res.end(); clients.delete(client); continue; } client.res.write(`event: state\ndata: ${JSON.stringify(client.admin ? state : publicState(state))}\n\n`); } };
  const persist = mutator => { const task = queue.then(async () => { const next = structuredClone(state); const result = mutator(next); await mkdir(dataDir, { recursive: true }); const temp = `${dataFile}.${randomBytes(6).toString('hex')}.tmp`; await writeFile(temp, JSON.stringify(next), { mode: 0o600 }); await rename(temp, dataFile); state = next; notify(); return result; }); queue = task.catch(() => {}); return task; };
  const body = async req => { let size = 0, chunks = []; if (!String(req.headers['content-type']).startsWith('application/json')) throw Object.assign(new Error('Требуется JSON'), { status: 415 }); for await (const chunk of req) { size += chunk.length; if (size > 200000) throw Object.assign(new Error('Слишком большой запрос'), { status: 413 }); chunks.push(chunk); } try { const result = JSON.parse(Buffer.concat(chunks).toString()); if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error(); return result; } catch { throw new Error('Некорректный JSON'); } };
  const rateLimit = (key, maximum, duration) => { const now = Date.now(); if (limits.size > 10000) for (const [k,v] of limits) if (v.until < now) limits.delete(k); const value = limits.get(key); if (!value || value.until < now) limits.set(key, { count: 1, until: now + duration }); else if (++value.count > maximum) throw Object.assign(new Error('Слишком много попыток. Попробуйте позже.'), { status: 429 }); };
  async function handleAdminApi(req, res) {
    const url = new URL(req.url, 'http://localhost');
    if (!url.pathname.startsWith('/api/')) return false;
    try {
      await loaded;
      const session = authenticated(req), admin = url.searchParams.get('admin') === '1';
      const mutation = !['GET', 'HEAD'].includes(req.method);
      if (mutation) {
        const origin = req.headers.origin;
        if (origin) { let host; try { host = new URL(origin).host; } catch {} if (host !== req.headers.host) throw Object.assign(new Error('Источник запроса запрещён'), { status: 403 }); }
        if (req.headers['sec-fetch-site'] === 'cross-site') throw Object.assign(new Error('Источник запроса запрещён'), { status: 403 });
      }
      if (url.pathname === '/api/session' && req.method === 'GET') { send(res, 200, { session: session ? { username: session.username, admin: true } : null }); return true; }
      if (url.pathname === '/api/login' && req.method === 'POST') {
        rateLimit(`login:${req.socket.remoteAddress}`, 12, 15 * 60 * 1000);
        const input = await body(req);
        let credentials; try { credentials = JSON.parse(await readFile(path.join(root, 'security', 'admin.json'), 'utf8')); } catch { throw Object.assign(new Error('Администратор ещё не настроен на сервере'), { status: 503 }); }
        const valid = await verifyPassword(input.password, credentials);
        if (input.username !== credentials.username || !valid) throw Object.assign(new Error('Неверный логин или пароль'), { status: 401 });
        const token = randomBytes(32).toString('hex');
        const secure = req.socket.encrypted ? '; Secure' : '';
        sessions.set(token, { username: credentials.username, expires: Date.now() + 12 * 3600000 });
        res.setHeader('Set-Cookie', `atlas_admin=${token}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=43200${secure}`);
        send(res, 200, { session: { username: credentials.username, admin: true } }); return true;
      }
      if (url.pathname === '/api/logout' && req.method === 'POST') { if (session) sessions.delete(session.token); res.setHeader('Set-Cookie', 'atlas_admin=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0'); notify(); send(res, 200, { ok: true }); return true; }
      if ((url.pathname === '/api/state' || url.pathname === '/api/events') && req.method === 'GET') {
        if (admin && !session) throw Object.assign(new Error('Войдите в панель администратора'), { status: 401 });
        if (url.pathname === '/api/state') { send(res, 200, admin ? state : publicState(state)); return true; }
        res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        const client = { res, admin, token: session?.token }; clients.add(client);
        res.write(`event: state\ndata: ${JSON.stringify(admin ? state : publicState(state))}\n\n`);
        const timer = setInterval(() => { if (admin && (!sessions.has(client.token) || sessions.get(client.token).expires < Date.now())) res.end(); else res.write(': heartbeat\n\n'); }, 25000); timer.unref();
        res.on('close', () => { clearInterval(timer); clients.delete(client); }); return true;
      }
      if (url.pathname === '/api/reviews' && req.method === 'POST') {
        rateLimit(`review:${req.socket.remoteAddress}`, 5, 10 * 60 * 1000);
        const input = await body(req);
        const result = await persist(next => { const review = validateReview(input, next); next.reviews.push(review); return review; });
        send(res, 201, result); return true;
      }
      if (!session) throw Object.assign(new Error('Войдите в панель администратора'), { status: 401 });
      const input = mutation ? await body(req) : {};
      const collection = { '/api/roads': ['roads', validateRoad], '/api/districts': ['districts', validateDistrict], '/api/businesses': ['businesses', validateBusiness], '/api/buildings': ['buildings', validateBuilding], '/api/building-info': ['buildingInfo', validateBuildingInfo], '/api/city-objects': ['cityObjects', validateCityObject] }[url.pathname];
      if (collection && req.method === 'PUT') {
        const [key, validate] = collection, value = validate(input);
        // Floors replace the whole record, so a cleared field does not linger.
        await persist(next => { if (key === 'roads' || key === 'districts') { const entityId = value.roadId ?? value.districtId; next[key][entityId] = { ...next[key][entityId], ...value }; } else if (key === 'buildingInfo') { next.buildingInfo[value.key] = value; } else { next[key] = next[key].filter(x => x.id !== value.id).concat(value); } });
        send(res, 200, value); return true;
      }
      if (collection?.[0] === 'buildingInfo' && req.method === 'DELETE') { const key = buildingKey(input.id); await persist(next => { delete next.buildingInfo[key]; }); send(res, 200, { ok: true }); return true; }
      if (collection && ['businesses', 'buildings', 'cityObjects'].includes(collection[0]) && req.method === 'DELETE') { const entityId = id(input.id); await persist(next => { next[collection[0]] = next[collection[0]].filter(x => x.id !== entityId); if (collection[0] === 'businesses') next.reviews = next.reviews.filter(x => x.businessId !== entityId); }); send(res, 200, { ok: true }); return true; }
      if (url.pathname === '/api/reviews/moderate' && req.method === 'PUT') { const entityId = id(input.id); if (!['approved', 'rejected', 'pending'].includes(input.status)) throw new Error('Некорректный статус'); await persist(next => { const review = next.reviews.find(x => x.id === entityId); if (!review) throw new Error('Отзыв не найден'); review.status = input.status; review.updatedAt = Date.now(); }); send(res, 200, { ok: true }); return true; }
      send(res, 404, { error: 'Метод API не найден' });
    } catch (error) { if (!res.headersSent) send(res, error.status ?? 400, { error: error.message ?? 'Ошибка сервера' }); else res.end(); }
    return true;
  }
  handleAdminApi.close = () => { for (const client of clients) client.res.end(); clients.clear(); };
  return handleAdminApi;
}
