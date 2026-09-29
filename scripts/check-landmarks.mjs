/* Landmarks: the stadium sits on its OpenStreetMap outline, stays inside its vertex budget and its
 * apron, keeps its trees and apron off the streets, hides the country houses under it and no others,
 * and answers a tap and a search.
 *
 *   node scripts/check-landmarks.mjs
 */
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { LANDMARKS, MAX_LANDMARK_VERTICES, STADIUM, insideRounded, isNightInDushanbe, landmarkAt, landmarkCovers, landmarkOutline, landmarkPlace, landmarkPlaces, landmarkTileFilter, mercX, mercY, modelOf, roundedRing, stadiumRing, stadiumTreeSpots, stadiumTriangles } from '../lib/landmarks.mjs'
import { HOUSE_UNIT, housesInTile, housesNear, indexHouses } from '../lib/country-houses.mjs'

const stadium = LANDMARKS.find(landmark => landmark.id === 'national-stadium')
assert.ok(stadium)

// Rings join quad by quad: same length whatever the size, and a sharp rectangle's corners coincide.
assert.equal(roundedRing(10, 20, 3, STADIUM.COUNTS).length, 120)
assert.equal(roundedRing(34, 52.5, 0, STADIUM.COUNTS).length, 120)

// OpenStreetMap way 1076243310, as of the 12.09.2026 extract.
const osm = [[68.7736271,38.5874007],[68.7737038,38.5874443],[68.7737898,38.5874687],[68.7750351,38.5874953],[68.7751312,38.5874771],[68.7752108,38.5874262],[68.7752759,38.5873678],[68.7753044,38.5873221],[68.775352,38.585957],[68.7753135,38.5858665],[68.7752432,38.5857954],[68.7751558,38.5857457],[68.7750506,38.585721],[68.7738628,38.5856956],[68.7737644,38.5857211],[68.7736707,38.5857722],[68.7736208,38.5858516],[68.7735943,38.5859383],[68.7735473,38.5872798],[68.7735687,38.5873427],[68.7736271,38.5874007]]
const model = osm.map(([lon, lat]) => modelOf(stadium, mercX(lon), mercY(lat)))
const xs = model.map(p => p[0]), ys = model.map(p => p[1])
assert.ok(Math.abs(Math.max(...xs) - STADIUM.A) < 0.6 && Math.abs(-Math.min(...xs) - STADIUM.A) < 0.6, 'width matches the outline')
assert.ok(Math.abs(Math.max(...ys) - STADIUM.B) < 0.6 && Math.abs(-Math.min(...ys) - STADIUM.B) < 0.6, 'length matches the outline')
// Straight sides of the outline stay parallel to the model's axes (the axis is right).
for (const [a, b] of [[7, 8], [17, 18]]) assert.ok(Math.abs(model[a][0] - model[b][0]) < 0.4, 'long sides run along the axis')

// Budget and bounds.
const t0 = performance.now()
const day = stadiumTriangles(stadium.axis, false), night = stadiumTriangles(stadium.axis, true)
const ms = performance.now() - t0
assert.equal(day.length % 21, 0)
assert.equal(day.length, night.length, 'day and night share one layout')
assert.ok(day.length / 7 <= MAX_LANDMARK_VERTICES, `vertices ${day.length / 7}`)
// The mesh is written turned to the axis: turn it back to test it against the apron's outline.
const turn = stadium.axis * Math.PI / 180, cos = Math.cos(turn), sin = Math.sin(turn)
const apron = { a: STADIUM.A + STADIUM.APRON, b: STADIUM.B + STADIUM.APRON, r: STADIUM.INNER_R + (STADIUM.R - STADIUM.INNER_R) * (STADIUM.D + STADIUM.APRON) / STADIUM.D }
let top = 0, low = Infinity, reach = 0, outside = 0
for (const mesh of [day, night]) for (let i = 0; i < mesh.length; i += 7) {
  const e = mesh[i], n = mesh[i + 1], z = mesh[i + 2]
  assert.ok(Number.isFinite(e) && Number.isFinite(n) && Number.isFinite(z))
  for (let k = 3; k < 7; k++) assert.ok(mesh[i + k] >= 0 && mesh[i + k] <= 1, 'colours in 0..1')
  top = Math.max(top, z); low = Math.min(low, z); reach = Math.max(reach, Math.hypot(e, n))
  if (!insideRounded(e * cos - n * sin, e * sin + n * cos, apron.a + 0.05, apron.b + 0.05, apron.r + 0.05)) outside++
}
assert.ok(top > 33 && top < 34, 'crown at 33 m (ribs 0.35 m proud)')
assert.equal(low, 0, 'nothing below the ground')
assert.equal(outside, 0, 'nothing beyond the apron')
// The layer culls a landmark by a box `extent` metres each way and `top` + 1 m high: the mesh fits in it.
assert.ok(reach <= stadium.extent && top <= stadium.top + 1, `the mesh reaches ${reach.toFixed(1)} m of the ${stadium.extent.toFixed(1)} m culled`)

// Streets: the trees in the verge and the apron's edge keep clear of every road, path, railway and
// river line of the map's own tiles round the stadium (public/atlas-data, zoom 13).
const segments = []
{
  const n = 2 ** 13, mx = mercX(stadium.centre[0]), my = mercY(stadium.centre[1]), span = 1e-5
  for (let x = Math.floor((mx - span) * n); x <= Math.floor((mx + span) * n); x++) for (let y = Math.floor((my - span) * n); y <= Math.floor((my + span) * n); y++) {
    const file = new URL(`../public/atlas-data/bundle-13-${Math.floor(x / 4)}-${Math.floor(y / 4)}.json`, import.meta.url)
    if (!existsSync(file)) continue
    for (const [, type, geometry] of JSON.parse(readFileSync(file, 'utf8'))[`13-${x}-${y}.json`] ?? []) {
      if (type !== 0) continue
      for (const line of geometry) {
        const points = line.map(([tx, ty]) => modelOf(stadium, (x + tx / 4096) / n, (y + ty / 4096) / n))
        for (let i = 0; i + 1 < points.length; i++) segments.push([points[i], points[i + 1]])
      }
    }
  }
}
assert.ok(segments.length > 1000, 'the map tiles round the stadium were read')
const clearance = ([px, py]) => {
  let best = Infinity
  for (const [[ax, ay], [bx, by]] of segments) {
    const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)))
    best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy))
  }
  return best
}
const trees = stadiumTreeSpots()
assert.ok(trees.length >= 20 && trees.length <= 60, `trees ${trees.length}`)
for (const [x, y, i] of trees) assert.ok(clearance([x, y]) >= 20, `tree at ring point ${i} stands clear of the streets`)
const edge = Math.min(...stadiumRing(STADIUM.D + STADIUM.APRON).map(clearance))
assert.ok(edge >= 6, `the apron stops ${edge.toFixed(1)} m from the nearest street line`)

// Taps.
assert.equal(landmarkAt(68.77445, 38.586596)?.id, 'national-stadium', 'the pitch')
assert.equal(landmarkAt(68.7752, 38.5867)?.id, 'national-stadium', 'the east stand')
assert.equal(landmarkAt(68.7760, 38.5866), null, 'east of the facade')
assert.equal(landmarkAt(68.7704, 38.5850), null, 'the zoo')
const outline = landmarkOutline(stadium)
assert.equal(outline.length, 41); assert.deepEqual(outline[0], outline.at(-1))

// Houses: the one Microsoft footprint straddling the east facade goes; its neighbours stay.
const bytes = readFileSync(new URL('../public/atlas-houses/2830-1571.bin', import.meta.url))
const index = indexHouses(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength))
// Every house of the file, read through the module so AHB1 and AHB2 files both work. #33101 is its
// position in the file as scripts/build-country-houses.py wrote it (estimate-country-heights.mjs keeps
// the order); if the houses are ever rebuilt from a new extract, look the shed up again and update it.
const hidden = []
for (const house of housesNear(index, 2830, 1571, 0, 0, Infinity)) {
  const ring = []
  for (let k = 0; k < house.points.length; k += 2) ring.push([house.points[k] / HOUSE_UNIT, house.points[k + 1] / HOUSE_UNIT])
  if (landmarkCovers(ring)) hidden.push(house.index)
}
assert.equal(hidden.length, 1, `hidden houses ${hidden}`)
assert.deepEqual(hidden, [33101], 'only the shed on the east facade is hidden')
// The same through the tile path the map uses, at every house zoom.
for (const z of [13, 14, 15, 16]) {
  const n = 2 ** z, tx = Math.floor(mercX(68.77445) * n), ty = Math.floor(mercY(38.586596) * n)
  let dropped = 0
  for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
    const filter = landmarkTileFilter(z, tx + dx, ty + dy)
    if (!filter) continue
    const group = [Math.floor((tx + dx) / 2 ** (z - 13) / 2), Math.floor((ty + dy) / 2 ** (z - 13) / 2)]
    if (group[0] !== 2830 || group[1] !== 1571) continue
    dropped += housesInTile(index, 2830, 1571, z, tx + dx, ty + dy).filter(house => filter(house.ring)).length
  }
  assert.equal(dropped, 1, `zoom ${z}`)
}
assert.equal(landmarkTileFilter(16, 45000, 25000), null, 'far tiles skip the test')

// Places.
assert.equal(landmarkPlaces().length, LANDMARKS.length)
assert.equal(landmarkPlace('way/1076243310')?.tags.name, 'Национальный стадион')
assert.equal(landmarkPlace('landmark:national-stadium')?.id, 'way/1076243310')
assert.ok(Object.values(landmarkPlace('way/1076243310').tags).join(' ').toLocaleLowerCase().includes('центральный стадион'))

// Night: Dushanbe is UTC+5.
assert.equal(isNightInDushanbe(new Date('2026-09-28T15:00:00Z')), true)   // 20:00
assert.equal(isNightInDushanbe(new Date('2026-09-28T07:00:00Z')), false)  // 12:00
assert.equal(isNightInDushanbe(new Date('2026-09-28T23:30:00Z')), true)   // 04:30
console.log(`PASS landmarks: ${day.length / 7} vertices (${(day.byteLength / 1e6).toFixed(2)} MB), both builds ${ms.toFixed(0)} ms`)
