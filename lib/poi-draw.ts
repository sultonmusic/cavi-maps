/* Place discs on the map: drawn in the browser at the screen's pixel density and handed to
 * MapLibre with addImage when a symbol layer first asks for them, so the offline map needs no
 * sprite sheet and no glyph server. Also the destination pin with the same pictogram, and the
 * bookkeeping that keeps the overlay's place names in step with the discs MapLibre kept. */
import type { Map as GLMap } from 'maplibre-gl'
import { GLYPHS, type Glyph } from './poi-glyphs.mjs'
import { POI_BOX, POI_COLOURS, POI_DISC, POI_GLYPH, POI_IMAGE_PREFIX, poiRadius } from './poi-icons.mjs'

/** The glyph of a pictogram name; nothing for an unknown name (including Object.prototype's). */
export const glyphOf = (icon: string | null | undefined): Glyph | undefined =>
  icon && Object.prototype.hasOwnProperty.call(GLYPHS, icon) ? GLYPHS[icon] : undefined

/** Image pixels per CSS pixel: never below the screen's, so a disc is only ever scaled down. */
function densityOf(ratio: number) {
  return Math.min(3, Math.max(1, Math.ceil((Number.isFinite(ratio) ? ratio : 1) - 0.05)))
}

let paths: Map<string, Path2D | null> | null = null
/** Path2D objects are kept, so a map made again draws its discs without parsing the paths again. */
function path2d(d: string): Path2D | null {
  paths ??= new Map()
  let path = paths.get(d)
  if (path === undefined) {
    try { path = new Path2D(d) } catch { path = null }
    paths.set(d, path)
  }
  return path
}

/** A pictogram in white, `size` CSS pixels across, centred on (cx, cy). */
function drawGlyph(ctx: CanvasRenderingContext2D, glyph: Glyph, cx: number, cy: number, size: number) {
  ctx.save()
  ctx.translate(cx - size / 2, cy - size / 2)
  ctx.scale(size / 24, size / 24)
  ctx.strokeStyle = ctx.fillStyle = POI_COLOURS.glyph
  ctx.lineWidth = POI_GLYPH.stroke
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  for (const d of glyph.s) {
    const path = path2d(d)
    if (path) ctx.stroke(path)
  }
  for (const d of glyph.f ?? []) {
    const path = path2d(d)
    if (path) { ctx.fill(path); ctx.stroke(path) }
  }
  ctx.restore()
}

/**
 * A grey disc with a white ring, a soft shadow and the white pictogram `icon` (an unknown name
 * draws a map pin), POI_BOX CSS pixels square at `ratio` image pixels per CSS pixel.
 */
export function poiImage(icon: string, ratio = typeof devicePixelRatio === 'number' ? devicePixelRatio : 1): { data: ImageData; pixelRatio: number } | null {
  if (typeof document === 'undefined') return null
  const density = densityOf(ratio), side = POI_BOX * density
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = side
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  ctx.scale(density, density)
  const { cx, cy, outer, ring } = POI_DISC
  // The white ring carries the shadow. Shadows ignore the transform, so they are set in image pixels.
  ctx.save()
  ctx.shadowColor = POI_COLOURS.shadow
  ctx.shadowBlur = 1.5 * density
  ctx.shadowOffsetY = 0.75 * density
  ctx.fillStyle = POI_COLOURS.ring
  ctx.beginPath()
  ctx.arc(cx, cy, outer, 0, Math.PI * 2)
  ctx.fill()
  ctx.restore()
  ctx.fillStyle = POI_COLOURS.disc
  ctx.beginPath()
  ctx.arc(cx, cy, outer - ring, 0, Math.PI * 2)
  ctx.fill()
  const glyph = glyphOf(icon) ?? GLYPHS['map-pin']
  if (glyph) drawGlyph(ctx, glyph, cx, cy, POI_GLYPH.size)
  return { data: ctx.getImageData(0, 0, side, side), pixelRatio: density }
}

/**
 * For MapLibre's `styleimagemissing`: draws and adds a `poi:<icon>` image. True when the id is a
 * place disc (whether or not it had to be drawn), false for any other image.
 */
export function addPoiImage(map: GLMap, id: string): boolean {
  if (!id.startsWith(POI_IMAGE_PREFIX)) return false
  if (!map.hasImage(id)) {
    const image = poiImage(id.slice(POI_IMAGE_PREFIX.length), map.getPixelRatio())
    if (image) map.addImage(id, image.data, { pixelRatio: image.pixelRatio })
  }
  return true
}

const attr = (value: string) => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
const PIN = '<svg class="selection-pin" viewBox="0 0 40 50" aria-hidden="true"><path d="M20 2C9 2 2 10 2 20c0 10 7 16 12 18l6 10 6-10c5-2 12-8 12-18C38 10 31 2 20 2Z" fill="#087fe9" stroke="white" stroke-width="3"/>'

/** The blue destination pin, with the place's white pictogram in its head (none for a bare map point). */
export function poiPinSvg(icon: string | null | undefined): string {
  const glyph = icon === 'map-pin' ? undefined : glyphOf(icon)
  if (!glyph) return PIN + '</svg>'
  const shapes = glyph.s.map(d => `<path d="${attr(d)}"/>`).join('')
    + (glyph.f ?? []).map(d => `<path d="${attr(d)}" fill="#fff"/>`).join('')
  // An 18-unit pictogram centred on the pin head at (20, 20).
  return `${PIN}<g transform="translate(11 11) scale(.75)" fill="none" stroke="#fff" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round">${shapes}</g></svg>`
}

export type PoiPlacement = {
  /** Re-reads which discs MapLibre drew, at most every 200 ms unless forced. True when the set changed. */
  refresh(force?: boolean): boolean
  /** Whether the place with this id has a disc on screen. */
  has(id: string | undefined): boolean
  /** The data changed: the next refresh reads again whatever the time. */
  stale(): void
}

/**
 * Which places MapLibre actually drew a disc for — it drops discs that would collide, and the
 * zoom filter drops minor ones — so the text overlay names exactly those places.
 */
export function poiPlacement(map: GLMap, layer = 'points'): PoiPlacement {
  let placed = new Set<string>(), at = -Infinity
  return {
    refresh(force = false) {
      const now = performance.now()
      if (!force && now - at < 200) return false
      at = now
      const next = new Set<string>()
      try {
        if (map.getLayer(layer)) {
          for (const feature of map.queryRenderedFeatures({ layers: [layer] })) {
            const id = feature.properties?.id
            if (id !== undefined && id !== null) next.add(String(id))
          }
        }
      } catch {
        return false // the style is being replaced; keep what was there
      }
      let changed = next.size !== placed.size
      if (!changed) for (const id of next) if (!placed.has(id)) { changed = true; break }
      placed = next
      return changed
    },
    has: id => id !== undefined && placed.has(id),
    stale() { at = -Infinity },
  }
}

/**
 * Screen boxes [minX, minY, maxX, maxY] of the drawn discs among `points` (owner = place id), so
 * names, road labels and house numbers keep off them. Discs outside the view (`size`, CSS pixels;
 * the canvas's own size when left out) are skipped.
 */
export function poiIconBoxes(map: GLMap, points: readonly { lon: number; lat: number; owner?: string }[], placement: PoiPlacement, zoom: number, size?: { width: number; height: number }): number[][] {
  const boxes: number[][] = []
  const r = poiRadius(zoom), canvas = size ? null : map.getCanvas()
  const width = size?.width ?? canvas?.clientWidth ?? 0, height = size?.height ?? canvas?.clientHeight ?? 0
  for (const point of points) {
    if (!placement.has(point.owner)) continue
    const at = map.project([point.lon, point.lat])
    if (!(at.x > -r && at.y > -r && at.x < width + r && at.y < height + r)) continue
    boxes.push([at.x - r, at.y - r, at.x + r, at.y + r])
  }
  return boxes
}
