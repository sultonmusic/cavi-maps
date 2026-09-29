/**
 * Road numbers and names on the label canvas: US-style shields ("R-303" on white, "РБ04" blue with
 * a red band) spaced along each road, and main-road names written along the line.
 *
 * Placement is worked out once per route set (setRoutes): every continuous stretch gets anchors at a
 * fixed screen spacing, each with the zoom from which it shows (coarse to fine, like map tiles), so
 * a frame only walks the anchors that are due, projects them and runs the same box collision as the
 * other labels. Per-frame budgets keep the canvas cheap.
 */
import type { Map as GLMap } from 'maplibre-gl'
import { buildChains, isLabelled, type RoadRoute, type RouteChain, type RouteClass, type RouteHw } from './road-routes'

export { buildChains } from './road-routes'

type FrameLabel = { lon: number; lat: number; name: string; kind: string; minzoom: number; maxzoom: number | null; owner?: string; offset?: number }
export type RoadLabelFrame = {
  ctx: CanvasRenderingContext2D
  map: Pick<GLMap, 'project'>
  zoom: number; width: number; height: number; floor: number
  west: number; east: number; south: number; north: number
  /** Screen boxes [x0, y0, x1, y1] already taken by labels drawn this frame. */
  occupied: number[][]
  /** Tap targets: a road label comes back from labelAt/pick as kind 'route' with the route id as owner. */
  boxes: { box: number[]; label: FrameLabel }[]
}
export type Anchor = { s: number; lon: number; lat: number; level: number }

export const SHIELD_SPACING_PX = 320
export const SHIELD_FINE_ZOOM = 14
export const NAME_SPACING_PX = 560
export const NAME_FINE_ZOOM = 18
export const MIN_CHAIN_METERS = 60
export const MAX_SHIELDS_PER_FRAME = 70
export const MAX_NAMES_PER_FRAME = 45
export const MAX_TURN_DEG = 30
export const MAX_TOTAL_TURN_DEG = 60

export const SHIELD_STYLE: Record<Exclude<RouteClass, 'none'>, { fill: string; border: string; edge: string; text: string; band?: string }> = {
  rb: { fill: '#2458b8', border: '#ffffff', edge: '#17396f', text: '#ffffff', band: '#c8312d' },
  intl: { fill: '#1d7f45', border: '#ffffff', edge: '#0f4d29', text: '#ffffff' },
  rj: { fill: '#ffffff', border: '#2b2b2b', edge: '#2b2b2b', text: '#1f1f1f' },
  local: { fill: '#ffffff', border: '#8c8c8c', edge: '#8c8c8c', text: '#3a3a3a' },
  foreign: { fill: '#eeeeea', border: '#a3a3a3', edge: '#a3a3a3', text: '#5a5a5a' },
}
const NAME_FILL = '#4a463d', HALO = '#ffffffeb', HALO_WIDTH = 3.5
const RAD = Math.PI / 180

/** Ground metres per screen pixel (512 px tiles, as MapLibre). */
export function metersPerPixel(zoom: number, lat: number): number {
  return 40075016.686 * Math.cos(lat * RAD) / (512 * 2 ** zoom)
}

function visibleZoom(hw: RouteHw) { return hw === 'motorway' || hw === 'trunk' || hw === 'primary' ? 7 : hw === 'secondary' || hw === 'tertiary' ? 10 : 13 }
const CLASS_MIN: Record<RouteClass, number> = { rb: 7, intl: 7.5, rj: 9, local: 10, foreign: 11, none: 99 }
export function shieldMinZoom(route: RoadRoute): number {
  if (!route.ref || route.cls === 'none') return 99
  return Math.max(CLASS_MIN[route.cls], visibleZoom(route.hw))
}
const NAME_MIN: Record<RouteHw, number> = { motorway: 12.5, trunk: 12.5, primary: 13, secondary: 14, tertiary: 14.5, other: 15 }
export function nameMinZoom(route: RoadRoute): number { return NAME_MIN[route.hw] ?? 15 }
const HW_RANK: Record<RouteHw, number> = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, other: 5 }

function trailingZeros(value: number) { let count = 0; while (value > 0 && value % 2 === 0 && count < 8) { value /= 2; count++ } return count }
function pointAt(chain: RouteChain, s: number): [number, number] {
  const { line, cum } = chain
  if (s <= 0) return line[0]
  if (s >= chain.length) return line[line.length - 1]
  let lo = 0, hi = cum.length - 1
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid }
  const span = cum[hi] - cum[lo], t = span ? (s - cum[lo]) / span : 0
  return [line[lo][0] + (line[hi][0] - line[lo][0]) * t, line[lo][1] + (line[hi][1] - line[lo][1]) * t]
}

/**
 * Anchors along one stretch, each with the zoom from which it is drawn. At zoom zFine they are
 * spacingPx apart; each zoom level out keeps every second one, so the screen spacing stays the
 * same. The middle one appears once the stretch is about half the spacing long on screen.
 * Sorted by level (coarse first).
 */
export function anchorsAlong(chain: RouteChain, spacingPx: number, zFine: number, zMin: number): Anchor[] {
  const length = chain.length
  if (!(length > 0)) return []
  const middle = pointAt(chain, length / 2)
  const spacing = spacingPx * metersPerPixel(zFine, middle[1])
  const zLen = Math.min(zFine, Math.max(zMin, Math.ceil(zFine - Math.log2(2 * length / spacing))))
  const reach = Math.floor(length / 2 / spacing)
  const anchors: Anchor[] = []
  for (let j = -reach; j <= reach; j++) {
    const s = length / 2 + j * spacing
    const level = j === 0 ? zLen : Math.max(zLen, zFine - trailingZeros(Math.abs(j)))
    const [lon, lat] = pointAt(chain, s)
    anchors.push({ s, lon, lat, level })
  }
  return anchors.sort((a, b) => a.level - b.level || Math.abs(a.s - length / 2) - Math.abs(b.s - length / 2))
}

/** Drops anchors that sit too close to an anchor already kept at the same or a coarser level
 * (the other carriageway of a dual road, or where stretches meet). A grid per level keeps this
 * linear: its cell is the largest clearance of that level, so the 3x3 cells around an anchor hold
 * every kept anchor that could be too close. */
export function thinAnchors<T extends { anchor: Anchor }>(items: T[], spacingPx: number, zFine: number): T[] {
  const sorted = items.slice().sort((a, b) => a.anchor.level - b.anchor.level)
  const kept: T[] = [], xs: number[] = [], ys: number[] = []
  // One east-west scale for the whole road, so nearby anchors keep their true distance.
  const kx = 111320 * Math.cos((sorted[0]?.anchor.lat ?? 0) * RAD)
  let grid = new Map<string, number[]>(), level = NaN, cell = 1
  const put = (i: number) => {
    const key = `${Math.floor(xs[i] / cell)},${Math.floor(ys[i] / cell)}`
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  }
  for (const item of sorted) {
    const { lon, lat } = item.anchor
    if (item.anchor.level !== level) {
      level = item.anchor.level
      cell = Math.max(1, 0.5 * spacingPx * metersPerPixel(zFine, 0) * 2 ** (zFine - level))
      grid = new Map()
      for (let i = 0; i < kept.length; i++) put(i)
    }
    const limit = 0.5 * spacingPx * metersPerPixel(zFine, lat) * 2 ** (zFine - level)
    const x = lon * kx, y = lat * 110540
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell)
    let clash = false
    for (let gx = cx - 1; gx <= cx + 1 && !clash; gx++) for (let gy = cy - 1; gy <= cy + 1 && !clash; gy++) {
      for (const i of grid.get(`${gx},${gy}`) ?? []) {
        const dx = xs[i] - x, dy = ys[i] - y
        if (dx * dx + dy * dy < limit * limit) { clash = true; break }
      }
    }
    if (clash) continue
    kept.push(item); xs.push(x); ys.push(y); put(kept.length - 1)
  }
  return kept
}

/**
 * Glyph positions for text written along a projected line: centred, reading left to right, one
 * angle per glyph from the segment under its centre. null when the line bends too sharply
 * (over 30 degrees between segments, or 60 in all) or is shorter than the text.
 */
export function layoutAlong(points: { x: number; y: number }[], advances: number[]): { x: number; y: number; angle: number }[] | null {
  let line = points.filter((point, i) => i === 0 || Math.hypot(point.x - points[i - 1].x, point.y - points[i - 1].y) > 0.01)
  if (line.length < 2) return null
  if (line[line.length - 1].x < line[0].x) line = line.slice().reverse()
  const angles: number[] = [], cum = [0]
  for (let i = 1; i < line.length; i++) {
    angles.push(Math.atan2(line[i].y - line[i - 1].y, line[i].x - line[i - 1].x))
    cum.push(cum[i - 1] + Math.hypot(line[i].x - line[i - 1].x, line[i].y - line[i - 1].y))
  }
  let total = 0
  for (let i = 1; i < angles.length; i++) {
    let turn = Math.abs(angles[i] - angles[i - 1])
    if (turn > Math.PI) turn = 2 * Math.PI - turn
    if (turn > MAX_TURN_DEG * RAD) return null
    total += turn
  }
  if (total > MAX_TOTAL_TURN_DEG * RAD) return null
  const textLength = advances.reduce((sum, value) => sum + value, 0)
  const length = cum[cum.length - 1]
  if (textLength > length + 0.5) return null
  let at = (length - textLength) / 2, segment = 0
  const result: { x: number; y: number; angle: number }[] = []
  for (const advance of advances) {
    const centre = at + advance / 2
    while (segment < angles.length - 1 && cum[segment + 1] < centre) segment++
    const span = cum[segment + 1] - cum[segment], t = span ? (centre - cum[segment]) / span : 0
    result.push({
      x: line[segment].x + (line[segment + 1].x - line[segment].x) * t,
      y: line[segment].y + (line[segment + 1].y - line[segment].y) * t,
      angle: angles[segment],
    })
    at += advance
  }
  return result
}

type ShieldRoute = { route: RoadRoute; minZoom: number; bbox: RoadRoute['bbox']; anchors: Anchor[] }
type NamePart = { chain: RouteChain; bbox: RoadRoute['bbox']; anchors: Anchor[] }
/** The ways of one road that carry one name. Their stretches and anchors are worked out the first
 * time the name can show (in view, close enough), so setRoutes stays cheap for the whole country. */
type NameGroup = { route: RoadRoute; text: string; minZoom: number; weight: number; lines: [number, number][][]; bbox: RoadRoute['bbox']; length: number; parts: NamePart[] | null }

function chainBox(chain: RouteChain): RoadRoute['bbox'] {
  let west = Infinity, south = Infinity, east = -Infinity, north = -Infinity
  for (const [lon, lat] of chain.line) { west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat) }
  return [west, south, east, north]
}
const inView = (box: RoadRoute['bbox'], f: RoadLabelFrame) => box[2] >= f.west && box[0] <= f.east && box[3] >= f.south && box[1] <= f.north
const overlaps = (box: number[], occupied: number[][]) => occupied.some(other => other[0] < box[2] && other[2] > box[0] && other[1] < box[3] && other[3] > box[1])

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const radius = Math.max(0, Math.min(r, w / 2, h / 2))
  ctx.beginPath()
  ctx.moveTo(x + radius, y)
  ctx.arcTo(x + w, y, x + w, y + h, radius)
  ctx.arcTo(x + w, y + h, x, y + h, radius)
  ctx.arcTo(x, y + h, x, y, radius)
  ctx.arcTo(x, y, x + w, y, radius)
  ctx.closePath()
}

/** One shield in CSS pixels at (x, y) top-left; the caller scales for the device pixel ratio. */
function paintShield(ctx: CanvasRenderingContext2D, text: string, cls: Exclude<RouteClass, 'none'>, x: number, y: number, w: number, h: number, font: number) {
  const style = SHIELD_STYLE[cls]
  const radius = 3.5
  ctx.fillStyle = style.edge
  roundRect(ctx, x, y, w, h, radius); ctx.fill()
  let textTop = y, textHeight = h
  if (cls === 'rb' || cls === 'intl') {
    ctx.fillStyle = style.border
    roundRect(ctx, x + 1, y + 1, w - 2, h - 2, radius - 1); ctx.fill()
    ctx.fillStyle = style.fill
    roundRect(ctx, x + 2.2, y + 2.2, w - 4.4, h - 4.4, radius - 1.8); ctx.fill()
    if (style.band) {
      const band = h * 0.22
      ctx.save()
      roundRect(ctx, x + 2.2, y + 2.2, w - 4.4, h - 4.4, radius - 1.8); ctx.clip()
      ctx.fillStyle = style.band
      ctx.fillRect(x, y, w, 2.2 + band)
      ctx.restore()
      textTop = y + 2.2 + band; textHeight = h - 2.2 - band
    }
  } else {
    ctx.fillStyle = style.border
    roundRect(ctx, x, y, w, h, radius); ctx.fill()
    ctx.fillStyle = style.fill
    roundRect(ctx, x + 1.2, y + 1.2, w - 2.4, h - 2.4, radius - 1); ctx.fill()
  }
  ctx.fillStyle = style.text
  ctx.font = `700 ${font}px Arial`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, x + w / 2, textTop + textHeight / 2 + 0.5)
}

export function createRoadLabels() {
  let shields: ShieldRoute[] = []
  let names: NameGroup[] = []
  let covered = new Set<string>()
  const widths = new Map<string, number>()
  const advancesCache = new Map<string, number[]>()
  const bitmaps = new Map<string, { canvas: HTMLCanvasElement; w: number; h: number }>()

  function measure(ctx: CanvasRenderingContext2D, font: string, text: string) {
    const key = font + '|' + text
    let width = widths.get(key)
    if (width === undefined) { ctx.font = font; width = ctx.measureText(text).width; widths.set(key, width) }
    return width
  }
  function advances(ctx: CanvasRenderingContext2D, font: string, text: string) {
    const key = font + '|' + text
    let list = advancesCache.get(key)
    if (!list) { list = [...text].map(char => measure(ctx, font, char)); advancesCache.set(key, list) }
    return list
  }
  function shieldBitmap(ctx: CanvasRenderingContext2D, text: string, cls: Exclude<RouteClass, 'none'>, small: boolean, dpr: number) {
    const key = `${text}|${cls}|${small}|${dpr}`
    let bitmap = bitmaps.get(key)
    if (!bitmap) {
      const font = small ? 10 : 11, h = small ? 15 : 17
      const w = Math.max(24, Math.ceil(measure(ctx, `700 ${font}px Arial`, text) + 10))
      const canvas = document.createElement('canvas')
      canvas.width = Math.ceil(w * dpr); canvas.height = Math.ceil(h * dpr)
      const paint = canvas.getContext('2d')
      if (paint) { paint.scale(dpr, dpr); paintShield(paint, text, cls, 0, 0, w, h, font) }
      bitmap = { canvas, w, h }
      if (bitmaps.size > 600) bitmaps.clear()
      bitmaps.set(key, bitmap)
    }
    return bitmap
  }

  /** Builds stretches and anchors for the routes to draw: numbered or named roads, and extra
   * strokes the admin labelled. Every way of every route passed hides its old per-way label. */
  function setRoutes(routes: RoadRoute[]) {
    covered = new Set<string>()
    for (const route of routes) for (const way of route.ways) covered.add(way.id)
    const drawn = routes.filter(route => isLabelled(route) && (!route.extra || route.edited))
    const nextShields: ShieldRoute[] = []
    const nextNames: NameGroup[] = []
    for (const route of drawn) {
      if (route.ref && route.cls !== 'none') {
        const chains = buildChains(route.ways.map(way => way.line)).filter(chain => chain.length >= MIN_CHAIN_METERS).sort((a, b) => b.length - a.length)
        const items = chains.flatMap(chain => anchorsAlong(chain, SHIELD_SPACING_PX, SHIELD_FINE_ZOOM, 6).map(anchor => ({ anchor })))
        const anchors = thinAnchors(items, SHIELD_SPACING_PX, SHIELD_FINE_ZOOM).map(item => item.anchor)
        if (anchors.length) nextShields.push({ route, minZoom: shieldMinZoom(route), bbox: route.bbox, anchors })
      }
      const byName = new Map<string, NameGroup>()
      const minZoom = nameMinZoom(route)
      for (const way of route.ways) {
        if (!way.name || way.line.length < 2) continue
        let group = byName.get(way.name)
        if (!group) {
          group = { route, text: way.name, minZoom, weight: HW_RANK[route.hw] ?? 5, lines: [], bbox: [Infinity, Infinity, -Infinity, -Infinity], length: 0, parts: null }
          byName.set(way.name, group)
          nextNames.push(group)
        }
        group.lines.push(way.line)
        const box = group.bbox, line = way.line, kx = 111320 * Math.cos(line[0][1] * RAD)
        let lastLon = line[0][0], lastLat = line[0][1], length = 0
        for (let i = 0; i < line.length; i++) {
          const lon = line[i][0], lat = line[i][1]
          if (lon < box[0]) box[0] = lon
          if (lat < box[1]) box[1] = lat
          if (lon > box[2]) box[2] = lon
          if (lat > box[3]) box[3] = lat
          const dx = (lon - lastLon) * kx, dy = (lat - lastLat) * 110540
          length += Math.sqrt(dx * dx + dy * dy)
          lastLon = lon; lastLat = lat
        }
        group.length += length
      }
    }
    nextShields.sort((a, b) => a.minZoom - b.minZoom || b.route.km - a.route.km)
    nextNames.sort((a, b) => a.weight - b.weight || b.length - a.length)
    shields = nextShields
    names = nextNames
  }

  function drawShields(frame: RoadLabelFrame) {
    const { ctx, map, zoom } = frame
    if (zoom < 6.5 || !shields.length) return
    const dpr = ctx.getTransform?.().a || 1
    const small = zoom < 10
    let drawn = 0
    ctx.save()
    for (const item of shields) {
      if (zoom < item.minZoom || !inView(item.bbox, frame)) continue
      const { route } = item
      const cls = route.cls as Exclude<RouteClass, 'none'>
      for (const anchor of item.anchors) {
        if (anchor.level > zoom) break
        if (anchor.lon < frame.west || anchor.lon > frame.east || anchor.lat < frame.south || anchor.lat > frame.north) continue
        const point = map.project([anchor.lon, anchor.lat])
        if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue
        if (point.x < 20 || point.x > frame.width - 20 || point.y < frame.floor + 12 || point.y > frame.height - 12) continue
        const bitmap = shieldBitmap(ctx, route.ref!, cls, small, dpr)
        const x = Math.round(point.x - bitmap.w / 2), y = Math.round(point.y - bitmap.h / 2)
        const box = [x - 2, y - 2, x + bitmap.w + 2, y + bitmap.h + 2]
        if (overlaps(box, frame.occupied)) continue
        frame.occupied.push(box)
        frame.boxes.push({ box, label: { lon: anchor.lon, lat: anchor.lat, name: route.ref!, kind: 'route', owner: route.id, minzoom: 0, maxzoom: null } })
        ctx.drawImage(bitmap.canvas, x, y, bitmap.w, bitmap.h)
        if (++drawn >= MAX_SHIELDS_PER_FRAME) { ctx.restore(); return }
      }
    }
    ctx.restore()
  }

  function nameParts(group: NameGroup): NamePart[] {
    if (group.parts) return group.parts
    const chains = buildChains(group.lines).filter(chain => chain.length >= MIN_CHAIN_METERS).sort((a, b) => b.length - a.length)
    const items = chains.flatMap(chain => anchorsAlong(chain, NAME_SPACING_PX, NAME_FINE_ZOOM, group.minZoom).map(anchor => ({ anchor, chain })))
    const perChain = new Map<RouteChain, Anchor[]>()
    for (const { anchor, chain } of thinAnchors(items, NAME_SPACING_PX, NAME_FINE_ZOOM)) {
      const list = perChain.get(chain)
      if (list) list.push(anchor)
      else perChain.set(chain, [anchor])
    }
    group.parts = chains.filter(chain => perChain.has(chain)).map(chain => ({ chain, bbox: chainBox(chain), anchors: perChain.get(chain)!.sort((a, b) => a.level - b.level) }))
    return group.parts
  }

  /** Window of the stretch around s, shifted to stay inside it, as projected points. */
  function project(frame: RoadLabelFrame, chain: RouteChain, s: number, meters: number) {
    const half = meters / 2
    let from = s - half, to = s + half
    if (from < 0) { to -= from; from = 0 }
    if (to > chain.length) { from -= to - chain.length; to = chain.length }
    from = Math.max(0, from)
    const points: [number, number][] = [pointAt(chain, from)]
    let lo = 0, hi = chain.cum.length
    while (lo < hi) { const mid = (lo + hi) >> 1; if (chain.cum[mid] <= from) lo = mid + 1; else hi = mid }
    for (let i = lo; i < chain.cum.length && chain.cum[i] < to; i++) points.push(chain.line[i])
    points.push(pointAt(chain, to))
    const projected: { x: number; y: number }[] = []
    let length = 0
    for (const point of points) {
      const p = frame.map.project(point)
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || p.y < frame.floor + 10 || p.x < 0 || p.x > frame.width || p.y > frame.height) return null
      if (projected.length) length += Math.hypot(p.x - projected[projected.length - 1].x, p.y - projected[projected.length - 1].y)
      projected.push({ x: p.x, y: p.y })
    }
    return { points: projected, length }
  }

  function drawNames(frame: RoadLabelFrame) {
    const { ctx, zoom } = frame
    if (zoom < 12.5 || !names.length) return
    const size = zoom < 15 ? 12 : zoom < 17 ? 13 : 14
    const half = (size + 2) / 2
    let drawn = 0
    ctx.save()
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.lineJoin = 'round'
    for (const group of names) {
      if (zoom < group.minZoom || !inView(group.bbox, frame)) continue
      const font = `${group.weight <= HW_RANK.primary ? 600 : 500} ${size}px Arial`
      const textWidth = measure(ctx, font, group.text)
      const glyphs = advances(ctx, font, group.text)
      const chars = [...group.text]
      for (const { chain, bbox, anchors } of nameParts(group)) {
        if (!inView(bbox, frame)) continue
        for (const anchor of anchors) {
          if (anchor.level > zoom) break
          if (anchor.lon < frame.west || anchor.lon > frame.east || anchor.lat < frame.south || anchor.lat > frame.north) continue
          let meters = (textWidth + 16) * metersPerPixel(zoom, anchor.lat)
          if (chain.length < 0.9 * meters) continue
          let window = project(frame, chain, anchor.s, meters)
          if (window && window.length < textWidth + 4 && window.length > 0) {
            // Tilted, the ground under the text is foreshortened: ask for a longer stretch once.
            meters *= (textWidth + 16) / window.length
            window = chain.length < 0.9 * meters ? null : project(frame, chain, anchor.s, meters)
          }
          if (!window) continue
          const placed = layoutAlong(window.points, glyphs)
          if (!placed) continue
          const glyphBoxes = placed.map(glyph => [glyph.x - half, glyph.y - half, glyph.x + half, glyph.y + half])
          if (glyphBoxes.some(box => overlaps(box, frame.occupied))) continue
          frame.occupied.push(...glyphBoxes)
          const union = [Infinity, Infinity, -Infinity, -Infinity]
          for (const box of glyphBoxes) { union[0] = Math.min(union[0], box[0]); union[1] = Math.min(union[1], box[1]); union[2] = Math.max(union[2], box[2]); union[3] = Math.max(union[3], box[3]) }
          frame.boxes.push({ box: union, label: { lon: anchor.lon, lat: anchor.lat, name: group.text, kind: 'route', owner: group.route.id, minzoom: 0, maxzoom: null } })
          ctx.font = font
          ctx.lineWidth = HALO_WIDTH
          ctx.strokeStyle = HALO
          ctx.fillStyle = NAME_FILL
          // Halo first for every glyph, so no halo covers a neighbour's letter.
          for (const fill of [false, true]) {
            placed.forEach((glyph, i) => {
              ctx.save()
              ctx.translate(glyph.x, glyph.y)
              ctx.rotate(glyph.angle)
              if (fill) ctx.fillText(chars[i], 0, 0)
              else ctx.strokeText(chars[i], 0, 0)
              ctx.restore()
            })
          }
          if (++drawn >= MAX_NAMES_PER_FRAME) { ctx.restore(); return }
        }
      }
    }
    ctx.restore()
  }

  return {
    setRoutes, drawShields, drawNames,
    covers(owner?: string) { return !!owner && covered.has(owner) },
  }
}

