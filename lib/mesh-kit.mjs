// Mesh helpers shared by the map's hand-built 3D layers (lib/atlas-gl.ts) and the pure geometry
// modules (lib/facades.mjs, lib/greenery.mjs). Plain JavaScript, so node checks can import it.
//
// Triangles are pushed onto a plain number array as x, y, z in local metres (east, north, up)
// followed by premultiplied r, g, b, a: seven floats a vertex, the format the solid program draws.

/** A vector scaled to length 1 (a zero vector stays pointing up the x axis rather than NaN). */
export const unit = ([x, y, z]) => { const length = Math.hypot(x, y, z) || 1; return [x / length, y / length, z / length] }

/** Where the hand-built meshes take their light from: high in the south-west, as the extrusions do. */
export const SUN = unit([-0.35, -0.5, 0.8])

/** Three greens for tree crowns, picked per tree so a row of them does not read as one blob. */
export const LEAVES = [[0.42, 0.66, 0.3], [0.5, 0.7, 0.28], [0.36, 0.6, 0.32]]

/** One flat face shaded by the sun, turned to look away from `inside`. */
export function facet(points, inside, colour, out) {
  const [p, q, r] = points
  const u = [q[0] - p[0], q[1] - p[1], q[2] - p[2]], v = [r[0] - p[0], r[1] - p[1], r[2] - p[2]]
  let normal = unit([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]])
  if (normal[0] * (p[0] - inside[0]) + normal[1] * (p[1] - inside[1]) + normal[2] * (p[2] - inside[2]) < 0) normal = [-normal[0], -normal[1], -normal[2]]
  const shade = 0.5 + 0.55 * Math.max(0, normal[0] * SUN[0] + normal[1] * SUN[1] + normal[2] * SUN[2])
  const lit = colour.map(channel => Math.min(1, channel * shade))
  for (let i = 1; i + 1 < points.length; i++) for (const point of [points[0], points[i], points[i + 1]]) out.push(...point, lit[0], lit[1], lit[2], 1)
}

/** A box `halfX` wide and `halfY` deep either side of (x, y), from `bottom` to `top`, turned
    `angle` radians clockwise from north: its local y is the way it faces. */
export function block(x, y, halfX, halfY, bottom, top, angle, colour, out) {
  const cos = Math.cos(angle), sin = Math.sin(angle)
  const corner = (dx, dy) => [x + dx * cos + dy * sin, y - dx * sin + dy * cos, bottom]
  const low = [corner(-halfX, -halfY), corner(halfX, -halfY), corner(halfX, halfY), corner(-halfX, halfY)]
  const high = low.map(([cx, cy]) => [cx, cy, top])
  const inside = [x, y, (bottom + top) / 2]
  for (let i = 0; i < 4; i++) facet([low[i], low[(i + 1) % 4], high[(i + 1) % 4], high[i]], inside, colour, out)
  facet(high, inside, colour, out)
}

/** A faceted ellipsoid, the crown of a tree. */
export function blob(x, y, z, radius, tall, colour, out) {
  const rings = 5, segments = 8, centre = [x, y, z]
  const at = (ring, segment) => {
    const polar = ring / rings * Math.PI, azimuth = (segment + (ring % 2) / 2) / segments * Math.PI * 2
    return [x + Math.sin(polar) * Math.cos(azimuth) * radius, y + Math.sin(polar) * Math.sin(azimuth) * radius, z + Math.cos(polar) * tall]
  }
  for (let ring = 0; ring < rings; ring++) for (let segment = 0; segment < segments; segment++) {
    const a = at(ring, segment), b = at(ring, segment + 1), c = at(ring + 1, segment + 1), d = at(ring + 1, segment)
    facet([a, b, c], centre, colour, out)
    facet([a, c, d], centre, colour, out)
  }
}

/** The smallest rectangle around a ring of local metres, and how much of it the ring fills. */
export function rectangleAround(ring) {
  const last = ring.length - 1
  const points = last > 0 && ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1] ? ring.slice(0, last) : ring
  if (points.length < 3) return null
  // Convex hull by monotone chain: the tightest rectangle has a side along one of its edges.
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1])
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const chain = list => {
    const kept = []
    for (const point of list) {
      while (kept.length >= 2 && turn(kept[kept.length - 2], kept[kept.length - 1], point) <= 0) kept.pop()
      kept.push(point)
    }
    return kept.slice(0, -1)
  }
  const hull = [...chain(sorted), ...chain([...sorted].reverse())]
  if (hull.length < 3) return null
  let best = null, bestArea = Infinity
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length], length = Math.hypot(bx - ax, by - ay)
    if (!length) continue
    const ux = (bx - ax) / length, uy = (by - ay) / length
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity
    for (const [x, y] of hull) {
      const u = x * ux + y * uy, v = y * ux - x * uy
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v)
    }
    const area = (maxU - minU) * (maxV - minV)
    if (area >= bestArea) continue
    bestArea = area
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2, hu = (maxU - minU) / 2, hv = (maxV - minV) / 2
    const centre = [cu * ux - cv * uy, cu * uy + cv * ux]
    // The long side leads, so a ridge runs along the building rather than across it.
    best = hu >= hv ? { centre, along: [ux, uy], half: [hu, hv], fill: 0 } : { centre, along: [-uy, ux], half: [hv, hu], fill: 0 }
  }
  if (!best || !(bestArea > 0)) return null
  let area = 0
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1])
  return { ...best, fill: Math.abs(area / 2) / bestArea }
}
