// Landmarks modelled by hand: buildings too important and too unusual for a footprint and a height,
// drawn as their own meshes. Each one also clears the country houses under it, answers taps and is a
// place in search. Pure JS, so scripts/check-landmarks.mjs can run it in node.
//
// Mesh format (the one solidProgram in atlas-gl draws): x, y, z in metres east, north and up from the
// landmark's centre, then premultiplied r, g, b, a. 7 floats a vertex, plain triangles.

/** MapLibre's own earth (MercatorCoordinate), so metres here are the map's metres. */
const EARTH = 2 * Math.PI * 6371008.8
export const mercX = lon => (180 + lon) / 360
export const mercY = lat => (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360
const lonOf = x => x * 360 - 180
const latOf = y => 360 / Math.PI * Math.atan(Math.exp((180 - y * 360) * Math.PI / 180)) - 90
/** The sun of every hand-built mesh (atlas-gl.ts:539), so the landmark is lit like the roofs and trees around it. */
const SUN = (() => { const v = [-0.35, -0.5, 0.8], l = Math.hypot(...v); return v.map(c => c / l) })()
/** A phone keeps this much of one landmark in a vertex buffer, and no more. */
export const MAX_LANDMARK_VERTICES = 110_000

/** A rounded rectangle sampled so that every ring with the same `counts` [long side, short side,
    corner] has point i at the same place along it: rings can then be joined quad by quad. Half-sizes
    a (x) and b (y), corner radius r; r = 0 gives a sharp rectangle whose corner points coincide.
    Anticlockwise from the south end of the east side. Points are [x, y, outward nx, outward ny]. */
export function roundedRing(a, b, r, [nL, nS, nC]) {
  const out = []
  r = Math.max(0, Math.min(r, a, b))
  const side = (x0, y0, x1, y1, n, nx, ny) => { for (let k = 0; k < n; k++) { const t = k / n; out.push([x0 + (x1 - x0) * t, y0 + (y1 - y0) * t, nx, ny]) } }
  const arc = (cx, cy, from, n) => { for (let k = 0; k < n; k++) { const t = from + k / n * Math.PI / 2; out.push([cx + Math.cos(t) * r, cy + Math.sin(t) * r, Math.cos(t), Math.sin(t)]) } }
  side(a, -(b - r), a, b - r, nL, 1, 0); arc(a - r, b - r, 0, nC)
  side(a - r, b, -(a - r), b, nS, 0, 1); arc(-(a - r), b - r, Math.PI / 2, nC)
  side(-a, b - r, -a, -(b - r), nL, -1, 0); arc(-(a - r), -(b - r), Math.PI, nC)
  side(-(a - r), -b, a - r, -b, nS, 0, -1); arc(a - r, -(b - r), Math.PI * 1.5, nC)
  return out
}

/** Whether model point (x, y) lies in the rounded rectangle a × b with corners of radius r. */
export function insideRounded(x, y, a, b, r) {
  const ax = Math.abs(x), ay = Math.abs(y)
  if (ax > a || ay > b) return false
  if (ax <= a - r || ay <= b - r) return true
  return Math.hypot(ax - (a - r), ay - (b - r)) <= r
}

/** Triangles in the model frame (x across, y along the long axis, z up), written out turned by
    `axis`, the bearing of the long axis in degrees clockwise from north. `vertices` is a first guess
    at the size, so a big mesh is not copied as it grows. */
export function meshWriter(axis, vertices = 3 * 4096) {
  let data = new Float32Array(7 * Math.max(3, Math.ceil(vertices))), used = 0
  const angle = axis * Math.PI / 180, cos = Math.cos(angle), sin = Math.sin(angle)
  const put = (x, y, z, r, g, b) => {
    if (used + 7 > data.length) { const grown = new Float32Array(data.length * 2); grown.set(data); data = grown }
    data[used++] = x * cos + y * sin; data[used++] = -x * sin + y * cos; data[used++] = z
    data[used++] = r; data[used++] = g; data[used++] = b; data[used++] = 1
  }
  /** One flat polygon, lit like facet() in atlas-gl: the normal is turned to agree with `hint`.
      An emissive face (LED, lamps, lit glass) keeps its colour whatever way it faces. */
  function face(p, colour, hint, emissive = false) {
    // Newell's normal stays sound when two corners of a quad coincide.
    let nx = 0, ny = 0, nz = 0
    for (let i = 0; i < p.length; i++) {
      const a = p[i], b = p[(i + 1) % p.length]
      nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1])
    }
    const l = Math.hypot(nx, ny, nz) || 1, flip = nx * hint[0] + ny * hint[1] + nz * hint[2] < 0 ? -1 / l : 1 / l
    nx *= flip; ny *= flip; nz *= flip
    const ex = nx * cos + ny * sin, ey = -nx * sin + ny * cos
    const shade = emissive ? 1 : 0.5 + 0.55 * Math.max(0, ex * SUN[0] + ey * SUN[1] + nz * SUN[2])
    const r = Math.min(1, colour[0] * shade), g = Math.min(1, colour[1] * shade), b = Math.min(1, colour[2] * shade)
    for (let i = 1; i + 1 < p.length; i++) { put(p[0][0], p[0][1], p[0][2], r, g, b); put(p[i][0], p[i][1], p[i][2], r, g, b); put(p[i + 1][0], p[i + 1][1], p[i + 1][2], r, g, b) }
  }
  /** Ring `inner` at height zi joined to ring `outer` at zo, a quad a segment. A height is a number or
      a function of the ring point's index, for edges that rise and fall along the ring. `paint(i)` gives
      [colour, emissive?] for segment i, or null to leave it out. `hint` is 'up' | 'down' | 'in' | 'out'. */
  // One quad and one hint, reused by every strip segment: face() keeps neither.
  const quad = [[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]], dir = [0, 0, 0]
  const corner = (k, point, z) => { const c = quad[k]; c[0] = point[0]; c[1] = point[1]; c[2] = z }
  function strip(inner, zi, outer, zo, paint, hint) {
    const n = inner.length, lo = typeof zi === 'function' ? zi : () => zi, hi = typeof zo === 'function' ? zo : () => zo
    const sign = hint === 'in' ? -1 : 1
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n, style = paint(i)
      if (!style) continue
      if (hint === 'up' || hint === 'down') { dir[0] = 0; dir[1] = 0; dir[2] = hint === 'up' ? 1 : -1 }
      else { dir[0] = sign * (inner[i][2] + inner[j][2]) / 2; dir[1] = sign * (inner[i][3] + inner[j][3]) / 2; dir[2] = 0 }
      corner(0, inner[i], lo(i)); corner(1, inner[j], lo(j)); corner(2, outer[j], hi(j)); corner(3, outer[i], hi(i))
      face(quad, style[0], dir, !!style[1])
    }
  }
  /** A box of half-sizes hx, hy about (x, y), turned `turn` radians anticlockwise. colours and
      emissive by face: 0 +x, 1 +y, 2 −x, 3 −y, 4 top (a missing colour repeats the first). `lid`
      false leaves the top out, for posts that end under a ceiling. */
  function box(x, y, hx, hy, bottom, top, colours, turn = 0, emissive = [], lid = true) {
    const c = Math.cos(turn), s = Math.sin(turn)
    const at = (dx, dy, z) => [x + dx * c - dy * s, y + dx * s + dy * c, z]
    const sides = [[[hx, -hy], [hx, hy]], [[hx, hy], [-hx, hy]], [[-hx, hy], [-hx, -hy]], [[-hx, -hy], [hx, -hy]]]
    const normals = [[c, s], [-s, c], [-c, -s], [s, -c]]
    sides.forEach(([[ax, ay], [bx, by]], k) => face([at(ax, ay, bottom), at(bx, by, bottom), at(bx, by, top), at(ax, ay, top)], colours[k] ?? colours[0], [...normals[k], 0], !!emissive[k]))
    if (lid) face([at(hx, -hy, top), at(hx, hy, top), at(-hx, hy, top), at(-hx, -hy, top)], colours[4] ?? colours[0], [0, 0, 1], !!emissive[4])
  }
  return { face, strip, box, done: () => data.slice(0, used) }
}

/* The National Stadium of Tajikistan, Dushanbe (opened 21.08.2026; 30 000 seats, 12 000 below and
   18 000 above; 33 m high; field 105 × 68 m inside a 130 × 87 m sports area; a promenade at 9 m; an
   aluminium media facade over a glazed ground floor). Outline: OpenStreetMap way 1076243310, a
   rounded rectangle 152.8 × 197.2 m in map metres. Sections below are drawn from the Yandex plan
   and the photos; row counts and the seat colours are a likeness, not a survey.

   Distances `d` are measured outward from the edge of the sports area (d 0) to the facade (d = D)
   and on over the apron; every ring has COUNTS points, so ring point i sits on the same side and at
   the same place along it whatever d is. Ring point order: the east side 0–29 (south to north), the
   north-east corner 30–34, the north side 35–54, then the west side 60–89 and the south side 95–114. */
export const STADIUM = {
  A: 76.4, B: 98.6, R: 23,          // outer facade: half-width, half-length, corner radius (m)
  D: 33, INNER_R: 6,                // depth of the stands from the sports area to the facade; radius at the pitch
  TOP: 33,                          // roof crown
  COUNTS: [30, 20, 5],              // ring sampling: 120 points a ring
  FIELD: [34, 52.5],                // half of 68 × 105
  BOARDS: { d: -2.5, top: 1.0 },    // LED advertising boards round the pitch, 2.5 m in front of the stands
  LOWER: { front: 2.0, start: 1.0, rows: 14, tread: 0.85, riser: 0.5, vomitory: [9, 13] },    // d 1.0–12.9 m, z 2.0–9.0 m
  PROMENADE: [12.9, 16.0], RAIL: 1.1,   // at the top of the lower tier (+9 m), behind a glass balustrade
  BOX_GLASS: [9.0, 12.4],           // glazed hospitality boxes behind the promenade
  FASCIA: { d: 15.2, bottom: 12.4, top: 14.0, ribbon: [12.8, 13.5] },
  UPPER: { start: 16.0, base: 14.0, rows: 16, tread: 0.9, riser: 0.62, vomitory: [0, 3] },   // d 16.0–30.4 m, z 14.0–23.9 m
  // Stairs: a 1.2 m aisle starts at these segments of every long and short side, and one wedge runs
  // down the middle of each corner. A vomitory opens three segments after each aisle.
  AISLE: { width: 1.2, long: [2, 7, 12, 17, 22, 27], short: [2, 7, 12, 17], vomitory: 3 },
  ROOF: { inner: 16.5, under: 29.4, edge: 31.2, lamps: [29.55, 30.05], clusters: 5, rim: 1.5 },
  // The louvred band starts `podium` m up along the sides and swoops down to `corner` m at the corners,
  // over the glazed ground floor at d `glass` with a transom and white columns at every other point.
  FACADE: { podium: 7.5, corner: 4.5, swoop: 32, glass: 31.0, transom: [3.4, 3.8], strips: 12, inset: 0.4, coping: 0.12 },
  TEXT: { word: 'TAJIKISTAN', rows: [3, 9], pixel: 1.75 },  // LED lettering on the long sides, louvres 3–9
  APRON: 10, VERGE: [6.5, 9],       // from the facade: paving to 6.5 m, a planted verge to 9 m, a kerb to 10 m
  ENTRANCES: 3,                     // segments either side of the middle of each side paved as an entrance plaza
  // Young trees in the verge on every other segment of the sides, but not at the entrance plazas, under
  // the west canopy, or on the south side where a street passes 17 m from the facade (ring points 101–108).
  TREES: { height: 7, crown: 2.2, skip: [[12, 17], [42, 47], [70, 80], [101, 108]] },
  FLAG_MOSAIC: true,                // the main (west) upper stand shows the flag in its seats
}
export const STADIUM_COLOURS = {
  grass: [0.33, 0.62, 0.27], grass2: [0.28, 0.55, 0.23], runoff: [0.25, 0.5, 0.22], line: [0.97, 0.97, 0.95],
  concrete: [0.74, 0.73, 0.71], stair: [0.8, 0.79, 0.77], seat: [0.78, 0.12, 0.14], seatCorner: [0.66, 0.1, 0.12],
  vomitory: [0.13, 0.13, 0.15], white: [0.95, 0.95, 0.94], green: [0.05, 0.5, 0.25], rail: [0.6, 0.7, 0.75],
  glass: [0.2, 0.27, 0.33], glass2: [0.26, 0.34, 0.41], door: [0.12, 0.15, 0.19], dark: [0.3, 0.32, 0.35],
  underside: [0.62, 0.64, 0.67], roof: [0.9, 0.91, 0.92], rib: [0.78, 0.8, 0.82], alu: [0.93, 0.94, 0.95],
  alu2: [0.8, 0.82, 0.85], soffit: [0.8, 0.8, 0.8], column: [0.9, 0.9, 0.9], paving: [0.86, 0.84, 0.8],
  paving2: [0.82, 0.8, 0.76], plaza: [0.92, 0.9, 0.86], verge: [0.46, 0.58, 0.32], kerb: [0.66, 0.66, 0.64],
  trunk: [0.42, 0.33, 0.24], leaf: [0.42, 0.66, 0.3], leaf2: [0.5, 0.7, 0.28], leaf3: [0.36, 0.6, 0.32],
  net: [0.9, 0.9, 0.9], screen: [0.08, 0.09, 0.11], screenOn: [0.25, 0.55, 0.95], orange: [0.96, 0.5, 0.14],
  deep: [0.93, 0.3, 0.07], amber: [1.0, 0.74, 0.24], lamp: [1.0, 0.97, 0.85], lampOff: [0.9, 0.91, 0.9], warm: [1.0, 0.86, 0.6],
  warm2: [0.95, 0.78, 0.5], text: [1.0, 0.97, 1.0], textNight: [1.0, 0.94, 0.8],
  board: [0.12, 0.38, 0.85], board2: [0.96, 0.96, 0.96], board3: [0.1, 0.62, 0.35], board4: [0.88, 0.16, 0.18],
}

/** 5 × 7 LED letters (3 wide for I), top row first. */
const LED_FONT = {
  A: ['.###.', '#...#', '#...#', '#####', '#...#', '#...#', '#...#'],
  I: ['###', '.#.', '.#.', '.#.', '.#.', '.#.', '###'],
  J: ['..###', '...#.', '...#.', '...#.', '...#.', '#..#.', '.##..'],
  K: ['#...#', '#..#.', '#.#..', '##...', '#.#..', '#..#.', '#...#'],
  N: ['#...#', '##..#', '#.#.#', '#.#.#', '#..##', '#...#', '#...#'],
  S: ['.####', '#....', '#....', '.###.', '....#', '....#', '####.'],
  T: ['#####', '..#..', '..#..', '..#..', '..#..', '..#..', '..#..'],
}

/** Lit runs of `word` in LED_FONT: [row from the top, first column, end column] with the word
    `width` columns wide (letters one column apart). */
function ledRuns(word) {
  const runs = []
  let at = 0
  for (const letter of word) {
    const glyph = LED_FONT[letter]
    if (!glyph) { at += 4; continue }
    glyph.forEach((row, r) => {
      for (let c = 0; c < row.length; c++) {
        if (row[c] !== '#' || row[c - 1] === '#') continue
        let end = c
        while (row[end] === '#') end++
        runs.push([r, at + c, at + end])
      }
    })
    at += glyph[0].length + 1
  }
  return { runs, width: Math.max(0, at - 1) }
}

/** Ring at distance d from the edge of the sports area: the stands' rounded rectangle grown to the
    facade's (d = D) and beyond it over the apron. */
export function stadiumRing(d, S = STADIUM) {
  return roundedRing(S.A - S.D + d, S.B - S.D + d, S.INNER_R + (S.R - S.INNER_R) * d / S.D, S.COUNTS)
}
/** The side ring segment i lies on: 0 east, 1 north, 2 west (the main stand), 3 south; −1 in a corner. */
function sideOf(i, [nL, nS, nC]) {
  let k = i
  for (const [n, s] of [[nL, 0], [nC, -1], [nS, 1], [nC, -1], [nL, 2], [nC, -1], [nS, 3], [nC, -1]]) { if (k < n) return s; k -= n }
  return -1
}

/** Where the trees stand, in model metres (x across, y along), with the ring segment each one is on. */
export function stadiumTreeSpots(S = STADIUM) {
  const [nL, nS, nC] = S.COUNTS, N = 2 * nL + 2 * nS + 4 * nC
  const ring = stadiumRing(S.D + (S.VERGE[0] + S.VERGE[1]) / 2, S), spots = []
  for (let i = 0; i < N; i += 2) {
    if (sideOf(i, S.COUNTS) < 0 || S.TREES.skip.some(([from, to]) => i >= from && i <= to)) continue
    const j = (i + 1) % N
    spots.push([(ring[i][0] + ring[j][0]) / 2, (ring[i][1] + ring[j][1]) / 2, i])
  }
  return spots
}

/** The stadium's triangles about its centre, turned to `axis`. `night` lights the media facade in
    orange and amber, the glass, the floodlights and the screens. Day and night share one layout. */
export function stadiumTriangles(axis, night = false, S = STADIUM, C = STADIUM_COLOURS) {
  const { strip, box, face, done } = meshWriter(axis, 90_000)
  const ring = d => stadiumRing(d, S)
  const [nL, nS, nC] = S.COUNTS, N = 2 * nL + 2 * nS + 4 * nC
  const sideTable = Int8Array.from({ length: N }, (_, i) => sideOf(i, S.COUNTS)), side = i => sideTable[i]
  const flat = colour => { const style = [colour, false]; return () => style }
  const shades = new Map()
  /** `colour` times k, made once per colour and k. */
  const darker = (colour, k = 0.62) => {
    let byK = shades.get(colour)
    if (!byK) shades.set(colour, byK = new Map())
    let shaded = byK.get(k)
    if (!shaded) byK.set(k, shaded = colour.map(c => c * k))
    return shaded
  }
  // Where each straight side starts in the ring, its segment count and its aisles.
  const sides = [[0, nL, S.AISLE.long], [nL + nC, nS, S.AISLE.short], [nL + nC + nS + nC, nL, S.AISLE.long], [2 * nL + nS + 3 * nC, nS, S.AISLE.short]]
  const corners = [nL, nL + nC + nS, 2 * nL + nS + 2 * nC, 2 * nL + 2 * nS + 3 * nC]
  // What each stand segment is: 0 seats, 1 an aisle, 2 a vomitory.
  const kind = new Uint8Array(N)
  for (const [start, n, aisles] of sides) for (const k of aisles) {
    kind[start + k] = 1
    if (k + S.AISLE.vomitory < n) kind[start + k + S.AISLE.vomitory] = 2
  }
  for (const c of corners) kind[c + (nC >> 1)] = 1
  /** A ring of the stands: an aisle's segment is cut to its width by moving the point after it along
      the straight side, so aisles cost no extra points and the ring keeps its outline. */
  const standRing = d => {
    const points = ring(d)
    for (const [start, , aisles] of sides) for (const k of aisles) {
      const p = points[start + k], q = points[start + k + 1], t = S.AISLE.width / Math.hypot(q[0] - p[0], q[1] - p[1])
      points[start + k + 1] = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, q[2], q[3]]
    }
    return points
  }

  // Pitch: the run-off between the stands and the field, the field in 18 mowing stripes, the markings
  // 0.3 m wide (twice real, so they survive a phone screen) and two goals with nets.
  const [fx, fy] = S.FIELD, L = 0.15, Z = 0.12
  strip(roundedRing(fx, fy, 0, S.COUNTS), 0.05, ring(0), 0.05, flat(C.runoff), 'up')
  for (let k = 0; k < 18; k++) {
    const y0 = -fy + k * 2 * fy / 18, y1 = y0 + 2 * fy / 18
    face([[-fx, y0, 0.05], [fx, y0, 0.05], [fx, y1, 0.05], [-fx, y1, 0.05]], k % 2 ? C.grass : C.grass2, [0, 0, 1])
  }
  const bar = (x0, y0, x1, y1) => face([[x0 - L, y0 - L, Z], [x1 + L, y0 - L, Z], [x1 + L, y1 + L, Z], [x0 - L, y1 + L, Z]], C.line, [0, 0, 1])
  const arcLine = (cx, cy, r, from, to, n) => {
    for (let k = 0; k < n; k++) {
      const a = from + (to - from) * k / n, b = from + (to - from) * (k + 1) / n
      face([[cx + Math.sin(a) * (r - L), cy + Math.cos(a) * (r - L), Z], [cx + Math.sin(b) * (r - L), cy + Math.cos(b) * (r - L), Z],
        [cx + Math.sin(b) * (r + L), cy + Math.cos(b) * (r + L), Z], [cx + Math.sin(a) * (r + L), cy + Math.cos(a) * (r + L), Z]], C.line, [0, 0, 1])
    }
  }
  const spot = (x, y) => { for (let k = 0; k < 8; k++) { const a = k / 8 * Math.PI * 2, b = (k + 1) / 8 * Math.PI * 2; face([[x, y, Z], [x + Math.sin(a) * 0.4, y + Math.cos(a) * 0.4, Z], [x + Math.sin(b) * 0.4, y + Math.cos(b) * 0.4, Z]], C.line, [0, 0, 1]) } }
  bar(-fx, -fy, -fx, fy); bar(fx, -fy, fx, fy); bar(-fx, -fy, fx, -fy); bar(-fx, fy, fx, fy); bar(-fx, 0, fx, 0)
  arcLine(0, 0, 9.15, 0, Math.PI * 2, 32)
  spot(0, 0)
  for (const e of [1, -1]) {
    const g = e * fy, p = e * (fy - 16.5), q = e * (fy - 5.5), s = e * (fy - 11)
    bar(-20.16, Math.min(g, p), -20.16, Math.max(g, p)); bar(20.16, Math.min(g, p), 20.16, Math.max(g, p)); bar(-20.16, p, 20.16, p)
    bar(-9.16, Math.min(g, q), -9.16, Math.max(g, q)); bar(9.16, Math.min(g, q), 9.16, Math.max(g, q)); bar(-9.16, q, 9.16, q)
    spot(0, s)
    const phi = Math.acos(5.5 / 9.15)   // the D: the part of the 9.15 m circle outside the penalty area
    arcLine(0, s, 9.15, e > 0 ? Math.PI - phi : -phi, e > 0 ? Math.PI + phi : phi, 10)
    const back = e * (fy + 2)
    for (const x of [-3.66, 3.66]) box(x, g, 0.1, 0.1, 0, 2.44, [C.white])
    box(0, g, 3.76, 0.1, 2.34, 2.54, [C.white])
    face([[-3.66, g, 2.44], [3.66, g, 2.44], [3.66, back, 1.6], [-3.66, back, 1.6]], C.net, [0, 0, 1])
    face([[-3.66, back, 0], [3.66, back, 0], [3.66, back, 1.6], [-3.66, back, 1.6]], C.net, [0, e, 0])
    for (const x of [-3.66, 3.66]) face([[x, g, 0], [x, back, 0], [x, back, 1.6], [x, g, 2.44]], C.net, [x, 0, 0])
  }
  // The benches on the main (west) touchline, glazed towards the pitch.
  for (const y of [-9, 9]) box(-(fx + 4.5), y, 1.0, 4, 0.05, 1.7, [C.glass, C.white, C.white, C.white, C.roof])
  // LED advertising boards round the pitch, in blocks of three segments.
  const boards = [C.board, C.board2, C.board3, C.board4]
  strip(ring(S.BOARDS.d), 0.05, ring(S.BOARDS.d), S.BOARDS.top, i => [boards[Math.floor(i / 3) % boards.length], true], 'in')

  // Lower tier: a white front wall, a walkway, 14 rows. Risers take the seat colour, darker, so the
  // rows read at a tilt and do not shimmer from afar. Aisles are concrete steps; vomitories open dark
  // in the top rows, into the concourse under the promenade.
  const lo = S.LOWER, lowerSeat = i => side(i) < 0 ? C.seatCorner : C.seat
  const seatOf = (i, row, vomitory, seat) => kind[i] === 1 ? C.stair : kind[i] === 2 && row >= vomitory[0] && row <= vomitory[1] ? C.vomitory : seat
  strip(ring(0), 0, ring(0), lo.front, flat(C.white), 'in')
  strip(ring(0), lo.front, ring(lo.start), lo.front, flat(C.concrete), 'up')
  for (let k = 0; k < lo.rows; k++) {
    const d = lo.start + lo.tread * k, z0 = lo.front + lo.riser * k, z1 = z0 + lo.riser, a = standRing(d), b = standRing(d + lo.tread)
    strip(a, z0, a, z1, i => [darker(seatOf(i, k, lo.vomitory, lowerSeat(i)), kind[i] === 1 ? 0.8 : 0.62), false], 'in')
    strip(a, z1, b, z1, i => [seatOf(i, k, lo.vomitory, lowerSeat(i)), false], 'up')
  }
  const lowerTop = lo.front + lo.riser * lo.rows

  // Promenade at +9 m behind a glass balustrade, glazed boxes behind it, and the upper tier's fascia
  // with an LED ribbon above them.
  const [p0, p1] = S.PROMENADE, fa = S.FASCIA
  strip(ring(p0), lowerTop, ring(p0), lowerTop + S.RAIL, flat(C.rail), 'in')
  strip(ring(p0), lowerTop, ring(p1), lowerTop, flat(C.concrete), 'up')
  strip(ring(p1), S.BOX_GLASS[0], ring(p1), S.BOX_GLASS[1], () => [night ? C.warm : C.glass, night], 'in')
  strip(ring(fa.d), fa.bottom, ring(p1), fa.bottom, flat(C.soffit), 'down')
  strip(ring(fa.d), fa.bottom, ring(fa.d), fa.top, flat(C.white), 'in')
  strip(ring(fa.d - 0.05), fa.ribbon[0], ring(fa.d - 0.05), fa.ribbon[1], () => [night ? C.orange : C.screen, night], 'in')
  strip(ring(fa.d), fa.top, ring(S.UPPER.start), fa.top, flat(C.concrete), 'up')

  // Upper tier, 16 rows, with vomitories in its front rows. The main (west) stand shows the flag:
  // green, white, red from the bottom, 5:6:5 rows.
  const up = S.UPPER
  for (let k = 0; k < up.rows; k++) {
    const d = up.start + up.tread * k, z0 = up.base + up.riser * k, z1 = z0 + up.riser, a = standRing(d), b = standRing(d + up.tread)
    const flag = k < 5 ? C.green : k < 11 ? C.white : C.seat
    const upperSeat = i => seatOf(i, k, up.vomitory, S.FLAG_MOSAIC && side(i) === 2 ? flag : side(i) < 0 ? C.seatCorner : C.seat)
    strip(a, z0, a, z1, i => [darker(upperSeat(i), kind[i] === 1 ? 0.8 : 0.62), false], 'in')
    strip(a, z1, b, z1, i => [upperSeat(i), false], 'up')
  }
  const upperTop = up.base + up.riser * up.rows, back = up.start + up.tread * up.rows

  // Roof: the wall behind the top row, the ceiling over the upper tier with floodlight clusters hung
  // under its leading edge, the white leading edge with its band of lamps, the deck rising to the
  // crown of the facade, a rib every fourth segment and a coping along the crown, lit at night.
  const rf = S.ROOF
  strip(ring(back), upperTop, ring(back), rf.under, flat(C.dark), 'in')
  strip(ring(rf.inner), rf.under, ring(back), rf.under, flat(C.underside), 'down')
  strip(ring(rf.inner), rf.under, ring(rf.inner), rf.edge, flat(C.white), 'in')
  strip(ring(rf.inner - 0.05), rf.lamps[0], ring(rf.inner - 0.05), rf.lamps[1], () => [night ? C.lamp : C.lampOff, true], 'in')
  const lampRing = ring(rf.inner + 0.9), lit = night ? [true, true, true, true] : []
  for (let i = 0; i < N; i += rf.clusters) {
    const [x, y, nx, ny] = lampRing[i]
    box(x, y, 0.35, 1.6, rf.under - 0.9, rf.under - 0.02, [night ? C.lamp : C.lampOff], Math.atan2(ny, nx), lit, false)
  }
  // The deck's first metres are the lit ring seen from afar at night.
  const rim = rf.edge + (S.TOP - rf.edge) * rf.rim / (S.D - rf.inner)
  strip(ring(rf.inner), rf.edge, ring(rf.inner + rf.rim), rim, () => [night ? C.lamp : C.roof, night], 'up')
  strip(ring(rf.inner + rf.rim), rim, ring(S.D), S.TOP, flat(C.roof), 'up')
  const inner = ring(rf.inner), outer = ring(S.D)
  for (let i = 0; i < N; i += 4) {
    const [ax, ay] = inner[i], [bx, by] = outer[i], len = Math.hypot(bx - ax, by - ay), tx = -(by - ay) / len * 0.35, ty = (bx - ax) / len * 0.35
    const za = rf.edge + 0.35, zb = S.TOP + 0.35
    face([[ax - tx, ay - ty, za], [ax + tx, ay + ty, za], [bx + tx, by + ty, zb], [bx - tx, by - ty, zb]], C.rib, [0, 0, 1])
    face([[ax + tx, ay + ty, rf.edge], [bx + tx, by + ty, S.TOP], [bx + tx, by + ty, zb], [ax + tx, ay + ty, za]], C.rib, [tx, ty, 0])
    face([[ax - tx, ay - ty, rf.edge], [bx - tx, by - ty, S.TOP], [bx - tx, by - ty, zb], [ax - tx, ay - ty, za]], C.rib, [-tx, -ty, 0])
  }
  const fc = S.FACADE
  strip(ring(S.D - 0.3), S.TOP + 0.1, ring(S.D + fc.coping), S.TOP + 0.1, flat(C.white), 'up')
  strip(ring(S.D + fc.coping), S.TOP - 0.45, ring(S.D + fc.coping), S.TOP + 0.1, () => [night ? C.lamp : C.white, night], 'out')

  // Facade: 12 horizontal aluminium louvres, every other one set 0.4 m back. The band swoops down at
  // the corners as in the photographs, so its bottom edge and every louvre follow `podium`. By day it
  // is silver with LED lettering on the long sides; at night every louvre carries the media picture in
  // orange and amber, as in the photographs.
  const facade = ring(S.D), run = [0]
  for (let i = 0; i < N; i++) { const j = (i + 1) % N; run.push(run[i] + Math.hypot(facade[j][0] - facade[i][0], facade[j][1] - facade[i][1])) }
  const perimeter = run[N], along = run.slice(0, N).map((r, i) => (r + run[i + 1]) / 2)
  const apexes = corners.map(c => (run[c] + run[c + nC]) / 2)
  /** Metres along the facade from `at` to the nearest corner's apex. */
  const fromCorner = at => Math.min(...apexes.map(apex => { const gap = Math.abs(at - apex) % perimeter; return Math.min(gap, perimeter - gap) }))
  const podium = run.slice(0, N).map(at => {
    const t = Math.min(1, fromCorner(at) / fc.swoop)
    return fc.corner + (fc.podium - fc.corner) * t * t * (3 - 2 * t)
  })
  const podiumAt = i => podium[i]
  const level = s => i => podium[i] + (S.TOP - podium[i]) * s / fc.strips
  const picture = (i, s) => {
    const f = 0.5 + 0.5 * Math.sin(0.11 * along[i] + 0.9 * s) * Math.cos(0.05 * along[i] - 0.6 * s)
    return C.deep.map((c, k) => c + (C.amber[k] - c) * f)
  }
  for (let s = 0; s < fc.strips; s++) {
    const d = s % 2 ? S.D - fc.inset : S.D
    strip(ring(d), level(s), ring(d), level(s + 1), i => night ? [picture(i, s), true] : [s % 2 ? C.alu2 : C.alu, false], 'out')
    if (s % 2 === 0) strip(ring(S.D - fc.inset), level(s + 1), ring(S.D), level(s + 1), flat(C.alu), 'up')
  }
  // The lettering: lit runs laid 10 cm proud of their louvres, read left to right from outside on the
  // east and on the west side. It stays on the middle of the long sides, where the band is level:
  // a longer word gets narrower letters.
  const text = S.TEXT, { runs, width } = ledRuns(text.word), h = (S.TOP - fc.podium) / fc.strips
  const levelHalf = S.B - S.R - Math.max(0, fc.swoop - Math.PI * S.R / 4) - 1, pixel = Math.min(text.pixel, levelHalf / Math.max(1, width / 2))
  for (const e of [1, -1]) for (const [row, c0, c1] of runs) {
    const s = text.rows[1] - row, x = e * (S.A - (s % 2 ? fc.inset : 0) + 0.1)
    const z0 = fc.podium + h * s + 0.3, z1 = fc.podium + h * (s + 1) - 0.3
    const y0 = e * (c0 - width / 2) * pixel, y1 = e * (c1 - width / 2) * pixel
    face([[x, y0, z0], [x, y1, z0], [x, y1, z1], [x, y0, z1]], night ? C.textNight : C.text, [e, 0, 0], true)
  }
  // The glazed ground floor behind the columns: panes in two tones, a transom, doors at the entrances.
  const entrance = i => {
    for (const [start, n] of sides) if (i >= start && i < start + n && Math.abs(i - start - n / 2 + 0.5) < S.ENTRANCES) return true
    return false
  }
  const pane = i => night ? [i % 2 ? C.warm : C.warm2, true] : [i % 2 ? C.glass : C.glass2, false]
  strip(ring(fc.glass), podiumAt, ring(S.D), podiumAt, () => [night ? C.warm : C.soffit, night], 'down')
  strip(ring(fc.glass), 0, ring(fc.glass), fc.transom[0], i => entrance(i) && !night ? [C.door, false] : pane(i), 'out')
  strip(ring(fc.glass), fc.transom[0], ring(fc.glass), fc.transom[1], flat(C.column), 'out')
  strip(ring(fc.glass), fc.transom[1], ring(fc.glass), podiumAt, pane, 'out')
  const columns = ring(fc.glass + 0.9)
  for (let i = 0; i < N; i += 2) box(columns[i][0], columns[i][1], 0.25, 0.25, 0, podium[i], [C.column], Math.atan2(columns[i][3], columns[i][2]), [], false)

  // The apron: paving from the glass line, lighter plazas at the four entrances, a planted verge with
  // trees where no street runs close, and a kerb.
  const trees = stadiumTreeSpots(S), planted = new Set(trees.map(([, , i]) => i))
  const paving = i => [entrance(i) ? C.plaza : i % 2 ? C.paving : C.paving2, false]
  strip(ring(fc.glass), 0.04, ring(S.D + S.VERGE[0]), 0.04, paving, 'up')
  strip(ring(S.D + S.VERGE[0]), 0.04, ring(S.D + S.VERGE[1]), 0.04, i => planted.has(i) ? [C.verge, false] : paving(i), 'up')
  strip(ring(S.D + S.VERGE[1]), 0.04, ring(S.D + S.APRON), 0.04, flat(C.kerb), 'up')
  const leaves = [C.leaf, C.leaf2, C.leaf3], tr = S.TREES
  trees.forEach(([x, y], n) => {
    const leaf = leaves[n % leaves.length], low = 2.2, belly = low + (tr.height - low) * 0.4
    box(x, y, 0.16, 0.16, 0.04, belly, [C.trunk], 0, [], false)
    for (let k = 0; k < 8; k++) {
      const a = k * Math.PI / 4, b = (k + 1) * Math.PI / 4, r = tr.crown * (0.85 + 0.075 * ((n * 7 + k) % 3))
      const pa = [x + Math.cos(a) * r, y + Math.sin(a) * r, belly], pb = [x + Math.cos(b) * r, y + Math.sin(b) * r, belly]
      const mid = [Math.cos(a + Math.PI / 8), Math.sin(a + Math.PI / 8)]
      face([[x, y, tr.height], pa, pb], leaf, [mid[0], mid[1], 0.7])
      face([[x, y, low], pb, pa], darker(leaf, 0.85), [mid[0], mid[1], -0.7])
    }
  })

  // Two 15 × 8.5 m screens at the ends, facing the pitch; the glazed VIP box on the main stand; the
  // main entrance canopy on the west side on slim columns.
  for (const e of [1, -1]) {
    const front = e > 0 ? 3 : 1, colours = [C.dark, C.dark, C.dark, C.dark, C.dark], on = []
    colours[front] = night ? C.screenOn : C.screen; on[front] = night
    box(0, e * (S.B - S.D + 29.9), 7.5, 0.5, 20.9, rf.under, colours, 0, on)
  }
  box(-(S.A - S.D + 21), 0, 1.4, 20, 17.0, 20.2, [night ? C.warm : C.glass, C.white, C.white, C.white, C.white], 0, [night])
  box(-(S.A + 3), 0, 3, 20, 6.0, 6.8, [C.white])
  for (const y of [-18, -8, 8, 18]) box(-(S.A + 5.5), y, 0.2, 0.2, 0, 6.0, [C.column])
  return done()
}

// ---------------------------------------------------------------------------------------------
/** Every landmark. `centre` is [lon, lat]; `axis` the bearing of the long axis; `half` and `radius`
    the footprint in the model frame; `clear` how far round it no country house is drawn; `extent` how
    far from the centre its mesh reaches (the apron included), for culling. */
export const LANDMARKS = [
  {
    id: 'national-stadium',
    key: 'landmark:national-stadium',
    centre: [68.77445, 38.586596],
    axis: 358.44,
    half: [STADIUM.A, STADIUM.B], radius: STADIUM.R, clear: 6, top: STADIUM.TOP,
    extent: Math.hypot(STADIUM.A + STADIUM.APRON, STADIUM.B + STADIUM.APRON),
    minzoom: 13.5,
    build: night => stadiumTriangles(358.44, night),
    place: {
      id: 'way/1076243310', lat: 38.586596, lon: 68.77445,
      tags: {
        name: 'Национальный стадион', 'name:ru': 'Национальный стадион',
        'name:tg': 'Варзишгоҳи миллии Тоҷикистон', 'name:en': 'National Stadium of Tajikistan',
        alt_name: 'Национальный центральный стадион;Варзишгоҳи Душанбе;Dushanbe Stadium',
        leisure: 'stadium', sport: 'soccer', capacity: '30000', height: '33', 'building:levels': '5',
        start_date: '2026-08-21', 'addr:city': 'Душанбе', wikidata: 'Q85757999',
        'atlas:type': 'landmark', 'atlas:landmark': 'national-stadium',
      },
    },
  },
]

const frames = new Map()
/** Mercator centre, metre scale and turn of a landmark, worked out once. */
function frameOf(landmark) {
  let frame = frames.get(landmark.id)
  if (!frame) {
    const [lon, lat] = landmark.centre, angle = landmark.axis * Math.PI / 180
    frame = { x: mercX(lon), y: mercY(lat), scale: 1 / (EARTH * Math.cos(lat * Math.PI / 180)), cos: Math.cos(angle), sin: Math.sin(angle) }
    const reach = Math.hypot(landmark.half[0], landmark.half[1]) + landmark.clear
    frame.box = [frame.x - reach * frame.scale, frame.y - reach * frame.scale, frame.x + reach * frame.scale, frame.y + reach * frame.scale]
    frames.set(landmark.id, frame)
  }
  return frame
}
/** Model-frame metres of a Web Mercator point (0..1 across the world, y down). */
export function modelOf(landmark, mx, my) {
  const f = frameOf(landmark), e = (mx - f.x) / f.scale, n = (f.y - my) / f.scale
  return [e * f.cos - n * f.sin, e * f.sin + n * f.cos]
}
const within = (landmark, [x, y], margin) => insideRounded(x, y, landmark.half[0] + margin, landmark.half[1] + margin, landmark.radius + margin)

/** The landmark standing on lon/lat, if any. */
export function landmarkAt(lon, lat) {
  return LANDMARKS.find(landmark => within(landmark, modelOf(landmark, mercX(lon), mercY(lat)), 0)) ?? null
}

/** Whether a house, as a ring of Web Mercator points, stands where a landmark is modelled: its middle
    is within `clear` metres of the outline, or a corner is inside the outline. */
export function landmarkCovers(ring) {
  if (ring.length < 3) return false
  let sx = 0, sy = 0
  for (const [x, y] of ring) { sx += x; sy += y }
  for (const landmark of LANDMARKS) {
    const [west, north, east, south] = frameOf(landmark).box
    if (sx / ring.length < west - 1e-5 || sx / ring.length > east + 1e-5 || sy / ring.length < north - 1e-5 || sy / ring.length > south + 1e-5) continue
    if (within(landmark, modelOf(landmark, sx / ring.length, sy / ring.length), landmark.clear)) return true
    if (ring.some(([x, y]) => within(landmark, modelOf(landmark, x, y), 0))) return true
  }
  return false
}

/** For houses:// tile z/x/y: null when no landmark is near it, else a test for a ring in tile units (0..4096). */
export function landmarkTileFilter(z, x, y) {
  const n = 2 ** z, west = x / n, north = y / n, east = (x + 1) / n, south = (y + 1) / n
  const near = LANDMARKS.some(landmark => { const [w, t, e, b] = frameOf(landmark).box; return w < east && e > west && t < south && b > north })
  if (!near) return null
  return ring => landmarkCovers(ring.map(([tx, ty]) => [(x + tx / 4096) / n, (y + ty / 4096) / n]))
}

/** Landmarks as places for search, the sheet and routes. */
export function landmarkPlaces() { return LANDMARKS.map(landmark => landmark.place) }
/** The place of a landmark by its place id or its key. */
export function landmarkPlace(id) { return LANDMARKS.find(landmark => landmark.place.id === id || landmark.key === id)?.place ?? null }

/** Outlines in lon/lat (closed, 40 points) for a tap test. */
export function landmarkOutline(landmark, margin = 0) {
  const f = frameOf(landmark)
  const ring = roundedRing(landmark.half[0] + margin, landmark.half[1] + margin, landmark.radius + margin, [6, 4, 5]).map(([x, y]) => {
    const e = x * f.cos + y * f.sin, n = -x * f.sin + y * f.cos
    return [lonOf(f.x + e * f.scale), latOf(f.y - n * f.scale)]
  })
  return [...ring, ring[0]]
}

/** The outline as local metres east and north of the centre (40 points, open): the silhouette the
    layer projects to screen for a tap. */
export function landmarkSilhouette(landmark) {
  const f = frameOf(landmark)
  return roundedRing(landmark.half[0], landmark.half[1], landmark.radius, [6, 4, 5]).map(([x, y]) => [x * f.cos + y * f.sin, -x * f.sin + y * f.cos])
}

/** Dusk to dawn in Dushanbe (UTC+5, no summer time): the media facade is lit. */
export function isNightInDushanbe(date = new Date()) {
  const hour = (date.getUTCHours() + 5 + date.getUTCMinutes() / 60) % 24
  return hour >= 19.5 || hour < 5.5
}
