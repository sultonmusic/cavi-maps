import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

// Run the source helpers without changing their bundler-compatible extensionless imports.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cache = new Map()
function loadHelper(relative) {
  const filename = resolve(root, relative)
  if (cache.has(filename)) return cache.get(filename)
  const source = readFileSync(filename, 'utf8')
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    fileName: filename,
  })
  const module = { exports: {} }
  cache.set(filename, module.exports)
  const requireHelper = specifier => {
    assert.ok(specifier.startsWith('./'), `Unexpected helper dependency: ${specifier}`)
    return loadHelper(resolve(dirname(filename), specifier + (specifier.endsWith('.ts') ? '' : '.ts')))
  }
  vm.runInThisContext(`(function(require,module,exports){${outputText}\n})`, { filename })(requireHelper, module, module.exports)
  cache.set(filename, module.exports)
  return module.exports
}

const { createStreetIndex, roadPoint } = loadHelper('lib/street-index.ts')
const { roadPlace, districtPlace, districtAt } = loadHelper('lib/map-places.ts')
const streetData = JSON.parse(readFileSync(resolve(root, 'public/streets.json'), 'utf8'))
const districtData = JSON.parse(readFileSync(resolve(root, 'public/districts.json'), 'utf8'))
const roads = streetData.roads
const districts = districtData.districts
const rawBefore = JSON.stringify({ roads, districts })
const source = roads.filter(road => road.namingStatus === 'source')
const proposed = roads.filter(road => road.namingStatus === 'proposed')
const sourceNamed = source.filter(road => road.name || road.ref)
assert.equal(sourceNamed.length, 9848, 'Existing named/ref roads must remain intact')
assert.equal(proposed.length, 237, '237 source way segments comprise the proposed streets')
assert.equal(new Set(proposed.map(road => road.groupId)).size, 209, '209 proposed street groups')
assert.equal(streetData.localNaming.official, false)

for (const road of source) {
  const originalName = road.tags['name:ru'] || road.tags.name || road.tags['name:tg'] || road.tags['name:en'] || null
  assert.equal(road.name, originalName, `${road.id}: original source name was changed`)
  assert.equal(road.ref, road.tags.ref || null, `${road.id}: original ref was changed`)
  const place = roadPlace(road)
  assert.ok(place, `${road.id}: missing usable geometry`)
  assert.equal(place.tags['atlas:naming'], 'source')
  assert.equal(place.tags['atlas:type'], 'street')
  assert.equal(place.tags['atlas:road-id'], road.id)
  assert.equal(place.tags.name, road.name || road.ref || 'Безымянный проезд')
}

const index = createStreetIndex(roads)
const click = { lat: 40.671740, lon: 70.352819 }
const match = index.nearest(click.lat, click.lon, 60)
assert.ok(match)
assert.equal(match.road.id, 'way/1133986166')
assert.equal(match.road.tags.name, 'Улица Маданият')
assert.equal(match.road.name, 'Улица Маданият')
const selected = roadPlace(match.road, click)
assert.equal(selected.tags.name, 'Улица Маданият')
assert.equal(selected.tags['atlas:naming'], 'source')
assert.equal(selected.tags['addr:city'], 'Шайдон')
assert.equal(selected.lat, click.lat, 'Click latitude must be kept for route destination')
assert.equal(selected.lon, click.lon, 'Click longitude must be kept for route destination')
assert.ok(match.distanceMeters > 0.1, 'Fixture must differ from the snapped road point')
assert.ok(selected.lat !== match.lat || selected.lon !== match.lon, 'Do not silently replace the clicked point with the road projection')

for (const road of proposed) {
  assert.ok(road.name && road.groupId)
  for (const key of ['name', 'name:ru', 'name:tg', 'name:en', 'ref']) {
    assert.ok(!road.tags[key], `${road.id}: proposed name overwrote or replaced an existing source name/ref`)
  }
  const point = roadPoint(road)
  const place = roadPlace(road, point)
  assert.ok(place)
  assert.equal(place.tags.name, road.name)
  assert.equal(place.tags['atlas:naming'], 'proposed', 'UI must receive the Название Atlas status')
  assert.equal(place.tags['atlas:type'], 'street')
  assert.equal(place.lat, point.lat)
  assert.equal(place.lon, point.lon)
  assert.ok(!Object.values(place.tags).some(value => value === 'official'), 'Proposal must not claim official naming')
}

assert.equal(districts.length, 4)
assert.equal(districtData.official, false)
assert.equal(districtData.approximateBoundaries, true)
for (const district of districts) {
  assert.equal(district.official, false)
  assert.equal(district.namingStatus, 'proposed')
  assert.equal(districtAt(districts, district.center[1], district.center[0])?.id, district.id, `${district.id}: centre must lie inside its actual polygon`)
  const place = districtPlace(district)
  assert.equal(place.tags.name, district.name)
  assert.equal(place.tags['atlas:type'], 'district')
  assert.equal(place.tags['atlas:naming'], 'proposed')
  assert.equal(place.lat, district.center[1])
  assert.equal(place.lon, district.center[0])
  const explicit = districtPlace(district, click)
  assert.equal(explicit.lat, click.lat)
  assert.equal(explicit.lon, click.lon)
  assert.ok(!Object.values(place.tags).some(value => value === 'official'))
}
// These points are inside the broad Shaydon selection box but outside its built-up footprint.
assert.equal(districtAt(districts, 40.6385, 70.3355), null)
assert.equal(districtAt(districts, 40.6385, 70.3855), null)
assert.equal(districtAt(districts, 40.70, 70.35), null)
assert.equal(districtAt(districts, 38.575, 68.79), null)

// A district hole must remain outside even though it lies within the bounding box.
const withHole = { id: 'hole', name: 'Test', namingStatus: 'proposed', center: [1, 1], bbox: [0, 0, 4, 4], geometry: { type: 'Polygon', coordinates: [
  [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
  [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
] } }
assert.equal(districtAt([withHole], 2, 2), null)
assert.equal(districtAt([withHole], 0.5, 0.5)?.id, 'hole')

assert.equal(JSON.stringify({ roads, districts }), rawBefore, 'Display conversion must never mutate source geometry/tags')
console.log(`map-places: ${sourceNamed.length} original named/ref roads preserved; ${proposed.length} proposed segments / 209 names; 4 explicitly unofficial districts; screenshot Маданият at ${match.distanceMeters.toFixed(1)} m; original click coordinates retained`)
