/**
 * Roads as whole routes ("R-303", "РБ04 · Памирский тракт"), from public/road-routes.json made by
 * scripts/build-road-routes.py: decoding, admin edits, ref matching and search.
 * Pure: no DOM and no React, so the map, the admin and the node checks share it.
 */
import { createStreetIndex, type Road } from './street-index'
import type { MapPlace } from './map-places'

export type RouteClass = 'rb' | 'rj' | 'intl' | 'local' | 'foreign' | 'none'
export type RouteHw = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'other'

/** The file format; see the docstring of scripts/build-road-routes.py. */
export type RoadRoutesFile = {
  version: 1
  kind: 'labelled' | 'extra'
  source: string
  license: string
  scale: number
  names: string[]
  routes: { id: string; ref: string | null; refs?: string[]; name: string | null; hw: string; km: number; ways: number[][] }[]
}

export type RouteWay = { id: string; name: string | null; oneway: boolean; link: boolean; line: [number, number][] }
export type RoadRoute = {
  id: string
  ref: string | null
  refs: string[]
  name: string | null
  hw: RouteHw
  km: number
  /** [west, south, east, north] */
  bbox: [number, number, number, number]
  ways: RouteWay[]
  cls: RouteClass
  /** An unlabelled stroke from road-routes-extra.json. */
  extra: boolean
  /** The admin changed its number or name. */
  edited: boolean
  /** Number and name as OpenStreetMap has them, before admin edits. */
  source: { ref: string | null; name: string | null }
}
/** The part of a live-store RoadEdit that routes read: 'route/<route id>' or 'way/<id>'. */
export type RouteEdit = { roadId: string; name?: string; ref?: string }
export type RouteChain = { line: [number, number][]; cum: number[]; length: number }

const HWS: readonly RouteHw[] = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'other']
const CLASS_RANK: Record<RouteClass, number> = { rb: 0, rj: 1, local: 2, intl: 3, foreign: 4, none: 5 }
const RAD = Math.PI / 180
const EARTH = 6_371_008.8

/** Road numbers compared loosely: 'РБ-04', 'rb 4' and 'RB04' are all 'RB4'; 'Р-303' is 'R303'. */
export function refKey(text: string): string {
  return latinKey(text).replace(/\d+/g, digits => digits.replace(/^0+(?=\d)/, ''))
}

const TRANSLIT: Record<string, string> = {
  Р: 'R', Б: 'B', Ҷ: 'J', Ч: 'CH', Ж: 'ZH', М: 'M', А: 'A', Е: 'E', Ё: 'E', Э: 'E', Н: 'N', К: 'K', В: 'V', Т: 'T',
  О: 'O', С: 'S', Х: 'H', Д: 'D',
}
/** refKey with leading zeros kept ('РҶ026' -> 'RJ026'), so '026' still finds it. */
function latinKey(text: string): string {
  return String(text ?? '').toUpperCase().replace(/[\s\-_.·–—]/g, '').replace(/[А-ЯЁҶ]/g, char => TRANSLIT[char] ?? char)
}

export function refClass(ref: string | null): RouteClass {
  const key = refKey(ref ?? '')
  if (!key) return 'none'
  if (/^RB\d/.test(key)) return 'rb'
  if (/^(RJ|RDJ|RCH|RZH|RDZH)\d/.test(key)) return 'rj'
  if (/^R\d/.test(key)) return 'local'
  if (/^(M|AH|E)\d/.test(key)) return 'intl'
  return 'foreign'
}

const LOOKALIKE: Record<string, string> = { r: 'р', m: 'м', a: 'а', e: 'е', b: 'в', h: 'н', k: 'к', p: 'р', c: 'с', t: 'т', x: 'х', o: 'о' }
/** Lower-case spellings a person may type for a number, for plain substring search:
 * 'R-303' -> r-303, r303, р-303, р303, r 303 ...; 'РБ04' -> рб04, rb4, rb04, рб4, rb 4 ... */
export function searchVariants(ref: string): string[] {
  const lower = String(ref ?? '').trim().toLowerCase()
  if (!lower) return []
  const compact = lower.replace(/[\s\-_.·]/g, '')
  const noZeros = (text: string) => text.replace(/\d+/g, digits => digits.replace(/^0+(?=\d)/, ''))
  const base = [lower, compact, noZeros(compact), refKey(ref).toLowerCase(), latinKey(ref).toLowerCase()]
  const cyrillic = base.map(text => text.replace(/[a-z]/g, char => LOOKALIKE[char] ?? char))
  const all = [...base, ...cyrillic]
  const spaced = all.map(text => text.replace(/^([^\d\s-]+)(\d)/, '$1 $2'))
  return [...new Set([...all, ...spaced].filter(Boolean))]
}

function metres(a: [number, number], b: [number, number]) {
  const lat = (a[1] + b[1]) / 2 * RAD
  const dx = (b[0] - a[0]) * RAD * Math.cos(lat), dy = (b[1] - a[1]) * RAD
  return EARTH * Math.sqrt(dx * dx + dy * dy)
}

/** Ways joined into continuous lines, only through points where exactly two way ends meet
 * (a junction of three ends a chain). Lines are reversed as needed. cum[] is metres along. */
export function buildChains(lines: [number, number][][]): RouteChain[] {
  const usable = lines.filter(line => Array.isArray(line) && line.length >= 2)
  const key = (point: [number, number]) => `${Math.round(point[0] * 1e5)},${Math.round(point[1] * 1e5)}`
  const ends = new Map<string, { line: number; end: 0 | 1 }[]>()
  usable.forEach((line, index) => {
    for (const end of [0, 1] as const) {
      const at = key(end ? line[line.length - 1] : line[0])
      const list = ends.get(at)
      if (list) list.push({ line: index, end })
      else ends.set(at, [{ line: index, end }])
    }
  })
  const link = (line: number, end: 0 | 1) => {
    const at = ends.get(key(end ? usable[line][usable[line].length - 1] : usable[line][0]))
    if (!at || at.length !== 2) return null
    const other = at[0].line === line && at[0].end === end ? at[1] : at[0]
    return other.line === line ? null : other
  }
  const used = new Uint8Array(usable.length)
  const chains: RouteChain[] = []
  for (let start = 0; start < usable.length; start++) {
    if (used[start]) continue
    // Walk back to where this chain begins (or all the way round a ring).
    let first = start, firstEnd: 0 | 1 = 0
    const seen = new Set([start])
    for (;;) {
      const previous = link(first, firstEnd)
      if (!previous || used[previous.line] || seen.has(previous.line)) break
      seen.add(previous.line)
      first = previous.line
      firstEnd = previous.end === 0 ? 1 : 0
    }
    // Then forward, collecting lines in travel order.
    const line: [number, number][] = []
    let current = first, entry: 0 | 1 = firstEnd
    for (;;) {
      used[current] = 1
      const points = entry === 0 ? usable[current] : usable[current].slice().reverse()
      line.push(...(line.length ? points.slice(1) : points))
      const exit: 0 | 1 = entry === 0 ? 1 : 0
      const next = link(current, exit)
      if (!next || used[next.line]) break
      current = next.line
      entry = next.end
    }
    const cum = [0]
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + metres(line[i - 1], line[i]))
    chains.push({ line, cum, length: cum[cum.length - 1] })
  }
  return chains
}

export function decodeRoadRoutes(file: RoadRoutesFile): RoadRoute[] {
  if (!file || file.version !== 1 || !Array.isArray(file.routes)) return []
  const scale = Number(file.scale) || 100000
  const names = Array.isArray(file.names) ? file.names : []
  const extra = file.kind === 'extra'
  const routes: RoadRoute[] = []
  for (const record of file.routes) {
    if (!record || typeof record.id !== 'string' || !Array.isArray(record.ways)) continue
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    const ways: RouteWay[] = []
    for (const way of record.ways) {
      if (!Array.isArray(way) || way.length < 7 || (way.length - 3) % 2) continue
      const [id, nameIndex, flags] = way
      let x = way[3], y = way[4]
      const line: [number, number][] = [[x / scale, y / scale]]
      for (let i = 5; i < way.length; i += 2) {
        x += way[i]; y += way[i + 1]
        line.push([x / scale, y / scale])
      }
      for (const [lon, lat] of line) {
        if (lon < west) west = lon
        if (lon > east) east = lon
        if (lat < south) south = lat
        if (lat > north) north = lat
      }
      ways.push({ id: `way/${id}`, name: nameIndex >= 0 && nameIndex < names.length ? names[nameIndex] : null, oneway: !!(flags & 1), link: !!(flags & 2), line })
    }
    if (!ways.length) continue
    const ref = typeof record.ref === 'string' && record.ref ? record.ref : null
    const name = typeof record.name === 'string' && record.name ? record.name : null
    routes.push({
      id: record.id, ref, refs: Array.isArray(record.refs) ? record.refs.filter(value => typeof value === 'string') : [], name,
      hw: (HWS as readonly string[]).includes(record.hw) ? record.hw as RouteHw : 'other', km: Number(record.km) || 0,
      bbox: [west, south, east, north], ways, cls: refClass(ref), extra, edited: false, source: { ref, name },
    })
  }
  return routes
}

/**
 * Routes with the admin's edits: 'route/<id>' changes the number and the name ('' hides either);
 * a new road name also renames the ways that had no name or the road's own old name, while city
 * streets along it keep theirs. A 'way/<id>' rename still wins for that way.
 * Pass the routes as decoded (before edits); they are not mutated.
 */
export function applyRouteEdits(routes: RoadRoute[], edits: Record<string, RouteEdit>): RoadRoute[] {
  const wayEdits = new Map<string, string>()
  for (const [key, edit] of Object.entries(edits ?? {})) {
    if (key.startsWith('way/') && typeof edit?.name === 'string' && edit.name.trim()) wayEdits.set(key, edit.name.trim())
  }
  return routes.map(route => {
    const edit = edits?.['route/' + route.id]
    if (!edit && !route.ways.some(way => wayEdits.has(way.id))) return route
    const ref = edit && typeof edit.ref === 'string' ? edit.ref.trim() || null : route.source.ref
    const name = edit && typeof edit.name === 'string' ? edit.name.trim() || null : route.source.name
    const renamed = !!edit && typeof edit.name === 'string'
    const ways = route.ways.map(way => {
      const own = wayEdits.get(way.id)
      const effective = own ?? (renamed && (way.name === null || way.name === route.source.name) ? name : way.name)
      return effective === way.name ? way : { ...way, name: effective }
    })
    const key = ref ? refKey(ref) : ''
    return { ...route, ref, name, ways, cls: refClass(ref), refs: route.refs.filter(other => refKey(other) !== key), edited: !!edit }
  })
}

export function isLabelled(route: RoadRoute): boolean {
  return !!route.ref || !!route.name || route.ways.some(way => way.name)
}

export function routeTitle(route: RoadRoute): string {
  return route.ref && route.name ? `${route.ref} · ${route.name}` : route.ref || route.name || 'Дорога без номера'
}

const FOLD: Record<string, string> = { ё: 'е', ӣ: 'и', ӯ: 'у', ҷ: 'ч', ҳ: 'х', қ: 'к', ғ: 'г' }
const fold = (text: string) => text.toLowerCase().replace(/[ёӣӯҷҳқғ]/g, char => FOLD[char]).replace(/\s+/g, ' ').trim()
type SearchEntry = { keys: [string, string][]; name: string; text: string }
const searchCache = new WeakMap<RoadRoute, SearchEntry>()
function searchEntry(route: RoadRoute): SearchEntry {
  let entry = searchCache.get(route)
  if (!entry) {
    const refs = [route.ref, ...route.refs].filter((value): value is string => !!value)
    const wayNames = [...new Set(route.ways.map(way => way.name).filter((value): value is string => !!value))]
    entry = { keys: refs.map(ref => [refKey(ref), latinKey(ref)]), name: fold(route.name ?? ''), text: fold([route.name ?? '', ...wayNames].join(' | ')) }
    searchCache.set(route, entry)
  }
  return entry
}

/** The roads a query means, best first: a number ('r303', 'Р-303', 'рб 4', 'M41') or words of a
 * name ('Памирский'). Ties go to national roads first, then longer roads. */
export function findRoutes(routes: RoadRoute[], query: string, limit = 20, includeUnlabelled = false): RoadRoute[] {
  const text = String(query ?? '').trim()
  if (!text) return []
  const key = refKey(text), zeros = latinKey(text)
  const words = fold(text).split(' ').filter(Boolean)
  const scored: { route: RoadRoute; score: number }[] = []
  for (const route of routes) {
    if (!includeUnlabelled && !isLabelled(route)) continue
    const entry = searchEntry(route)
    let score = 0
    for (const [refK, refZ] of entry.keys) {
      if (key && refK === key) score = Math.max(score, 100)
      else if ((key.length >= 2 && refK.startsWith(key)) || (zeros.length >= 2 && refZ.startsWith(zeros))) score = Math.max(score, 80)
      else if ((key.length >= 3 && refK.includes(key)) || (zeros.length >= 3 && refZ.includes(zeros))) score = Math.max(score, 60)
    }
    if (score < 70 && words.length && words.every(word => entry.text.includes(word))) score = Math.max(score, entry.name.startsWith(words[0]) ? 70 : 50)
    if (score) scored.push({ route, score })
  }
  scored.sort((a, b) => b.score - a.score || CLASS_RANK[a.route.cls] - CLASS_RANK[b.route.cls] || b.route.km - a.route.km || (a.route.id < b.route.id ? -1 : 1))
  return scored.slice(0, Math.max(0, limit)).map(item => item.route)
}

// Edits keep each way's line array, so the first line stands for the road's geometry.
const midpoints = new WeakMap<object, { lat: number; lon: number }>()
/** Midpoint of the road's longest continuous stretch. */
export function routeMidpoint(route: RoadRoute): { lat: number; lon: number } {
  const key = route.ways[0]?.line
  const known = key && midpoints.get(key)
  if (known) return known
  const point = midpoint(route)
  if (key) midpoints.set(key, point)
  return point
}
function midpoint(route: RoadRoute): { lat: number; lon: number } {
  const chains = buildChains(route.ways.map(way => way.line))
  let best = chains[0]
  for (const chain of chains) if (chain.length > best.length) best = chain
  if (!best) return { lon: (route.bbox[0] + route.bbox[2]) / 2, lat: (route.bbox[1] + route.bbox[3]) / 2 }
  const half = best.length / 2
  for (let i = 1; i < best.line.length; i++) {
    if (best.cum[i] >= half) {
      const span = best.cum[i] - best.cum[i - 1], t = span ? (half - best.cum[i - 1]) / span : 0
      const [a, b] = [best.line[i - 1], best.line[i]]
      return { lon: a[0] + (b[0] - a[0]) * t, lat: a[1] + (b[1] - a[1]) * t }
    }
  }
  return { lon: best.line[0][0], lat: best.line[0][1] }
}

/**
 * A search result and map card for a road. A tap on a name along the road passes that name as
 * `text` (and the tapped point as `at`): the card keeps the name, gets its own id so a live refresh
 * of the road's search place does not retitle it, and highlights only the ways with that name.
 */
export function routePlace(route: RoadRoute, text?: string, at?: { lat: number; lon: number }): MapPlace {
  const point = at && Number.isFinite(at.lat) && Number.isFinite(at.lon) ? at : routeMidpoint(route)
  const street = text && text !== route.ref ? text : null
  const title = street ?? routeTitle(route)
  const search = [...[route.ref, ...route.refs].filter((value): value is string => !!value).flatMap(searchVariants), route.name ?? ''].filter(Boolean).join(' ')
  const tags: Record<string, string> = {
    name: title, 'name:ru': title, 'atlas:type': 'route', 'atlas:route-id': route.id, 'atlas:search': search,
    'addr:city': `Таджикистан · ${route.km.toLocaleString('ru-RU')} км`,
  }
  if (route.ref) tags.ref = route.ref
  if (street) tags['atlas:route-name'] = street
  return { id: street ? `route:${route.id}|${street}` : 'route:' + route.id, lat: point.lat, lon: point.lon, tags }
}

/** The road as one shape; with `name`, only its ways of that name (all ways when none has it). */
export function routeShape(route: RoadRoute, name?: string | null): { type: 'MultiLineString'; coordinates: number[][][] } {
  const named = name ? route.ways.filter(way => way.name === name) : []
  return { type: 'MultiLineString', coordinates: (named.length ? named : route.ways).map(way => way.line.map(point => [point[0], point[1]])) }
}

/** Which road is under a tap (a street-index over every way of every route) and which road a way belongs to. */
export function createRouteIndex(routes: RoadRoute[]) {
  const roads: Road[] = []
  const byWay = new Map<string, RoadRoute>()
  routes.forEach((route, routeIndex) => route.ways.forEach((way, wayIndex) => {
    if (!byWay.has(way.id)) byWay.set(way.id, route)
    let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
    for (const [lon, lat] of way.line) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat) }
    roads.push({ id: `rw:${routeIndex}:${wayIndex}`, coordinates: way.line, name: null, ref: null, tags: {}, bbox: [west, south, east, north] })
  }))
  const index = createStreetIndex(roads)
  return {
    nearest(lat: number, lon: number, radiusMeters: number): RoadRoute | null {
      const match = index.nearest(lat, lon, radiusMeters)
      return match ? routes[Number(match.road.id.split(':')[1])] ?? null : null
    },
    routeOfWay(wayId: string): RoadRoute | null { return byWay.get(wayId) ?? null },
  }
}
