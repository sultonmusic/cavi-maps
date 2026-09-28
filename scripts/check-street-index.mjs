import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createStreetIndex, roadPoint } from '../lib/street-index.ts'

const road = (id, coordinates, name = null) => ({ id, coordinates, name, ref: null, tags: {}, bbox: [0, 0, 0, 0] })
const near = (actual, expected, tolerance = 1e-7) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} != ${expected}`)

const main = road('main', [[70.35, 40.67], [70.35, 40.68]], 'Улица Маданият')
const parallel = road('parallel', [[70.3505, 40.67], [70.3505, 40.68]], 'Соседняя улица')
const index = createStreetIndex([main, parallel])
assert.equal(index.byId.get('main'), main)
assert.equal(index.nearest(40.675, 70.3501, 100).road.id, 'main')
assert.equal(index.nearest(40.675, 70.35045, 100).road.id, 'parallel')
const snapped = index.nearest(40.675, 70.3501, 100)
near(snapped.lat, 40.675)
near(snapped.lon, 70.35)
assert.ok(snapped.distanceMeters > 8 && snapped.distanceMeters < 9)
assert.equal(index.nearest(40.675, 70.36, 100), null)
assert.equal(index.nearest(NaN, 70.35, 100), null)
assert.equal(index.nearest(40.675, 70.35, -1), null)
assert.equal(index.nearest(40.675, 70.35, Infinity), null)
assert.equal(index.nearest(40.675, 70.35, 0).road.id, 'main')

// Bounds/vertices are insufficient: the nearest point can be in the middle of a long segment.
const diagonal = createStreetIndex([road('diagonal', [[69, 40], [72, 42]], 'Диагональ')])
assert.equal(diagonal.nearest(41, 70.5, 1).road.id, 'diagonal')
assert.equal(diagonal.nearest(43, 70.5, 100), null)
assert.equal(diagonal.nearest(40.9, 70.5, 50_000).road.id, 'diagonal')

const tied = [road('unnamed', [[70, 40], [70, 41]]), road('named', [[70, 40], [70, 41]], 'Именованная')]
assert.equal(createStreetIndex(tied).nearest(40.5, 70, 100).road.id, 'named')
assert.equal(createStreetIndex(tied.toReversed()).nearest(40.5, 70, 100).road.id, 'named')
const lexical = [road('way/b', [[70, 40], [70, 41]], 'Б'), road('way/a', [[70, 40], [70, 41]], 'А')]
assert.equal(createStreetIndex(lexical).nearest(40.5, 70, 100).road.id, 'way/a')

// Invalid geometry must not introduce a shortcut across missing vertices.
const broken = road('broken', [[70, 40], [NaN, 40.5], [70, 41]])
assert.equal(createStreetIndex([broken]).nearest(40.5, 70, 100), null)
assert.equal(createStreetIndex([road('bad', [[200, 95], [NaN, 0]])]).nearest(40, 70, 100), null)
assert.equal(roadPoint(road('empty', [])), null)
const repeated = road('repeated', [[70, 40], [70, 40]])
assert.deepEqual(roadPoint(repeated), { lat: 40, lon: 70 })
assert.equal(createStreetIndex([repeated]).nearest(40, 70, 0).road.id, 'repeated')
// Uneven vertex spacing: midpoint must be 40.02, not the middle vertex 40.001.
near(roadPoint(road('uneven', [[70, 40], [70, 40.001], [70, 40.04]])).lat, 40.02)

console.log('street-index: geometry, parallel roads, deterministic ties, malformed data and midpoint checks passed')

try {
  const { roads } = JSON.parse(await readFile(new URL('../public/streets.json', import.meta.url), 'utf8'))
  assert.ok(Array.isArray(roads) && roads.length > 0)
  const started = performance.now()
  const real = createStreetIndex(roads)
  const buildMs = performance.now() - started
  const match = real.nearest(40.671740, 70.352819, 60)
  assert.ok(match, 'Screenshot point must match the nearby actual street geometry')
  assert.match(match.road.name || '', /Маданият/i, 'Screenshot street must resolve to Маданият')
  assert.ok(match.distanceMeters <= 60)
  const queryStarted = performance.now()
  for (let i = 0; i < 1000; i++) real.nearest(40.67 + (i % 31) * 0.0001, 70.35 + (i % 29) * 0.0001, 60)
  console.log(`street-index real: ${roads.length} roads; ${Math.round(buildMs)} ms build; 1000 queries ${Math.round(performance.now() - queryStarted)} ms; screenshot ${match.road.id} ${match.road.name}, ${match.distanceMeters.toFixed(1)} m`)
} catch (error) {
  if (error?.code === 'ENOENT' && !process.argv.includes('--real')) console.log('street-index: real streets.json not yet available; use --real to require it')
  else throw error
}
