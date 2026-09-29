// Street and park trees where the data has none. OpenStreetMap maps hardly any single trees in
// Tajik towns (none at all in central Khujand), yet their streets are lined with plane trees and
// their parks are full of them. These are decorative guesses, not data: rows along the wider
// asphalt streets and a loose grid in parks, kept off houses, carriageways, junctions and the
// trees that are mapped. lib/detail-layer.ts plants them only when STREET_TREES is on.
//
// Everything is in local metres (x east, y north) around the detail layer's origin.
import { carriagewayMetres } from './lanes.mjs'
import { LEAVES, rectangleAround } from './mesh-kit.mjs'
import { WORLD_METRE, houseHash, lightShade } from './facades.mjs'

export const STREET_TREES = true
/** Vertices of one low tree. */
export const TREE_VERTICES = 60
/** The narrowest carriageway, in metres, that gets a row of trees: one lane each way and up. */
export const TREE_STREET_METRES = 6.5
const BARK = [0.45, 0.33, 0.22]

/** A value in 0..1 from a string and a number, the same on every rebuild. */
const noise = (id, k) => houseHash(`${id}#${k}`) / 4294967296

function insideRing(pts, x, y) {
  let hit = false
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j]
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit
  }
  return hit
}

function segmentGap(ax, ay, bx, by, x, y) {
  const dx = bx - ax, dy = by - ay, length = dx * dx + dy * dy
  const t = length ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / length)) : 0
  return Math.hypot(ax + t * dx - x, ay + t * dy - y)
}

/** A spatial hash of 16 m cells: each item is stored in every cell its box (grown by `pad`) touches. */
function cellGrid(pad) {
  const CELL = 16, cells = new Map()
  return {
    add(item, minX, minY, maxX, maxY) {
      for (let gx = Math.floor((minX - pad) / CELL); gx <= Math.floor((maxX + pad) / CELL); gx++) {
        for (let gy = Math.floor((minY - pad) / CELL); gy <= Math.floor((maxY + pad) / CELL); gy++) {
          const key = gx * 100003 + gy, list = cells.get(key)
          if (list) list.push(item)
          else cells.set(key, [item])
        }
      }
    },
    near(x, y) { return cells.get(Math.floor(x / CELL) * 100003 + Math.floor(y / CELL)) ?? [] },
  }
}

/** Whether a tree may stand at (x, y): not in or within 2 m of a house, not on a carriageway or
    within 1.2 m of its edge, not within 14 m of a junction, not within 5 m of a mapped tree, and
    not in water (a street's row would otherwise march across a river along its bridge).
    `houses` are rings, `roads` are {line, asphalt, oneway}, `trees` are [x, y] and `water` rings. */
export function openGround(houses, roads, trees, water = []) {
  const houseGrid = cellGrid(2), roadGrid = cellGrid(12), junctionGrid = cellGrid(14), treeGrid = cellGrid(5)
  for (const ring of houses) {
    if (ring.length < 3) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of ring) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    houseGrid.add(ring, minX, minY, maxX, maxY)
  }
  const ends = new Map()
  for (const road of roads) {
    const half = carriagewayMetres(road.asphalt, !!road.oneway) / 2
    for (let i = 1; i < road.line.length; i++) {
      const [ax, ay] = road.line[i - 1], [bx, by] = road.line[i]
      roadGrid.add({ ax, ay, bx, by, reach: half + 1.2 }, Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))
    }
    for (const [x, y] of new Map(road.line.map(point => [`${point[0].toFixed(1)},${point[1].toFixed(1)}`, point])).values()) {
      const key = `${x.toFixed(1)},${y.toFixed(1)}`, seen = ends.get(key)
      ends.set(key, seen ? { point: seen.point, roads: seen.roads + 1 } : { point: [x, y], roads: 1 })
    }
  }
  for (const { point, roads: count } of ends.values()) if (count >= 2) junctionGrid.add(point, point[0], point[1], point[0], point[1])
  for (const point of trees) treeGrid.add(point, point[0], point[1], point[0], point[1])
  // Water outlines can be kilometres across, too big for the grid: each keeps its own box.
  const pools = []
  for (const ring of water) {
    if (ring.length < 3) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of ring) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    pools.push({ ring, minX, minY, maxX, maxY })
  }
  return (x, y) => {
    for (const ring of houseGrid.near(x, y)) {
      if (insideRing(ring, x, y)) return false
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) if (segmentGap(ring[j][0], ring[j][1], ring[i][0], ring[i][1], x, y) < 2) return false
    }
    for (const segment of roadGrid.near(x, y)) if (segmentGap(segment.ax, segment.ay, segment.bx, segment.by, x, y) < segment.reach) return false
    for (const [jx, jy] of junctionGrid.near(x, y)) if (Math.hypot(jx - x, jy - y) < 14) return false
    for (const [tx, ty] of treeGrid.near(x, y)) if (Math.hypot(tx - x, ty - y) < 5) return false
    for (const pool of pools) if (x >= pool.minX && x <= pool.maxX && y >= pool.minY && y <= pool.maxY && insideRing(pool.ring, x, y)) return false
    return true
  }
}

function treeOf(x, y, id, k) {
  return { x, y, height: 7 + 3 * noise(id, k * 3 + 1), crown: 2.2 + 0.8 * noise(id, k * 3 + 2), leaf: Math.floor(noise(id, k * 3) * LEAVES.length) % LEAVES.length }
}

/** Rows of trees along both sides of the asphalt streets at least TREE_STREET_METRES wide, every
    `spacing` metres from 8 m after a street's start to 8 m before its end, nearest first. */
export function streetTrees(roads, isFree, { centre = [0, 0], radius = Infinity, spacing = 10, setback = 2.4, max = 700 } = {}) {
  const found = [], placed = cellGrid(4)
  for (const road of roads) {
    const width = carriagewayMetres(road.asphalt, !!road.oneway)
    if (width < TREE_STREET_METRES || road.line.length < 2) continue
    const offset = width / 2 + 0.3 + setback
    let length = 0
    for (let i = 1; i < road.line.length; i++) length += Math.hypot(road.line[i][0] - road.line[i - 1][0], road.line[i][1] - road.line[i - 1][1])
    let segment = 1, start = 0, k = 0
    for (let at = 8; at <= length - 8; at += spacing, k++) {
      const s = Math.min(length - 8, Math.max(8, at + (noise(road.id, k) * 2 - 1)))
      while (segment < road.line.length - 1) {
        const piece = Math.hypot(road.line[segment][0] - road.line[segment - 1][0], road.line[segment][1] - road.line[segment - 1][1])
        if (start + piece >= s) break
        start += piece
        segment++
      }
      const [ax, ay] = road.line[segment - 1], [bx, by] = road.line[segment], piece = Math.hypot(bx - ax, by - ay)
      if (!piece) continue
      const t = Math.min(1, (s - start) / piece), px = ax + (bx - ax) * t, py = ay + (by - ay) * t
      if (Math.hypot(px - centre[0], py - centre[1]) > radius + offset) continue
      const nx = -(by - ay) / piece, ny = (bx - ax) / piece
      for (const side of [-1, 1]) {
        const x = px + nx * offset * side, y = py + ny * offset * side
        if (Math.hypot(x - centre[0], y - centre[1]) > radius || !isFree(x, y)) continue
        if (placed.near(x, y).some(([ox, oy]) => Math.hypot(ox - x, oy - y) < 4)) continue
        placed.add([x, y], x, y, x, y)
        found.push(treeOf(x, y, road.id, k * 2 + (side > 0 ? 1 : 0)))
      }
    }
  }
  return nearestFirst(found, centre, max)
}

/** A loose grid of trees over park polygons (rings of local metres), `cell` metres apart. Grid
    column k stands at x = (k - offset[0]) × cell and row k at y = (k - offset[1]) × cell, so with
    `offset` the origin's place in a grid fixed to the world (in cells, whole part included) the
    trees and their jitter hold still as the layer rebuilds. Sports pitches, park polygons that
    are near-perfect small rectangles of a pitch's proportions, stay open. */
export function parkTrees(polygons, isFree, { centre = [0, 0], radius = Infinity, cell = 12, max = 500, offset = [0, 0] } = {}) {
  const found = [], seen = new Set()
  for (const ring of polygons) {
    if (ring.length < 3) continue
    let twice = 0
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1]
    const area = Math.abs(twice / 2), box = rectangleAround(ring)
    if (!box) continue
    const aspect = box.half[0] / Math.max(1e-6, box.half[1])
    if (box.fill >= 0.9 && area < 12_000 && aspect >= 1.3 && aspect <= 2.0) continue
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const [x, y] of ring) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y) }
    minX = Math.max(minX, centre[0] - radius); maxX = Math.min(maxX, centre[0] + radius)
    minY = Math.max(minY, centre[1] - radius); maxY = Math.min(maxY, centre[1] + radius)
    for (let gx = Math.floor(minX / cell + offset[0]); gx <= Math.ceil(maxX / cell + offset[0]); gx++) {
      for (let gy = Math.floor(minY / cell + offset[1]); gy <= Math.ceil(maxY / cell + offset[1]); gy++) {
        const id = `${gx}:${gy}`
        if (seen.has(id)) continue
        const x = (gx - offset[0]) * cell + (noise(id, 1) * 2 - 1) * 3, y = (gy - offset[1]) * cell + (noise(id, 2) * 2 - 1) * 3
        if (Math.hypot(x - centre[0], y - centre[1]) > radius || !insideRing(ring, x, y) || !isFree(x, y)) continue
        seen.add(id)
        found.push(treeOf(x, y, id, 0))
      }
    }
  }
  return nearestFirst(found, centre, max)
}

/** parkTrees' `cell` and `offset` for a mesh around the Web Mercator point (x, y) with `scale`
    mercator units to the local metre: a grid of `metres` world metres fixed in Web Mercator, so
    the park trees stand in the same places whichever origin a rebuild takes. */
export function worldGrid(x, y, scale, metres = 12) {
  const cell = metres * WORLD_METRE
  return { cell: cell / scale, offset: [x / cell, -y / cell] }
}

function nearestFirst(trees, centre, max) {
  return trees.map(tree => ({ tree, gap: Math.hypot(tree.x - centre[0], tree.y - centre[1]) }))
    .sort((a, b) => a.gap - b.gap).slice(0, max).map(({ tree }) => tree)
}

function lit(out, points, normal, colour) {
  const shade = lightShade(normal[0], normal[1], normal[2])
  const r = Math.min(1, colour[0] * shade), g = Math.min(1, colour[1] * shade), b = Math.min(1, colour[2] * shade)
  for (const p of points) out.push(p[0], p[1], p[2], r, g, b, 1)
}

/** A low-polygon tree in 60 vertices: a square trunk to 0.45 of its height and a six-sided
    double cone for a crown, widest at 0.62 of its height, from 0.38 up to the top. */
export function lowTreeTriangles(x, y, height, crown, leaf, out) {
  const w = 0.1, trunk = 0.45 * height
  const sides = [[[-w, -w], [w, -w], [0, -1]], [[w, -w], [w, w], [1, 0]], [[w, w], [-w, w], [0, 1]], [[-w, w], [-w, -w], [-1, 0]]]
  for (const [[ax, ay], [bx, by], [nx, ny]] of sides) {
    const a0 = [x + ax, y + ay, 0], b0 = [x + bx, y + by, 0], b1 = [x + bx, y + by, trunk], a1 = [x + ax, y + ay, trunk]
    lit(out, [a0, b0, b1, a0, b1, a1], [nx, ny, 0], BARK)
  }
  const colour = Array.isArray(leaf) ? leaf : LEAVES[leaf] ?? LEAVES[0]
  const ring = 0.62 * height, top = [x, y, height], bottom = [x, y, 0.38 * height]
  const rise = height - ring, drop = ring - 0.38 * height
  for (let i = 0; i < 6; i++) {
    const a = i / 6 * Math.PI * 2, b = (i + 1) / 6 * Math.PI * 2, mid = (a + b) / 2
    const p = [x + Math.cos(a) * crown, y + Math.sin(a) * crown, ring], q = [x + Math.cos(b) * crown, y + Math.sin(b) * crown, ring]
    const flat = crown * Math.cos(Math.PI / 6)
    const up = Math.hypot(flat, rise), down = Math.hypot(flat, drop)
    lit(out, [p, q, top], [Math.cos(mid) * rise / up, Math.sin(mid) * rise / up, flat / up], colour)
    lit(out, [q, p, bottom], [Math.cos(mid) * drop / down, Math.sin(mid) * drop / down, -flat / down], colour)
  }
}
