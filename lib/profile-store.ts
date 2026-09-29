// The reader's profile, kept only on this device (there are no accounts): home and work, recently
// opened places and routes, start-up preferences, the navigator's voice and default travel mode.
// Everything lives in localStorage under atlas-* keys. Every read and write is wrapped, so a private
// window or a full storage simply behaves like an empty profile. Each write fires the window event
// 'atlas-prefs', and onProfileChange() also hears other tabs through the 'storage' event.
// No browser globals are touched at load time, so the Node check (scripts/check-profile-store.mjs)
// imports it with a stubbed window and localStorage.
import { isMode } from './travel.mjs';
import type { Mode } from './travel.mjs';
import { cityByName } from './cities.mjs';
import type { SearchPlace } from './place-search';

export type HomeSlot = 'home' | 'work';
/** A place as the profile keeps it: id, position and a short list of tags. */
export type StoredPlace = SearchPlace;
export type RecentPlace = StoredPlace & { at: number };
export type RecentRoute = { to: StoredPlace; fromName?: string; mode: Mode; meters: number; seconds: number; at: number };
export type Prefs = {
  /** A town from lib/cities.mjs, or null. */
  homeCity: string | null;
  /** Open the map in homeCity even when the reader left it somewhere else. */
  openInHomeCity: boolean;
  /** Tilt the map to 3D right after it opens. */
  start3d: boolean;
};

export const PROFILE_EVENT = 'atlas-prefs';
export const PROFILE_KEYS = {
  recentPlaces: 'atlas-recent-places',
  recentRoutes: 'atlas-recent-routes',
  home: 'atlas-home',
  work: 'atlas-work',
  prefs: 'atlas-prefs',
  voice: 'atlas-voice',
  mode: 'atlas-mode',
  buildingDetail: 'atlas-building-detail',
} as const;
export const DEFAULT_PREFS: Readonly<Prefs> = Object.freeze({ homeCity: null, openInHomeCity: false, start3d: false });
const MAX_PLACES = 12, MAX_ROUTES = 8, MAX_TEXT = 200;

/** Only these tags are kept: enough to show, search and reopen the place, nothing personal. The kind
    tags (leisure, healthcare, historic, office, craft, religion) keep «Парк» or «Аптека» on the row. */
const KEPT_TAGS = ['name', 'name:ru', 'name:en', 'atlas:type', 'atlas:place', 'atlas:category', 'atlas:business-id', 'atlas:road-id',
  'atlas:route-id', 'atlas:route-name', 'atlas:district-id', 'atlas:street', 'atlas:house', 'atlas:naming', 'atlas:region',
  'amenity', 'shop', 'tourism', 'leisure', 'healthcare', 'historic', 'office', 'craft', 'religion', 'highway', 'ref',
  'addr:city', 'addr:street', 'addr:housenumber'];

function store(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}
function readRaw(key: string): string | null {
  try { return store()?.getItem(key) ?? null } catch { return null }
}
function readJson(key: string): unknown {
  const raw = readRaw(key);
  if (raw === null) return null;
  try { return JSON.parse(raw) } catch { return null }
}
function notify() {
  try { if (typeof window !== 'undefined') window.dispatchEvent(new Event(PROFILE_EVENT)) } catch { /* no window */ }
}
/** Writes (or with null removes) a key and tells the listeners; false when storage refused. */
function writeRaw(key: string, value: string | null): boolean {
  let ok = false;
  try {
    const s = store();
    if (s) { if (value === null) s.removeItem(key); else s.setItem(key, value); ok = true }
  } catch { ok = false }
  notify();
  return ok;
}

/** The place trimmed to what the profile keeps, or null when it is not a usable place. */
export function storedPlace(value: unknown): StoredPlace | null {
  if (!value || typeof value !== 'object') return null;
  const p = value as Partial<SearchPlace>;
  if (typeof p.id !== 'string' || !p.id || p.id.length > MAX_TEXT) return null;
  const lat = Number(p.lat), lon = Number(p.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const tags: Record<string, string> = {};
  const source = p.tags && typeof p.tags === 'object' ? p.tags : {};
  for (const key of KEPT_TAGS) {
    const v = (source as Record<string, unknown>)[key];
    if (typeof v === 'string' && v) tags[key] = v.slice(0, MAX_TEXT);
  }
  return { id: p.id, lat, lon, tags };
}

// ---- preferences ----------------------------------------------------------------------------

/** A town from lib/cities.mjs; the whole country is not a home town. */
function isTown(name: unknown): name is string {
  if (typeof name !== 'string') return false;
  const city = cityByName(name);
  return !!city && city.r !== null;
}

export function readPrefs(): Prefs {
  const value = readJson(PROFILE_KEYS.prefs) as Partial<Prefs> | null;
  if (!value || typeof value !== 'object') return { ...DEFAULT_PREFS };
  const homeCity = isTown(value.homeCity) ? value.homeCity : null;
  return { homeCity, openInHomeCity: value.openInHomeCity === true, start3d: value.start3d === true };
}
export function writePrefs(patch: Partial<Prefs>): Prefs {
  const next = { ...readPrefs(), ...patch };
  if (!isTown(next.homeCity)) next.homeCity = null;
  writeRaw(PROFILE_KEYS.prefs, JSON.stringify(next));
  return next;
}

/** Spoken turn prompts; on unless the reader turned them off. */
export function readVoice(): boolean {
  return readRaw(PROFILE_KEYS.voice) !== 'off';
}
export function writeVoice(on: boolean) {
  writeRaw(PROFILE_KEYS.voice, on ? 'on' : 'off');
}

/** Close-up building detail (windows, roofs, street trees); on unless the reader turned it off. */
export function readBuildingDetail(): boolean {
  return readRaw(PROFILE_KEYS.buildingDetail) !== 'off';
}
export function writeBuildingDetail(on: boolean) {
  writeRaw(PROFILE_KEYS.buildingDetail, on ? 'on' : 'off');
}

/** The travel mode new routes start with; a car unless the reader chose another. */
export function readMode(): Mode {
  const value = readRaw(PROFILE_KEYS.mode);
  return isMode(value) ? value : 'car';
}
export function writeMode(mode: Mode) {
  if (isMode(mode)) writeRaw(PROFILE_KEYS.mode, mode);
}

// ---- history --------------------------------------------------------------------------------

function list(key: string): unknown[] {
  const value = readJson(key);
  return Array.isArray(value) ? value : [];
}
const when = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value : 0;

/** Places the reader opened, newest first. */
export function recentPlaces(): RecentPlace[] {
  const out: RecentPlace[] = [], seen = new Set<string>();
  for (const item of list(PROFILE_KEYS.recentPlaces)) {
    const place = storedPlace(item);
    if (!place || seen.has(place.id)) continue;
    seen.add(place.id);
    out.push({ ...place, at: when((item as { at?: unknown }).at) });
    if (out.length >= MAX_PLACES) break;
  }
  return out;
}
/** Puts the place first in the history. A bare tap on the map ('point:…') is not a place and is skipped. */
export function rememberPlace(place: SearchPlace | null | undefined) {
  const stored = storedPlace(place);
  if (!stored || stored.id.startsWith('point:')) return;
  const next = [{ ...stored, at: Date.now() }, ...recentPlaces().filter(p => p.id !== stored.id)].slice(0, MAX_PLACES);
  writeRaw(PROFILE_KEYS.recentPlaces, JSON.stringify(next));
}

function storedRoute(value: unknown): RecentRoute | null {
  if (!value || typeof value !== 'object') return null;
  const r = value as Partial<RecentRoute>;
  const to = storedPlace(r.to);
  if (!to || !isMode(r.mode)) return null;
  const meters = Number(r.meters), seconds = Number(r.seconds);
  if (!Number.isFinite(meters) || meters < 0 || !Number.isFinite(seconds) || seconds < 0) return null;
  const route: RecentRoute = { to, mode: r.mode, meters, seconds, at: when(r.at) };
  if (typeof r.fromName === 'string' && r.fromName.trim()) route.fromName = r.fromName.trim().slice(0, MAX_TEXT);
  return route;
}
/** Routes the reader built, newest first; one per destination and travel mode. */
export function recentRoutes(): RecentRoute[] {
  const out: RecentRoute[] = [], seen = new Set<string>();
  for (const item of list(PROFILE_KEYS.recentRoutes)) {
    const route = storedRoute(item);
    if (!route) continue;
    const key = route.to.id + '|' + route.mode;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
    if (out.length >= MAX_ROUTES) break;
  }
  return out;
}
export function rememberRoute(route: RecentRoute) {
  const stored = storedRoute({ ...route, at: route?.at || Date.now() });
  if (!stored) return;
  const key = stored.to.id + '|' + stored.mode;
  const next = [stored, ...recentRoutes().filter(r => r.to.id + '|' + r.mode !== key)].slice(0, MAX_ROUTES);
  writeRaw(PROFILE_KEYS.recentRoutes, JSON.stringify(next));
}

/** Forgets the recent places and routes (not home, work, favourites or settings). */
export function clearHistory() {
  try {
    const s = store();
    s?.removeItem(PROFILE_KEYS.recentPlaces);
    s?.removeItem(PROFILE_KEYS.recentRoutes);
  } catch { /* nothing stored */ }
  notify();
}

// ---- home and work --------------------------------------------------------------------------

export function homePlace(slot: HomeSlot): StoredPlace | null {
  return storedPlace(readJson(PROFILE_KEYS[slot]));
}
/** Sets the address for «Дом» or «Работа»; null forgets it. */
export function setHomePlace(slot: HomeSlot, place: SearchPlace | null) {
  const stored = place ? storedPlace(place) : null;
  if (place && !stored) return;
  writeRaw(PROFILE_KEYS[slot], stored ? JSON.stringify(stored) : null);
}

// ---- listening ------------------------------------------------------------------------------

/** Calls `callback` after every profile write in this tab and after atlas-* changes in other tabs.
    Returns the function that stops listening. */
export function onProfileChange(callback: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const own = () => callback();
  const other = (event: Event) => {
    const key = (event as StorageEvent).key;
    if (key === null || key === undefined || key.startsWith('atlas-')) callback();
  };
  window.addEventListener(PROFILE_EVENT, own);
  window.addEventListener('storage', other);
  return () => {
    window.removeEventListener(PROFILE_EVENT, own);
    window.removeEventListener('storage', other);
  };
}
