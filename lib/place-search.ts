// Search over every place the map knows: businesses and OSM places, streets and roads by name or
// number, micro-districts, settlements and bare coordinates. Pure and DOM-free, so the page and the
// Node check (scripts/check-place-search.mjs) share it.
//
// Matching folds case, ё and the Tajik letters (ӣ ӯ ҳ қ ғ ҷ), compares Latin and Cyrillic spellings
// through a rough Latin skeleton ('rudaki' finds «Рудаки»), reads road numbers however they are
// typed ('р303', 'R 303', 'rb4' for «РБ04»), and every word of the query has to match.
// The searchable text of each place is built lazily on the first query and cached by id and name.
import { chipOf, kindKey, kindLabel, kindWords } from './place-kinds.mjs';
import type { ChipId } from './place-kinds.mjs';
import { CITIES, cityAt, inCity } from './cities.mjs';
import type { City } from './cities.mjs';

export type SearchPlace = { id: string; lat: number; lon: number; tags: Record<string, string> };
export type SearchEntry = {
  place: SearchPlace;
  /** tags['atlas:type'], or 'poi' for an OSM place. */
  type: string;
  chip: ChipId;
  /** The folded display name, and the same after a space for word-start tests. */
  nameKey: string;
  words: string;
  /** Road numbers as refKey()s. */
  refs: string[];
  /** ' ' + folded kind words of a place or business («аптека лекарства здоровье»), '' for the rest. */
  kind: string;
  /** Other names that count as much as the name itself, folded and as Latin skeletons: a settlement's
      ('khujand', 'hujand', 'ленинабад') and a whole road's own name without its number ('рохи шимоли'
      for «R-303 · Роҳи шимолӣ»); null for everything else. */
  alts: string[] | null;
  /** Folded searchable text and its Latin skeleton, filled on the first query. */
  text?: string;
  latin?: string;
};
export type SearchOptions = {
  query: string;
  chip: ChipId;
  /** Only these ids (the favourites), or null for everything. */
  savedOnly: readonly string[] | null;
  /** Browse inside this town's box; null for the whole country. */
  city: City | null;
  centre: { lat: number; lon: number };
};

// fold() and loose() run over every place's text on the first query, so they are plain loops over
// character codes rather than chains of regular expressions (about five times faster on a phone).
const FOLD_TO: Record<string, string> = {
  'ӣ': 'и', 'ӯ': 'у', 'ҳ': 'х', 'қ': 'к', 'ғ': 'г', 'ҷ': 'ч', 'ё': 'е', 'ў': 'у', 'ї': 'и', 'і': 'и', 'є': 'е',
  'ʻ': '', 'ʼ': '', "'": '', '`': '', '’': '', '‘': '',
};

/** Lower case, ё → е, Tajik letters to their Russian look-alikes, Latin letters without accents,
    apostrophes dropped and everything else to single spaces. */
export function fold(value: string): string {
  if (!value) return '';
  const v = value.toLowerCase();
  let out = '', gap = false;
  for (let i = 0; i < v.length; i++) {
    const code = v.charCodeAt(i);
    let ch: string;
    if ((code >= 97 && code <= 122) || (code >= 48 && code <= 57) || (code >= 0x430 && code <= 0x44f)) ch = v[i];
    else {
      const to = FOLD_TO[v[i]];
      if (to === '') continue;
      if (to !== undefined) ch = to;
      else if (code >= 0xc0 && code <= 0x24f) {
        // ö, ş, é: the plain letter; letters that do not decompose (ß, ø) split words.
        const base = v[i].normalize('NFD').charCodeAt(0);
        if (base >= 97 && base <= 122) ch = String.fromCharCode(base);
        else { gap = out.length > 0; continue }
      } else if (code >= 0x300 && code <= 0x36f) continue;
      else { gap = out.length > 0; continue }
    }
    if (gap) { out += ' '; gap = false }
    out += ch;
  }
  return out;
}

const LATIN = ['a', 'b', 'v', 'g', 'd', 'e', 'zh', 'z', 'i', 'y', 'k', 'l', 'm', 'n', 'o', 'p', 'r', 's', 't', 'u', 'f', 'kh', 'ts', 'ch', 'sh', 'sch', '', 'y', '', 'e', 'yu', 'ya'];
const LATIN_ONE: Record<string, string> = { x: 'h', w: 'v', q: 'k', y: 'i' };
/** A rough Latin skeleton of a folded string, so 'rudaki', 'Rudaki' and «Рудаки» meet:
    Cyrillic by sound, then dzh/dj/zh → j, kh/x → h, w → v, q → k, y → i and no doubled letters. */
export function loose(folded: string): string {
  if (!folded) return '';
  let latin = '';
  for (let i = 0; i < folded.length; i++) {
    const code = folded.charCodeAt(i);
    latin += code >= 0x430 && code <= 0x44f ? LATIN[code - 0x430] : folded[i];
  }
  let out = '', last = '';
  for (let i = 0; i < latin.length; i++) {
    let ch = latin[i];
    const next = latin[i + 1];
    if (ch === 'd' && next === 'z' && latin[i + 2] === 'h') { ch = 'j'; i += 2 }
    else if (ch === 'd' && next === 'j') { ch = 'j'; i++ }
    else if (ch === 'z' && next === 'h') { ch = 'j'; i++ }
    else if (ch === 'k' && next === 'h') { ch = 'h'; i++ }
    else ch = LATIN_ONE[ch] ?? ch;
    if (ch === last && ch >= 'a' && ch <= 'z') continue;
    out += ch;
    last = ch;
  }
  return out;
}

const REF_LETTERS: Record<string, string> = {
  р: 'R', б: 'B', ҷ: 'J', ч: 'J', м: 'M', а: 'A', е: 'E', э: 'E', к: 'K', қ: 'K', т: 'T', с: 'S', д: 'D', н: 'N',
  х: 'H', ҳ: 'H', г: 'G', ғ: 'G', и: 'I', ӣ: 'I', у: 'U', ӯ: 'U', в: 'V', з: 'Z', л: 'L', о: 'O', п: 'P',
  ф: 'F', ц: 'C', ш: 'SH', ж: 'J', й: 'Y',
};
/** A road number reduced to Latin capitals and digits, digit runs without leading zeros:
    'Р-303' → 'R303', 'РБ04' → 'RB4', 'rb 4' → 'RB4', 'РҶ068' → 'RJ68'. Tajik «Ҷ» and a Russian «Ч»
    typed for it both read J. */
export function refKey(value: string): string {
  if (!value) return '';
  return value.toLowerCase().replace(/[а-яёӣӯҳқғҷ]/g, c => REF_LETTERS[c] ?? '').toUpperCase()
    .replace(/[^0-9A-Z]/g, '').replace(/\d+/g, digits => digits.replace(/^0+/, ''));
}

/** Whether the query looks like a road number: 'R-303', 'р303', 'M41', 'rb 04'. */
export function isRefQuery(query: string): boolean {
  return /^[a-zа-яӣӯҳқғҷ]{1,3}\s*-?\s*\d{1,4}[a-zа-я]?$/i.test(query.trim());
}

/** '40.2824, 69.6227' (or the other way round) → {lat, lon}; null when it is not coordinates. */
export function coordinateQuery(query: string): { lat: number; lon: number } | null {
  const m = /^(-?\d{1,3}\.\d+)\s*[,; ]\s*(-?\d{1,3}\.\d+)$/.exec(query.trim());
  if (!m) return null;
  let lat = Number(m[1]), lon = Number(m[2]);
  // Tajikistan lies at 36.7–41.1 N and 67.3–75.2 E, so a pair written longitude first is swapped.
  if (lat >= 66 && lat <= 76 && lon >= 35 && lon <= 42) [lat, lon] = [lon, lat];
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { lat, lon };
}

/** Russian plural: plural(n, 'место', 'места', 'мест'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const whole = Math.abs(Math.trunc(n)), tens = whole % 100, units = whole % 10;
  return tens > 10 && tens < 20 ? many : units === 1 ? one : units > 1 && units < 5 ? few : many;
}

/** '350 м', '1,2 км', '23 км'. */
export function distanceLabel(meters: number): string {
  const m = Math.max(0, meters);
  const rounded = Math.round(m / 10) * 10;
  if (rounded < 1000) return `${rounded} м`;
  const km = Math.round(m / 100) / 10;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} км`;
  return `${Math.round(m / 1000)} км`;
}

const RAD = Math.PI / 180;
/** Great-circle metres between two points. */
export function metersBetween(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = (b.lat - a.lat) * RAD, dLon = (b.lon - a.lon) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742000 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Only these tags are searched: folding every tag value is several times slower and finds 'yes'. */
const TEXT_TAGS = ['name', 'name:ru', 'name:tg', 'name:en', 'alt_name', 'old_name', 'official_name', 'short_name', 'int_name',
  'brand', 'operator', 'ref', 'addr:street', 'atlas:street', 'addr:city', 'addr:housenumber', 'atlas:search'];

function displayName(tags: Record<string, string>) {
  return tags['name:ru'] || tags.name || tags['name:en'] || '';
}

const kindTexts = new Map<string, string>();
/** The folded words of a place's kind, shared by every place of that kind. */
function kindText(tags: Record<string, string>) {
  const key = kindKey(tags) + (tags.religion === 'christian' ? '|c' : '');
  let found = kindTexts.get(key);
  if (found === undefined) {
    found = ' ' + fold([kindLabel(tags), ...kindWords(tags)].join(' '));
    kindTexts.set(key, found);
  }
  return found;
}

/** Entries already made for a place object; an unchanged place keeps its entry and text across reindexing. */
const entryCache = new WeakMap<SearchPlace, SearchEntry>();

/** Cheap first pass: what each place is and its folded name; the rest waits for a query. */
export function indexPlaces(places: readonly SearchPlace[]): SearchEntry[] {
  const out: SearchEntry[] = new Array(places.length);
  for (let i = 0; i < places.length; i++) {
    const place = places[i], cached = entryCache.get(place);
    if (cached) { out[i] = cached; continue }
    const tags = place.tags || {};
    const type = tags['atlas:type'] || 'poi';
    const refs = tags.ref ? tags.ref.split(/[;,]/).map(refKey).filter(Boolean) : [];
    const nameKey = fold(displayName(tags));
    out[i] = { place, type, chip: chipOf(tags), nameKey, words: ' ' + nameKey, refs, kind: type === 'poi' || type === 'business' ? kindText(tags) : '',
      alts: type === 'label' ? altNames(nameKey, tags, ['alt_name', 'name', 'name:tg', 'name:en', 'old_name'], ';') : type === 'route' ? altNames(nameKey, tags, ['name'], ' · ') : null };
    entryCache.set(place, out[i]);
  }
  return out;
}

function altNames(nameKey: string, tags: Record<string, string>, keys: readonly string[], separator: string) {
  const out = new Set<string>([loose(nameKey)]);
  for (const tag of keys) {
    for (const part of (tags[tag] || '').split(separator)) {
      const folded = fold(part);
      if (folded) { out.add(folded); out.add(loose(folded)) }
    }
  }
  out.delete(nameKey);
  out.delete('');
  return [...out];
}

// The folded text of every place, keyed by the raw text it is folded from: places rebuilt by a live
// edit fold again only when a searchable tag really changed, and stretches of one street share it.
const texts = new Map<string, { text: string; latin: string }>();
function fillText(entry: SearchEntry) {
  const tags = entry.place.tags;
  let raw = entry.type === 'street' ? 'улица' : '';
  for (let i = 0; i < TEXT_TAGS.length; i++) { const value = tags[TEXT_TAGS[i]]; if (value) raw += ' ' + value }
  const key = raw + '\u0001' + entry.kind;
  let found = texts.get(key);
  if (!found) {
    const text = fold(raw) + entry.kind;
    found = { text: ' ' + text, latin: ' ' + loose(text) };
    texts.set(key, found);
  }
  entry.text = found.text;
  entry.latin = found.latin;
}

/** Streets, micro-districts, settlement names and whole roads are found by searching, not listed while browsing. */
const NOT_BROWSED = new Set(['street', 'district', 'label', 'route']);
const MAX_RESULTS = 400;

/** Towns and villages from the map's own labels, as places the search can find.
    `known` holds ids already among the places (a label the reader saved earlier). */
export function settlementPlaces(labels: readonly { lon: number; lat: number; name: string; kind: string }[], known: ReadonlySet<string>): SearchPlace[] {
  const out: SearchPlace[] = [], matched = new Set<City>(), seen = new Set<string>();
  const kinds = new Set(['city', 'town', 'village', 'hamlet', 'neighbourhood']);
  for (const label of labels) {
    if (!kinds.has(label.kind) || !label.name || !Number.isFinite(label.lat) || !Number.isFinite(label.lon)) continue;
    const id = `label:${label.kind}:${label.lat.toFixed(5)},${label.lon.toFixed(5)}`;
    let city: City | undefined;
    if (label.kind === 'city' || label.kind === 'town') {
      let best = 4;
      for (const c of CITIES) {
        if (c.r === null || matched.has(c)) continue;
        const km = metersBetween(label, c) / 1000;
        if (km < best) { best = km; city = c }
      }
      if (city) matched.add(city);
    }
    if (known.has(id) || seen.has(id)) continue;
    seen.add(id);
    const name = city ? city.name : label.name;
    const alt = [label.name, ...(city ? city.aliases : [])].filter(v => v !== name);
    out.push({ id, lat: label.lat, lon: label.lon, tags: { name, 'name:ru': name, ...(alt.length ? { alt_name: alt.join(';') } : {}), 'atlas:type': 'label', 'atlas:place': label.kind, ...(city ? { 'atlas:region': city.region } : {}) } });
  }
  // Towns the map has no label for still have to be found by name.
  for (const c of CITIES) {
    if (c.r === null || matched.has(c)) continue;
    const id = `label:town:${c.lat.toFixed(5)},${c.lon.toFixed(5)}`;
    if (known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, lat: c.lat, lon: c.lon, tags: { name: c.name, 'name:ru': c.name, alt_name: c.aliases.join(';'), 'atlas:type': 'label', 'atlas:place': 'town', 'atlas:region': c.region } });
  }
  return out;
}

type Scored = { entry: SearchEntry; score: number; gap: number };

function gapTo(centre: { lat: number; lon: number }, cos: number, p: SearchPlace) {
  return Math.hypot(p.lat - centre.lat, (p.lon - centre.lon) * cos);
}

function browse(entries: readonly SearchEntry[], { chip, savedOnly, city, centre }: SearchOptions): SearchPlace[] {
  const cos = Math.cos(centre.lat * RAD), saved = savedOnly ? new Set(savedOnly) : null;
  const inside: Scored[] = [], outside: Scored[] = [];
  for (const entry of entries) {
    if (chip !== 'all' && entry.chip !== chip) continue;
    if (saved ? !saved.has(entry.place.id) : NOT_BROWSED.has(entry.type)) continue;
    const scored = { entry, score: 0, gap: gapTo(centre, cos, entry.place) };
    if (saved || !city || inCity(city, entry.place.lat, entry.place.lon)) inside.push(scored);
    else outside.push(scored);
  }
  const byGap = (a: Scored, b: Scored) => a.gap - b.gap;
  inside.sort(byGap);
  // A village with a handful of places still shows a useful list: the nearest ones around it.
  if (!saved && city && inside.length < 20 && outside.length) {
    outside.sort(byGap);
    inside.push(...outside.slice(0, 60 - inside.length));
  }
  return inside.map(s => s.entry.place);
}

function streetKey(entry: SearchEntry) {
  const { lat, lon } = entry.place;
  return `${entry.nameKey}|${entry.refs.join(',')}|${cityAt(lat, lon)?.name ?? `${Math.round(lat * 5)},${Math.round(lon * 5)}`}`;
}

/** Builds every place's searchable text now instead of on the first query. The page calls it when the
    phone is idle, so the first letter typed answers at once. Returns how many texts were built. */
export function prepareSearch(entries: readonly SearchEntry[], limit = Infinity): number {
  let built = 0;
  for (let i = 0; i < entries.length && built < limit; i++) {
    if (entries[i].text === undefined) { fillText(entries[i]); built++ }
  }
  return built;
}

function hasAll(hay: string, needles: readonly string[]) {
  for (let i = 0; i < needles.length; i++) if (!hay.includes(needles[i])) return false;
  return true;
}
function startsAny(names: readonly string[], a: string, b: string) {
  for (let i = 0; i < names.length; i++) if (names[i].startsWith(a) || names[i].startsWith(b)) return true;
  return false;
}
/** Whether each of `words` is in `text` or its Latin twin in `latin`; a word (or twin) shorter than
    `min` characters does not count. */
function eachWord(text: string, latin: string, words: readonly string[], latinWords: readonly string[], min: number, minTwin: number) {
  for (let i = 0; i < words.length; i++) {
    const word = words[i], twin = latinWords[i];
    if (!((word.length >= min && text.includes(word)) || (twin.length >= minTwin && latin.includes(twin)))) return false;
  }
  return true;
}

/** The places for the list: nearest first while browsing, best match first while searching. */
export function searchPlaces(entries: readonly SearchEntry[], options: SearchOptions): SearchPlace[] {
  const query = options.query.trim();
  if (!query) return browse(entries, options);
  const { chip, savedOnly, centre } = options;
  const head: SearchPlace[] = [];
  const point = coordinateQuery(query);
  if (point) head.push({ id: `coord:${point.lat.toFixed(6)},${point.lon.toFixed(6)}`, lat: point.lat, lon: point.lon, tags: { name: `Точка ${point.lat.toFixed(5)}, ${point.lon.toFixed(5)}` } });
  const f = fold(query);
  if (!f) return head;
  const tokens = f.split(' '), wordTokens = tokens.map(t => ' ' + t);
  const L = tokens.map(loose), wordL = L.map(t => ' ' + t), looseF = loose(f);
  const ref = isRefQuery(query) ? refKey(query) : '';
  const cos = Math.cos(centre.lat * RAD), saved = savedOnly ? new Set(savedOnly) : null;
  const found: Scored[] = [];
  for (const entry of entries) {
    if (chip !== 'all' && entry.chip !== chip) continue;
    if (saved && !saved.has(entry.place.id)) continue;
    let score = -1;
    if (ref && entry.refs.length) {
      if (entry.refs.includes(ref)) score = 0;
      else if (entry.refs.some(r => r.startsWith(ref))) score = 1.5;
    }
    // A kind word («аптека», «заправка», «банкомат») finds every place of that kind, nearest first,
    // whatever it is called; a place merely named «Аптека» gets no head start over them.
    if (score < 0 && entry.kind && hasAll(entry.kind, wordTokens)) score = 1;
    if (score < 0) {
      const name = entry.nameKey, alts = entry.alts;
      if (name === f || (alts && (alts.includes(f) || alts.includes(looseF)))) score = 0.2;
      else if (name.startsWith(f) || (alts && startsAny(alts, f, looseF))) score = 1;
      else if (hasAll(entry.words, wordTokens)) score = 2;
      else {
        if (entry.text === undefined) fillText(entry);
        const text = entry.text!, latin = entry.latin!;
        // Every word starts a word of the text, in either alphabet; failing that, sits inside one.
        if (eachWord(text, latin, wordTokens, wordL, 2, 3)) score = 3;
        else if (eachWord(text, latin, tokens, L, 3, 3)) score = 4;
      }
    }
    if (score < 0) continue;
    const place = entry.place, tags = place.tags;
    // A town beats a shop named after it; a whole road beats each of its stretches.
    if (entry.type === 'label' && (tags['atlas:place'] === 'city' || tags['atlas:place'] === 'town')) score -= 0.5;
    else if (entry.type === 'route' && score <= 1.5) score -= 0.6;
    found.push({ entry, score, gap: gapTo(centre, cos, place) });
  }
  found.sort((a, b) => a.score - b.score || a.gap - b.gap);
  // One row per street: a road cut into many stretches is listed once per town.
  const list: SearchPlace[] = [], streets = new Set<string>();
  for (const { entry } of found) {
    if (entry.type === 'street') {
      const key = streetKey(entry);
      if (streets.has(key)) continue;
      streets.add(key);
    }
    list.push(entry.place);
    if (list.length + head.length >= MAX_RESULTS) break;
  }
  return [...head, ...list];
}
