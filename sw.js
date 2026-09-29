/* Cavi Maps offline cache: app shell, map data and saved routes. No analytics, external requests, or background GPS. */
const CACHE_NAME = 'atlas-20260929-cavi4';
const inFlight = new Map();
// The site root: '/' on Firebase, '/cavi-maps/' on GitHub Pages. Paths below are written from that root.
const ROOT = new URL('./', self.location.href).pathname;
const sitePath = pathname => pathname.startsWith(ROOT) ? '/' + pathname.slice(ROOT.length) : pathname;
const localUrl = value => {
  let url = new URL(value, self.location.origin);
  if (!url.pathname.startsWith(ROOT)) url = new URL(url.pathname.slice(1) + url.search, new URL(ROOT, self.location.origin));
  if (url.origin !== self.location.origin || !['http:', 'https:'].includes(url.protocol)) throw Error('Only local files');
  return url.href;
};
const isMapData = pathname => pathname.startsWith('/atlas-data/') || pathname.startsWith('/atlas-houses/') || pathname.startsWith('/atlas-roads/') || pathname.startsWith('/atlas-things/') || pathname.startsWith('/atlas-walks/') || /^\/graph-(?:nodes|edges)-\d+\.json$/.test(pathname) || ['/road-graph.json', '/places.json', '/streets.json', '/districts.json', '/road-routes.json', '/road-routes-extra.json'].includes(pathname);

async function remember(url, { force = false } = {}) {
  url = localUrl(url);
  const cache = await caches.open(CACHE_NAME);
  if (!force && await cache.match(url)) return;
  if (inFlight.has(url)) return inFlight.get(url);
  const pending = (async () => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 15000);
    try {
      const response = await fetch(url, { cache: 'no-cache', signal: abort.signal });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      await cache.put(url, response);
    } finally { clearTimeout(timeout); }
  })();
  inFlight.set(url, pending);
  try { await pending; } finally { inFlight.delete(url); }
}

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const manifestResponse = await fetch(ROOT + 'offline-manifest.json', { cache: 'no-cache' });
    if (!manifestResponse.ok) throw Error('Run scripts/build-offline-manifest.mjs after building Cavi Maps');
    const manifest = await manifestResponse.json();
    for (const url of manifest.urls) await remember(url, { force: true });
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name.startsWith('atlas-') && name !== CACHE_NAME) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url), path = sitePath(url.pathname);
  if (request.method !== 'GET' || url.origin !== self.location.origin || path === '/sw.js' || path.startsWith('/api/') || path === '/runtime-config.json' || path.startsWith('/__/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);
    if (isMapData(path) && cached) return cached;
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 5000);
    try {
      const response = await fetch(request, { signal: abort.signal });
      if (response.ok) {
        event.waitUntil(cache.put(request, response.clone()).catch(() => {}));
        return response;
      }
      if (cached) return cached;
      return response;
    } catch (error) {
      if (cached) return cached;
      if (request.mode === 'navigate') {
        const shell = await cache.match(new URL(ROOT + 'index.html', self.location.origin));
        if (shell) return shell;
      }
      return new Response('Нет связи с Cavi Maps. Этот файл ещё не сохранён на устройстве.', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    } finally { clearTimeout(timeout); }
  })());
});

self.addEventListener('message', event => {
  if (event.data?.type !== 'CACHE_URLS') return;
  event.waitUntil((async () => {
    const failed = [];
    if (!Array.isArray(event.data.urls) || event.data.urls.length > 2000) {
      event.ports[0]?.postMessage({ ok: false, failed: ['Invalid URL list'] });
      return;
    }
    for (const value of [...new Set(event.data.urls)]) {
      try { if (typeof value !== 'string') throw Error('Invalid URL'); await remember(value); }
      catch { failed.push(String(value)); }
    }
    event.ports[0]?.postMessage({ ok: failed.length === 0, failed });
  })());
});
