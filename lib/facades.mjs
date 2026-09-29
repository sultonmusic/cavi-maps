// Procedural facades for the extruded houses, in the spirit of 2GIS's 3D city: a window grid per
// 3 m floor, shop fronts and entrance doors with canopies on the ground floor, grey roofs behind a
// white parapet, stair housings and air-conditioning boxes on flat roofs, and a soft contact
// shadow around each house. Pure geometry with no DOM or GL, so node checks can run it.
//
// Two outputs:
//   decals  textured quads laid just outside the extruded walls and on the roofs: x, y, z in local
//           metres (east, north, up), then u, v (texture repeats) and a light factor; six floats a
//           vertex, grouped by texture in TEXTURE order (`ranges` tells where each starts)
//   solids  parapets, rooftop boxes and canopies in the solid program's format: x, y, z and
//           premultiplied r, g, b, a; seven floats a vertex
//
// Walls, roofs and solids are lit exactly as MapLibre lights the extrusions under LIGHT (see
// lightShade), so a window frame is as bright as the wall around it from every side.
import { rectangleAround } from './mesh-kit.mjs'

export const FLOOR = 3
/** Decal textures, in the order they are drawn: shadows first, doors last over the walls. */
export const TEXTURE = Object.freeze({ shadow: 0, roof: 1, house: 2, block: 3, office: 4, hall: 5, shop: 6, door: 7 })
export const TEXTURE_NAMES = Object.freeze(Object.keys(TEXTURE))
export const STYLES = Object.freeze(['house', 'block', 'office', 'hall', 'shop'])
/** Metres of wall per window bay. */
export const BAY = Object.freeze({ house: 4.0, block: 3.3, office: 2.4, hall: 6.0, shop: 3.3 })
/** Wall tones: warm whites and light greys, with sand and a pale terracotta for variety. */
export const HOUSE_TONES = Object.freeze(['#efebe4', '#e7e2da', '#f3f1ec', '#e2dcd2', '#ece5d8', '#dfe0df', '#e9dcc3', '#e6d6cc'])
export const WALL_OFFSET = 0.06, DOOR_OFFSET = 0.10, TRIM = 0.25
/** Metres of roof per repeat of the roof texture. */
export const ROOF_METRES = 6
/** A metre at 39° N, the middle of the country, as a Web Mercator length (0..1 across the world,
    MapLibre's Earth). Patterns laid out in these units stay fixed to the world. */
export const WORLD_METRE = 1 / (2 * Math.PI * 6371008.8 * Math.cos(39 * Math.PI / 180))

/** buildFacades' `roofOffset` and `roofSize` for a mesh around the Web Mercator point (x, y) with
    `scale` mercator units to the local metre: the roof pattern then repeats every ROOF_METRES
    world metres of Web Mercator, so a rebuild around another origin shows it in the same place. */
export function worldRoof(x, y, scale) {
  const repeat = ROOF_METRES * WORLD_METRE, size = repeat / scale
  const fraction = value => value - Math.floor(value)
  return { roofSize: size, roofOffset: [fraction(x / repeat) * size, fraction(-y / repeat) * size] }
}
export const MAX_DECAL_VERTICES = 180_000, MAX_SOLID_VERTICES = 150_000
/** The map's light, shared with the extrusions (lib/detail-layer.ts turns it into the style's
    `light`): radial 1.3, from azimuth 215° (south-west), 40° from straight up, intensity 0.25. */
export const LIGHT = Object.freeze({ radial: 1.3, azimuth: 215, polar: 40, intensity: 0.25 })

const COPING = [0.96, 0.95, 0.93], STAIR_ROOF = [0.78, 0.77, 0.75], AC_GREY = [0.83, 0.85, 0.87], CANOPY = [0.55, 0.58, 0.61]

// MapLibre's sphericalToCartesian: x east, y south (tile space), z up.
const AZIMUTH = (LIGHT.azimuth + 90) * Math.PI / 180, POLAR = LIGHT.polar * Math.PI / 180
const LX = LIGHT.radial * Math.cos(AZIMUTH) * Math.sin(POLAR), LY = LIGHT.radial * Math.sin(AZIMUTH) * Math.sin(POLAR), LZ = LIGHT.radial * Math.cos(POLAR)

/** How bright a face with outward normal (nx, ny, nz) in local metres (y north) comes out under
    LIGHT, as the fill-extrusion shader computes it for a light colour: MapLibre lights a wall by
    its normal in tile space (y south) pointing into the house, which for an outward (nx, ny) is
    (-nx, ny). The sun-lit side is the south-west one, as on the hand-built meshes. */
export function lightShade(nx, ny, nz = 0) {
  const d = Math.min(1, Math.max(0, -nx * LX + ny * LY + nz * LZ))
  return 1 - LIGHT.intensity + LIGHT.intensity * d
}
export const wallShade = (nx, ny) => lightShade(nx, ny, 0)
export const ROOF_SHADE = lightShade(0, 0, 1)

/** Whole floors under a wall of `h` metres: the inverse of floors × 3 + 1 m of plinth and parapet. */
export const storeys = h => (h < 2.5 ? 0 : Math.max(1, Math.floor((h - 1) / FLOOR)))

/** FNV-1a over the id, then a final mix so the low bits spread too. */
export function houseHash(id) {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) { h ^= id.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  h ^= h >>> 16; h = Math.imul(h, 0x45d9f3b); h ^= h >>> 16
  return h >>> 0
}
/** A house's tone, 0..7, from its id: the same on the extrusion and on its facade. */
export const houseTone = id => houseHash(String(id)) % HOUSE_TONES.length
/** A country house's tone from its `outline` hash (lib/country-houses.mjs), which is equal for
    duplicate outlines, so two copies of one house never flicker in two colours. */
export const outlineTone = outline => (outline >>> 0) % HOUSE_TONES.length
/** Metres a country house's walls rise per tone step. The house files hold overlapping outlines
    of one building from two sources; at one height their roofs would fight in the depth buffer,
    which shows as stripes once neighbours differ in colour. Lifted by tone, the copies' roofs
    stand 4 to 28 cm apart, and copies of one outline share a tone and stay coincident. */
export const TONE_LIFT = 0.04
export const liftedHeight = (height, tone) => height + TONE_LIFT * tone

const hexColour = hex => [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16) / 255)
const TONE_COLOURS = HOUSE_TONES.map(hexColour)
export const toneColour = tone => TONE_COLOURS[((tone % 8) + 8) % 8].slice()

/** The facade style of a house that came without one (`_rect`, its tightest rectangle, is kept
    in the signature for rules that need the shape). */
export function classify(house, area, _rect) {
  const h = house.height, floors = storeys(h)
  if (floors >= 10 || h >= 31) return 'office'
  if (area >= 2500 && floors <= 3) return 'hall'
  if (floors <= 2 && area < 220) return 'house'
  return 'block'
}

const signedArea = pts => {
  let twice = 0
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) twice += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1]
  return twice / 2
}

/** A ring's corners without the closing one or corners closer than 5 cm to the last kept. */
function cleanRing(ring) {
  const pts = []
  for (const p of ring) {
    const last = pts[pts.length - 1]
    if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.05) pts.push([p[0], p[1]])
  }
  while (pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 0.05) pts.pop()
  return pts
}

/** A polygon (local metres, open, any winding) moved `d` metres inwards: every edge shifts in and
    neighbouring edges meet again. Null when that folds it over, shrinks it below 0.4 of its area
    or throws a corner more than 4 d away. */
export function insetPolygon(pts, d) {
  const n = pts.length
  if (n < 3) return null
  const area = signedArea(pts), turn = area > 0 ? 1 : -1
  const edges = pts.map((point, i) => {
    const next = pts[(i + 1) % n], dx = next[0] - point[0], dy = next[1] - point[1], length = Math.hypot(dx, dy) || 1
    return { x: point[0] - dy / length * d * turn, y: point[1] + dx / length * d * turn, dx, dy }
  })
  const inner = edges.map((edge, i) => {
    const before = edges[(i - 1 + n) % n], cross = before.dx * edge.dy - before.dy * edge.dx
    if (Math.abs(cross) < 1e-9) return [edge.x, edge.y]
    const s = ((edge.x - before.x) * edge.dy - (edge.y - before.y) * edge.dx) / cross
    return [before.x + s * before.dx, before.y + s * before.dy]
  })
  const after = signedArea(inner)
  if (Math.sign(after) !== Math.sign(area) || Math.abs(after) < 0.4 * Math.abs(area)) return null
  for (let i = 0; i < n; i++) if (Math.hypot(inner[i][0] - pts[i][0], inner[i][1] - pts[i][1]) > 4 * Math.abs(d)) return null
  return inner
}

/** Ear clipping for a simple polygon of up to 96 corners: triangle corner indices, or null. */
export function triangulate(pts) {
  const n = pts.length
  if (n < 3 || n > 96) return null
  const area = signedArea(pts)
  if (!area) return null
  const left = Array.from({ length: n }, (_, i) => (area > 0 ? i : n - 1 - i))
  const cross = (a, b, c) => (pts[b][0] - pts[a][0]) * (pts[c][1] - pts[a][1]) - (pts[b][1] - pts[a][1]) * (pts[c][0] - pts[a][0])
  const out = []
  // Most footprints are convex: a fan from the first corner does.
  let convex = true
  for (let i = 0; i < n && convex; i++) if (cross(left[i], left[(i + 1) % n], left[(i + 2) % n]) < 0) convex = false
  if (convex) {
    for (let i = 1; i + 1 < n; i++) if (Math.abs(cross(left[0], left[i], left[i + 1])) > 1e-9) out.push(left[0], left[i], left[i + 1])
    return out
  }
  while (left.length > 3) {
    let clipped = false
    for (let i = 0; i < left.length && !clipped; i++) {
      const a = left[(i + left.length - 1) % left.length], b = left[i], c = left[(i + 1) % left.length]
      if (cross(a, b, c) <= 1e-9) continue
      let blocked = false
      for (const p of left) {
        if (p === a || p === b || p === c) continue
        if (cross(a, b, p) >= 0 && cross(b, c, p) >= 0 && cross(c, a, p) >= 0) { blocked = true; break }
      }
      if (blocked) continue
      out.push(a, b, c)
      left.splice(i, 1)
      clipped = true
    }
    if (clipped) continue
    // Only flat or folded corners are left: drop a flat one, or give up on a folded outline.
    const flat = left.findIndex((b, i) => Math.abs(cross(left[(i + left.length - 1) % left.length], b, left[(i + 1) % left.length])) <= 1e-9)
    if (flat < 0) return null
    left.splice(flat, 1)
  }
  if (Math.abs(cross(left[0], left[1], left[2])) > 1e-9) out.push(left[0], left[1], left[2])
  return out
}

function inside(pts, x, y) {
  let hit = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function edgeDistance(pts, x, y) {
  let best = Infinity
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i], dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy
    const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0
    best = Math.min(best, Math.hypot(ax + t * dx - x, ay + t * dy - y))
  }
  return best
}

/** Flags `storefront` on the house each place point stands in, or failing that on the nearest
    house within `reach` metres. Points are [x, y] in the houses' local metres. The points go into
    a grid (there are far fewer of them than houses), and each house looks up the cells its box
    touches. */
export function markStorefronts(houses, points, reach = 8) {
  if (!points.length || !houses.length) return 0
  const CELL = 20, grid = new Map()
  points.forEach(([x, y], index) => {
    const key = Math.floor(x / CELL) * 100003 + Math.floor(y / CELL), list = grid.get(key)
    if (list) list.push(index)
    else grid.set(key, [index])
  })
  // Per point: the house it is inside (gap -1) or the nearest within reach.
  const best = new Int32Array(points.length).fill(-1), gaps = new Float64Array(points.length).fill(Infinity)
  houses.forEach((house, index) => {
    const pts = house.ring ?? []
    if (pts.length < 3) return
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of pts) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y }
    for (let gx = Math.floor((minX - reach) / CELL); gx <= Math.floor((maxX + reach) / CELL); gx++) {
      for (let gy = Math.floor((minY - reach) / CELL); gy <= Math.floor((maxY + reach) / CELL); gy++) {
        for (const point of grid.get(gx * 100003 + gy) ?? []) {
          const [x, y] = points[point]
          if (gaps[point] < 0 || x < minX - reach || x > maxX + reach || y < minY - reach || y > maxY + reach) continue
          const gap = inside(pts, x, y) ? -1 : edgeDistance(pts, x, y)
          if (gap <= reach && gap < gaps[point]) { gaps[point] = gap; best[point] = index }
        }
      }
    }
  })
  let marked = 0
  for (const index of best) {
    if (index >= 0 && !houses[index].storefront) { houses[index].storefront = true; marked++ }
  }
  return marked
}

/** A small seeded generator, so a house's rooftop clutter is the same on every rebuild. */
function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const clampColour = (colour, factor) => [Math.min(1, colour[0] * factor), Math.min(1, colour[1] * factor), Math.min(1, colour[2] * factor)]

/** A growing Float32Array: rebuilding a neighbourhood writes a few hundred thousand floats, and
    plain arrays of numbers would spend most of that time collecting garbage. */
class Floats {
  constructor(size = 4096) { this.data = new Float32Array(size); this.length = 0 }
  room(count) {
    if (this.length + count <= this.data.length) return
    const next = new Float32Array(Math.max(this.data.length * 2, this.length + count))
    next.set(this.data.subarray(0, this.length))
    this.data = next
  }
  decal(x, y, z, u, v, shade) {
    this.room(6)
    const d = this.data, i = this.length
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = u; d[i + 4] = v; d[i + 5] = shade
    this.length = i + 6
  }
  solid(x, y, z, r, g, b) {
    this.room(7)
    const d = this.data, i = this.length
    d[i] = x; d[i + 1] = y; d[i + 2] = z; d[i + 3] = r; d[i + 4] = g; d[i + 5] = b; d[i + 6] = 1
    this.length = i + 7
  }
}
const arraySink = out => ({ solid(x, y, z, r, g, b) { out.push(x, y, z, r, g, b, 1) } })

/** Two triangles a, b, c and a, c, d of one colour (alpha 1, so premultiplied is the colour). */
function solidQuad(sink, a, b, c, d, colour) {
  const r = colour[0], g = colour[1], bl = colour[2]
  sink.solid(a[0], a[1], a[2], r, g, bl); sink.solid(b[0], b[1], b[2], r, g, bl); sink.solid(c[0], c[1], c[2], r, g, bl)
  sink.solid(a[0], a[1], a[2], r, g, bl); sink.solid(c[0], c[1], c[2], r, g, bl); sink.solid(d[0], d[1], d[2], r, g, bl)
}

/** A box like mesh-kit's `block` (halfX across, halfY along the way it faces, turned `angle`
    clockwise from north), four sides and a top, lit like the extrusions: 30 vertices of the
    solid format pushed onto `out`. */
export function litBox(x, y, halfX, halfY, bottom, top, angle, colour, out, topColour = colour) {
  const sink = out instanceof Floats ? out : arraySink(out)
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const at = (dx, dy, z) => [x + dx * cos + dy * sin, y - dx * sin + dy * cos, z]
  const corners = [[-halfX, -halfY], [halfX, -halfY], [halfX, halfY], [-halfX, halfY]]
  const normals = [[0, -1], [1, 0], [0, 1], [-1, 0]]
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i], [bx, by] = corners[(i + 1) % 4], [lx, ly] = normals[i]
    const shade = wallShade(lx * cos + ly * sin, -lx * sin + ly * cos)
    solidQuad(sink, at(ax, ay, bottom), at(bx, by, bottom), at(bx, by, top), at(ax, ay, top), clampColour(colour, shade))
  }
  solidQuad(sink, at(-halfX, -halfY, top), at(halfX, -halfY, top), at(halfX, halfY, top), at(-halfX, halfY, top), clampColour(topColour, ROOF_SHADE))
}

/** A vertical decal from (x0, y0) to (x1, y1), z0 to z1, with v0 at z0 and v1 at z1. */
function wallQuad(out, x0, y0, x1, y1, z0, z1, u0, u1, v0, v1, shade) {
  out.decal(x0, y0, z0, u0, v0, shade); out.decal(x1, y1, z0, u1, v0, shade); out.decal(x1, y1, z1, u1, v1, shade)
  out.decal(x0, y0, z0, u0, v0, shade); out.decal(x1, y1, z1, u1, v1, shade); out.decal(x0, y0, z1, u0, v1, shade)
}

/** Writes everything one house adds into the per-texture `decals` and the `solids`; false when
    the house adds nothing. */
function houseDetail(house, options, decals, solids) {
  const pts = cleanRing(house.ring ?? [])
  const height = house.height
  if (pts.length < 3 || !(height >= 2.5) || house.style === 'none') return false
  const signed = signedArea(pts), area = Math.abs(signed)
  if (area < 12) return false
  const n = pts.length, ccw = signed > 0, floors = storeys(height), gap = house.gap ?? 0
  const style = STYLES.includes(house.style) ? house.style : classify(house, area, null)
  const tone = /^#[0-9a-f]{6}$/i.test(house.colour ?? '') ? hexColour(house.colour) : toneColour(house.tone ?? houseTone(house.id))
  const flat = !house.roof
  const shopFront = !!house.storefront || style === 'office'
  const ground = shopFront ? 'shop' : style

  // Outward normals and lengths of the edges.
  const edges = pts.map((a, i) => {
    const b = pts[(i + 1) % n], dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy)
    return { a, b, dx: dx / length, dy: dy / length, length, nx: (ccw ? dy : -dy) / length, ny: (ccw ? -dx : dx) / length }
  })

  // Contact shadow: a band around the foot of the walls, its corners mitred so bands neither
  // gap nor overlap.
  const skirt = 1.0 + Math.min(3, 0.08 * height)
  const mitres = edges.map((edge, i) => {
    const before = edges[(i - 1 + n) % n], sx = before.nx + edge.nx, sy = before.ny + edge.ny
    const denominator = 1 + before.nx * edge.nx + before.ny * edge.ny
    if (denominator < 1e-6) return [edge.nx, edge.ny]
    let mx = sx / denominator, my = sy / denominator
    const length = Math.hypot(mx, my)
    if (length > 2.5) { mx *= 2.5 / length; my *= 2.5 / length }
    return [mx, my]
  })
  for (let i = 0; i < n; i++) {
    const { a, b } = edges[i], ma = mitres[i], mb = mitres[(i + 1) % n], z = 0.03
    const a2 = [a[0] + ma[0] * skirt, a[1] + ma[1] * skirt], b2 = [b[0] + mb[0] * skirt, b[1] + mb[1] * skirt]
    const shadow = decals[TEXTURE.shadow]
    shadow.decal(a[0], a[1], z, 0.5, 0, 1); shadow.decal(b[0], b[1], z, 0.5, 0, 1); shadow.decal(b2[0], b2[1], z, 0.5, 1, 1)
    shadow.decal(a[0], a[1], z, 0.5, 0, 1); shadow.decal(b2[0], b2[1], z, 0.5, 1, 1); shadow.decal(a2[0], a2[1], z, 0.5, 1, 1)
  }

  // Windows: a ground floor, then every floor above up to the last whole one; the top metre
  // of the wall stays plain.
  const groundTop = Math.min(FLOOR, height - 0.3)
  for (const edge of edges) {
    if (edge.length < 1.6) continue
    const trim = Math.min(TRIM, 0.1 * edge.length), usable = edge.length - 2 * trim, shade = wallShade(edge.nx, edge.ny)
    const ox = edge.nx * WALL_OFFSET, oy = edge.ny * WALL_OFFSET
    const x0 = edge.a[0] + edge.dx * trim + ox, y0 = edge.a[1] + edge.dy * trim + oy
    const x1 = edge.b[0] - edge.dx * trim + ox, y1 = edge.b[1] - edge.dy * trim + oy
    const groundBays = Math.max(1, Math.round(usable / BAY[ground]))
    wallQuad(decals[TEXTURE[ground]], x0, y0, x1, y1, 0, groundTop, 0, groundBays, 1, 1 - groundTop / FLOOR, shade)
    if (floors >= 2) {
      const bays = Math.max(1, Math.round(usable / BAY[style]))
      wallQuad(decals[TEXTURE[style]], x0, y0, x1, y1, FLOOR, floors * FLOOR, 0, bays, floors - 1, 0, shade)
    }
  }

  // Entrances on the longest wall, each in the middle of a ground-floor bay, under a canopy.
  if ((style !== 'house' && floors >= 2) || house.storefront) {
    const longest = edges.reduce((best, edge) => (edge.length > best.length ? edge : best))
    if (longest.length >= 3) {
      const trim = Math.min(TRIM, 0.1 * longest.length), usable = longest.length - 2 * trim
      const bays = Math.max(1, Math.round(usable / BAY[ground])), bay = usable / bays
      const count = style === 'block' ? Math.max(1, Math.round(longest.length / 26)) : 1
      const width = Math.min(1.6, Math.max(1.1, 0.7 * bay)), used = new Set()
      const shade = wallShade(longest.nx, longest.ny), angle = Math.atan2(longest.nx, longest.ny)
      for (let k = 0; k < count; k++) {
        const slot = Math.min(bays - 1, Math.max(0, Math.floor(usable * (k + 0.5) / count / bay)))
        if (used.has(slot) || width > longest.length - 0.4) continue
        used.add(slot)
        const along = trim + (slot + 0.5) * bay
        const cx = longest.a[0] + longest.dx * along, cy = longest.a[1] + longest.dy * along
        const ox = longest.nx * DOOR_OFFSET, oy = longest.ny * DOOR_OFFSET, hw = width / 2
        wallQuad(decals[TEXTURE.door], cx - longest.dx * hw + ox, cy - longest.dy * hw + oy, cx + longest.dx * hw + ox, cy + longest.dy * hw + oy,
          0, 2.4, 0, 1, 1, 0, shade)
        litBox(cx + longest.nx * 0.55, cy + longest.ny * 0.55, hw + 0.3, 0.55, 2.45, 2.6, angle, CANOPY, solids)
      }
    }
  }

  // Parapet: a white coping along the roof's edge, on flat roofs of blocks two floors and up.
  let roofRing = pts
  const near = gap <= options.solidRadius
  if (flat && height >= 7 && style !== 'house' && near && n <= 64) {
    const inner = insetPolygon(pts, 0.3)
    if (inner) {
      roofRing = inner
      const top = height + (floors >= 6 ? 0.9 : 0.6), innerTone = clampColour(tone, 0.9)
      for (let i = 0; i < n; i++) {
        const { a, b, nx, ny } = edges[i], c = inner[(i + 1) % n], d = inner[i]
        solidQuad(solids, [a[0], a[1], height], [b[0], b[1], height], [b[0], b[1], top], [a[0], a[1], top], clampColour(COPING, wallShade(nx, ny)))
        solidQuad(solids, [a[0], a[1], top], [b[0], b[1], top], [c[0], c[1], top], [d[0], d[1], top], clampColour(COPING, ROOF_SHADE))
        solidQuad(solids, [d[0], d[1], height], [c[0], c[1], height], [c[0], c[1], top], [d[0], d[1], top], clampColour(innerTone, wallShade(-nx, -ny)))
      }
    }
  }

  // Roof: a grey membrane, its pattern tied to the world so it holds still across rebuilds.
  // Each roof's u and v start near 0 (whole repeats taken off, which a repeating texture does not
  // see): hundreds of metres from the origin they would otherwise be large enough for a phone's
  // 16-bit fragment floats to blur the pattern.
  if (flat && !house.holes) {
    const triangles = triangulate(roofRing)
    if (triangles) {
      const [offsetX, offsetY] = options.roofOffset, size = options.roofSize, z = height + 0.02, roof = decals[TEXTURE.roof]
      const baseU = Math.floor((roofRing[0][0] + offsetX) / size), baseV = Math.floor((roofRing[0][1] + offsetY) / size)
      for (const index of triangles) {
        const [x, y] = roofRing[index]
        roof.decal(x, y, z, (x + offsetX) / size - baseU, (y + offsetY) / size - baseV, ROOF_SHADE)
      }
    }
  }

  // Rooftop boxes on flat roofs from three floors: stair housings along the middle, a machine
  // room on towers, and a scatter of air-conditioning units. Not on a house round a courtyard:
  // the middle of its outline is the open yard.
  const rect = flat && !house.holes && height >= 10 && area >= 150 && near ? rectangleAround(pts) : null
  if (rect && rect.fill >= 0.75) {
    const [a, b] = rect.half, [ex, ey] = rect.along, angle = Math.atan2(ex, ey), seed = houseHash(house.id)
    const at = (u, v) => [rect.centre[0] + ex * u + ey * v, rect.centre[1] + ey * u - ex * v]
    const fits = (u, v, hu, hv) => [[-1, -1], [1, -1], [1, 1], [-1, 1]].every(([su, sv]) => {
      const [x, y] = at(u + su * (hu + 0.4), v + sv * (hv + 0.4))
      return inside(roofRing, x, y)
    })
    const crown = floors >= 12 ? [0.55 * a, 0.55 * b] : null
    if (crown) litBox(rect.centre[0], rect.centre[1], crown[1], crown[0], height, height + 3.6, angle, clampColour(tone, 1.02), solids, STAIR_ROOF)
    const stairs = [], count = Math.min(6, Math.max(1, Math.round(2 * a / 24))), span = Math.max(0, a - 3)
    const halfAcross = Math.min(2.1, 0.4 * b)
    for (let k = 0; k < count; k++) {
      const u = count === 1 ? 0 : -span + 2 * span * (k + 0.5) / count
      if (crown && Math.abs(u) < crown[0]) continue
      if (!fits(u, 0, 1.6, halfAcross)) continue
      const [x, y] = at(u, 0)
      litBox(x, y, halfAcross, 1.6, height, height + 2.7, angle, clampColour(tone, 1.02), solids, STAIR_ROOF)
      stairs.push(u)
    }
    if (b >= 3) {
      const random = mulberry32(seed), units = 2 + ((seed >>> 3) % 4)
      for (let k = 0; k < units; k++) {
        const u = (random() * 2 - 1) * (a - 1.5), v = (random() * 2 - 1) * (b - 1.5)
        if (stairs.some(s => Math.abs(u - s) < 1.6 + 2.2 && Math.abs(v) < halfAcross + 2.2)) continue
        if (crown && Math.abs(u) < crown[0] + 1 && Math.abs(v) < crown[1] + 1) continue
        if (!fits(u, v, 0.4, 0.5)) continue
        const [x, y] = at(u, v)
        litBox(x, y, 0.5, 0.4, height, height + 0.85, angle, AC_GREY, solids)
      }
    }
  }
  return true
}

/** Facades for many houses (rings in local metres), nearest first within the vertex budgets;
    the houses past a budget are counted in `skipped`. A roof point (x, y) takes the roof
    pattern at ((x + roofOffset[0]) / roofSize, (y + roofOffset[1]) / roofSize) repeats. */
export function buildFacades(houses, options = {}) {
  const settings = {
    solidRadius: options.solidRadius ?? 320, roofOffset: options.roofOffset ?? [0, 0], roofSize: options.roofSize ?? ROOF_METRES,
    maxDecals: options.maxDecals ?? MAX_DECAL_VERTICES, maxSolids: options.maxSolids ?? MAX_SOLID_VERTICES,
  }
  const order = [...houses].sort((a, b) => (a.gap ?? 0) - (b.gap ?? 0))
  // The house files hold some footprints twice (the same outline from two sources). Their
  // extrusions coincide, but doubled decals would darken the shadows and windows: dress only the
  // tallest copy of each outline.
  const outline = house => (house.ring ?? []).map(p => `${Math.round(p[0] * 10)},${Math.round(p[1] * 10)}`).join(';')
  const keys = order.map(outline), tallest = new Map()
  order.forEach((house, i) => {
    const kept = tallest.get(keys[i])
    if (!kept || house.height > kept.height) tallest.set(keys[i], house)
  })
  const buckets = TEXTURE_NAMES.map(() => new Floats()), solids = new Floats(16384)
  let decalFloats = 0, built = 0, skipped = 0
  for (let i = 0; i < order.length; i++) {
    if (tallest.get(keys[i]) !== order[i]) continue
    const before = buckets.map(bucket => bucket.length), solidsBefore = solids.length
    if (!houseDetail(order[i], settings, buckets, solids)) continue
    const added = buckets.reduce((sum, bucket, texture) => sum + bucket.length - before[texture], 0)
    if ((decalFloats + added) / 6 > settings.maxDecals || solids.length / 7 > settings.maxSolids) {
      buckets.forEach((bucket, texture) => { bucket.length = before[texture] })
      solids.length = solidsBefore
      skipped = order.length - i
      break
    }
    decalFloats += added
    built++
  }
  const decals = new Float32Array(decalFloats), ranges = []
  let first = 0
  buckets.forEach((bucket, texture) => {
    decals.set(bucket.data.subarray(0, bucket.length), first * 6)
    if (bucket.length) ranges.push({ texture, first, count: bucket.length / 6 })
    first += bucket.length / 6
  })
  return { decals, ranges, solids: solids.data.slice(0, solids.length), houses: built, skipped }
}
