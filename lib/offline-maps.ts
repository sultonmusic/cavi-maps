// Saving pieces of the map for use without internet, for the Profile page. Browser only.
// The service worker (public/sw.js) already keeps every file the map fetches; this asks it to fetch
// a whole town (or the routing graph) ahead of time over its existing CACHE_URLS message, in small
// chunks so the page can show progress, and it can delete those map pieces again. The app itself,
// the lists and the place data are never deleted, so the map keeps opening offline.
import { siteUrl, SITE_ROOT } from './site-url';
import { loadTileIndex } from './atlas-gl';
import { areaFiles, isSavedMapPath, sumBytes } from './offline-areas.mjs';
import type { OfflineArea, TileLists } from './offline-areas.mjs';

export type OfflinePlan = { urls: string[]; bytes: number | null };
export type OfflineStatus = { supported: boolean; usage: number | null; quota: number | null; mapFiles: number; graphSaved: boolean };
/** A saved area as the Profile lists it; lat, lon and r let «Обновить» save the same box again. */
export type SavedArea = { id: string; name: string; files: number; bytes: number | null; at: number; lat?: number; lon?: number; r?: number };
export type SaveResult = { failed: string[]; aborted: boolean };

const AREAS_KEY = 'atlas-offline-areas';
const CACHE_PREFIX = 'atlas-';
const CHUNK = 6;
const REPLY_TIMEOUT = 120_000;
const WORKER_TIMEOUT = 10_000;

/** Saving needs a service worker, which browsers allow only on https:// (or localhost). */
export function offlineSupported(): boolean {
  try { return window.isSecureContext && 'serviceWorker' in navigator && 'caches' in window } catch { return false }
}

/** '/cavi-maps/atlas-data/x.json' or a full URL → '/atlas-data/x.json'. */
function sitePath(url: string): string {
  let path = url;
  try { path = new URL(url, location.href).pathname } catch { /* keep it */ }
  return path.startsWith(SITE_ROOT) ? '/' + path.slice(SITE_ROOT.length) : path;
}

async function json<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const response = await fetch(siteUrl(path), init);
    return response.ok ? await response.json() as T : null;
  } catch { return null }
}

let lists: Promise<TileLists> | undefined;
/** What exists in each map folder; a folder whose list cannot be read counts as empty. */
function tileLists(): Promise<TileLists> {
  const groups = (folder: string) => json<{ groups?: string[] }>(`/${folder}/index.json`).then(meta => new Set(meta?.groups ?? []));
  return lists ??= Promise.all([loadTileIndex(), groups('atlas-houses'), groups('atlas-roads'), groups('atlas-things'), groups('atlas-walks')])
    .then(([tiles, houses, roads, things, walks]) => ({ tiles, houses, roads, things, walks }))
    .catch(cause => { lists = undefined; throw cause });
}

let sizes: Promise<Record<string, number> | null> | undefined;
/** File sizes written by scripts/build-offline-manifest.mjs; null on a dev server, where it is missing. */
function fileSizes() {
  return sizes ??= json<{ files?: Record<string, number> }>('/offline-sizes.json', { cache: 'no-cache' })
    .then(meta => meta?.files ?? null)
    .then(files => { if (!files) sizes = undefined; return files });
}

let graph: Promise<string[] | null> | undefined;
/** The routing graph's files: its list and every node and edge piece. */
function graphFiles() {
  return graph ??= json<{ nodes_files?: string[]; edges_files?: string[] }>('/road-graph.json').then(meta => {
    if (!meta) { graph = undefined; return null }
    return ['/road-graph.json', ...(meta.nodes_files ?? []), ...(meta.edges_files ?? [])].map(sitePath);
  });
}

/** The files of an area and how much they weigh. */
export async function planArea(area: OfflineArea): Promise<OfflinePlan> {
  const [found, known] = await Promise.all([tileLists(), fileSizes()]);
  const urls = areaFiles(area, found);
  return { urls, bytes: sumBytes(urls, known) };
}

/** The files of the routing graph for the whole country and how much they weigh. */
export async function planGraph(): Promise<OfflinePlan> {
  const [urls, known] = await Promise.all([graphFiles(), fileSizes()]);
  if (!urls) throw Error('Не удалось загрузить дорожную сеть');
  return { urls, bytes: sumBytes(urls, known) };
}

async function cachedPaths(): Promise<{ caches: Cache[]; keys: Map<Cache, readonly Request[]>; paths: Set<string> }> {
  const names = (await caches.keys()).filter(name => name.startsWith(CACHE_PREFIX));
  const opened = await Promise.all(names.map(name => caches.open(name)));
  const keys = new Map<Cache, readonly Request[]>(), paths = new Set<string>();
  for (const cache of opened) {
    const requests = await cache.keys();
    keys.set(cache, requests);
    for (const request of requests) paths.add(sitePath(request.url));
  }
  return { caches: opened, keys, paths };
}

/** How much the site keeps on this device and how many map pieces are saved. */
export async function offlineStatus(): Promise<OfflineStatus> {
  const supported = offlineSupported();
  let usage: number | null = null, quota: number | null = null;
  try {
    const estimate = await navigator.storage?.estimate?.();
    usage = estimate?.usage ?? null;
    quota = estimate?.quota ?? null;
  } catch { /* not reported */ }
  if (!supported) return { supported, usage, quota, mapFiles: 0, graphSaved: false };
  let mapFiles = 0, graphSaved = false;
  try {
    const { paths } = await cachedPaths();
    for (const path of paths) if (isSavedMapPath(path)) mapFiles++;
    const pieces = (await graphFiles())?.filter(isSavedMapPath);
    graphSaved = !!pieces?.length && pieces.every(path => paths.has(path));
  } catch { /* caches unavailable */ }
  return { supported, usage, quota, mapFiles, graphSaved };
}

async function worker(): Promise<ServiceWorker | null> {
  const container = navigator.serviceWorker;
  if (container.controller) return container.controller;
  const ready = container.ready.then(registration => registration.active);
  const late = new Promise<null>(resolve => setTimeout(() => resolve(null), WORKER_TIMEOUT));
  return Promise.race([ready, late]);
}

function post(target: ServiceWorker, urls: string[]): Promise<string[]> {
  return new Promise(resolve => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => { channel.port1.close(); resolve(urls) }, REPLY_TIMEOUT);
    channel.port1.onmessage = event => {
      clearTimeout(timer);
      channel.port1.close();
      const failed = (event.data as { failed?: unknown })?.failed;
      resolve(Array.isArray(failed) ? failed.map(value => sitePath(String(value))) : []);
    };
    try { target.postMessage({ type: 'CACHE_URLS', urls }, [channel.port2]) } catch { clearTimeout(timer); resolve(urls) }
  });
}

/** Asks the service worker to keep these site paths, a few at a time, reporting progress. Files it
    already has are skipped by the worker, so saving an area again only fetches what is missing.
    Stopping with `signal` finishes the chunk in flight and returns. */
export async function saveUrls(urls: readonly string[], onProgress?: (done: number, total: number) => void, signal?: AbortSignal): Promise<SaveResult> {
  const total = urls.length, failed: string[] = [];
  if (!offlineSupported()) return { failed: [...urls], aborted: false };
  // Ask the browser not to clear the saved map when space runs low (Chrome decides silently).
  try { await navigator.storage?.persist?.() } catch { /* not supported */ }
  const target = await worker();
  if (!target) return { failed: [...urls], aborted: false };
  onProgress?.(0, total);
  let done = 0;
  for (let i = 0; i < total; i += CHUNK) {
    if (signal?.aborted) return { failed, aborted: true };
    const chunk = urls.slice(i, i + CHUNK);
    failed.push(...await post(target, chunk));
    done += chunk.length;
    onProgress?.(done, total);
  }
  return { failed, aborted: false };
}

/** Deletes the saved map pieces and routing graph (never the app, the lists or the places) and
    returns how many files went. The map fetches them again when it is online. */
export async function clearSavedMaps(): Promise<number> {
  if (!offlineSupported()) return 0;
  const { keys } = await cachedPaths();
  let removed = 0;
  for (const [cache, requests] of keys) {
    for (const request of requests) {
      if (isSavedMapPath(sitePath(request.url)) && await cache.delete(request)) removed++;
    }
  }
  return removed;
}

// ---- the list of saved areas (atlas-offline-areas) --------------------------------------------

function tell() {
  try { window.dispatchEvent(new Event('atlas-prefs')) } catch { /* no window */ }
}
/** Areas saved on this device, newest first. */
export function savedAreas(): SavedArea[] {
  try {
    const value = JSON.parse(localStorage.getItem(AREAS_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((a): a is SavedArea => !!a && typeof a.id === 'string' && typeof a.name === 'string'
      && typeof a.files === 'number' && typeof a.at === 'number' && (a.bytes === null || typeof a.bytes === 'number'));
  } catch { return [] }
}
export function rememberArea(area: SavedArea) {
  try {
    const next = [area, ...savedAreas().filter(a => a.id !== area.id)].slice(0, 20);
    localStorage.setItem(AREAS_KEY, JSON.stringify(next));
  } catch { /* storage refused */ }
  tell();
}
export function forgetAreas() {
  try { localStorage.removeItem(AREAS_KEY) } catch { /* storage refused */ }
  tell();
}

/** The build's version and the date of the map data, from offline-manifest.json; nulls on a dev server. */
export async function buildInfo(): Promise<{ version: string | null; dataDate: string | null }> {
  const meta = await json<{ version?: unknown; dataDate?: unknown }>('/offline-manifest.json', { cache: 'no-cache' });
  return {
    version: typeof meta?.version === 'string' ? meta.version : null,
    dataDate: typeof meta?.dataDate === 'string' ? meta.dataDate : null,
  };
}
