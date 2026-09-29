// Road numbers and names: unit tests for lib/road-routes.ts and lib/road-labels.ts, then checks of
// public/road-routes.json when it has been built (skipped with a message otherwise).
//   node scripts/check-road-routes.mjs            unit tests + data checks
//   node scripts/check-road-routes.mjs --builder  also runs scripts/build-road-routes.py on a small
//                                                 .osm fixture (needs Python with osmium and shapely)
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const started = performance.now()
const cache = new Map()
// Run the source helpers without changing their bundler-compatible extensionless imports.
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

const R = loadHelper('lib/road-routes.ts')
const L = loadHelper('lib/road-labels.ts')
const { refKey, refClass, searchVariants, decodeRoadRoutes, applyRouteEdits, isLabelled, routeTitle, findRoutes, routePlace, routeShape, createRouteIndex } = R
const { buildChains, anchorsAlong, thinAnchors, layoutAlong, metersPerPixel, shieldMinZoom, nameMinZoom, createRoadLabels } = L
const near = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`)

// --- refs -------------------------------------------------------------------------------------
for (const [ref, cls] of [['RB04', 'rb'], ['РБ04', 'rb'], ['Р-303', 'local'], ['R-303', 'local'], ['М41', 'intl'], ['M41', 'intl'], ['AH7', 'intl'], ['E123', 'intl'],
  ['РҶ026', 'rj'], ['РЧ026', 'rj'], ['ЭМ-16', 'foreign'], ['D046', 'foreign'], ['', 'none'], [null, 'none']]) assert.equal(refClass(ref), cls, `refClass(${ref})`)
assert.equal(refKey('РБ-04'), refKey('rb 4'))
assert.equal(refKey('РБ-04'), 'RB4')
assert.equal(refKey('Р-303'), 'R303')
assert.equal(refKey('М41'), 'M41')
assert.equal(refKey('РҶ026'), 'RJ26')
const r303 = searchVariants('R-303')
for (const variant of ['r-303', 'r303', 'р-303', 'р303']) assert.ok(r303.includes(variant), `searchVariants(R-303) has ${variant}: ${r303}`)
const rb04 = searchVariants('РБ04')
for (const variant of ['рб04', 'rb4', 'rb04', 'рб4', 'рб 4', 'rb 04']) assert.ok(rb04.includes(variant), `searchVariants(РБ04) has ${variant}: ${rb04}`)
assert.deepEqual(searchVariants(''), [])

// --- decoding ---------------------------------------------------------------------------------
const q = value => Math.round(value * 1e5)
const record = (id, name, flags, points) => {
  const out = [id, name, flags, q(points[0][0]), q(points[0][1])]
  for (let i = 1; i < points.length; i++) out.push(q(points[i][0]) - q(points[i - 1][0]), q(points[i][1]) - q(points[i - 1][1]))
  return out
}
const line = (lon, lat, steps, dlon = 0.002, dlat = 0) => Array.from({ length: steps + 1 }, (_, i) => [lon + i * dlon, lat + i * dlat])
const file = {
  version: 1, kind: 'labelled', source: 'test', license: 'ODbL 1.0', scale: 100000,
  names: ['Роҳи шимолӣ', 'Памирский тракт', 'улица Айни', 'проспект Рудаки'],
  routes: [
    { id: 'ref:РБ04', ref: 'РБ04', refs: ['M41'], name: 'Памирский тракт', hw: 'trunk', km: 712.4, ways: [
      record(11, 1, 0, line(68.80, 38.55, 3)), record(12, 2, 0, line(68.806, 38.55, 2)), record(13, -1, 1, line(68.81, 38.55, 3)), record(14, 1, 8, line(68.816, 38.55, 2))] },
    { id: 'ref:РҶ026', ref: 'РҶ026', name: null, hw: 'primary', km: 40, ways: [record(21, -1, 0, line(70.30, 40.60, 4, 0.002, 0.001))] },
    { id: 'ref:R-303', ref: 'R-303', name: 'Роҳи шимолӣ', hw: 'secondary', km: 6.2, ways: [record(391146809, 0, 0, line(70.36, 40.66, 5)), record(242752039, 0, 2, line(70.37, 40.66, 2))] },
    { id: 'ref:R-30', ref: 'R-30', name: null, hw: 'tertiary', km: 3, ways: [record(31, -1, 0, line(70.0, 40.0, 2))] },
    { id: 'name:41', ref: null, name: 'проспект Рудаки', hw: 'primary', km: 5, ways: [record(41, 3, 0, line(68.77, 38.56, 3)), record(42, 3, 0, line(68.776, 38.56, 3))] },
    { id: 'bad', ref: null, name: null, hw: 'nonsense', km: 1, ways: [[1, -1, 0, 1, 2, 3]] },
  ],
}
const routes = decodeRoadRoutes(file)
assert.equal(routes.length, 5, 'a route with no valid way is dropped')
const byId = new Map(routes.map(route => [route.id, route]))
const pamir = byId.get('ref:РБ04')
assert.equal(pamir.cls, 'rb'); assert.deepEqual(pamir.refs, ['M41']); assert.equal(pamir.ways.length, 4)
assert.deepEqual(pamir.ways[0].line[0], [68.8, 38.55]); assert.equal(pamir.ways[1].name, 'улица Айни'); assert.equal(pamir.ways[2].name, null)
assert.equal(pamir.ways[2].oneway, true); assert.equal(byId.get('ref:R-303').ways[1].link, true)
near(pamir.bbox[0], 68.8, 1e-9, 'bbox west'); near(pamir.bbox[2], 68.82, 1e-9, 'bbox east')
assert.deepEqual(pamir.source, { ref: 'РБ04', name: 'Памирский тракт' })
assert.equal(decodeRoadRoutes({ version: 2, routes: [] }).length, 0)
assert.equal(routeTitle(pamir), 'РБ04 · Памирский тракт')
assert.equal(routeTitle(byId.get('ref:РҶ026')), 'РҶ026')
assert.equal(isLabelled(byId.get('ref:РҶ026')), true)
const extraFile = { ...file, kind: 'extra', names: [], routes: [{ id: 'way:77', ref: null, name: null, hw: 'primary', km: 1, ways: [record(77, -1, 0, line(69, 39, 2))] }] }
const [stroke] = decodeRoadRoutes(extraFile)
assert.equal(stroke.extra, true); assert.equal(isLabelled(stroke), false); assert.equal(routeTitle(stroke), 'Дорога без номера')

// --- search -----------------------------------------------------------------------------------
const first = query => findRoutes(routes, query)[0]?.id
for (const query of ['R303', 'r-303', 'Р-303', 'р303', ' R 303 ']) assert.equal(first(query), 'ref:R-303', `search ${query}`)
assert.equal(first('рб 4'), 'ref:РБ04'); assert.equal(first('RB04'), 'ref:РБ04'); assert.equal(first('РБ-04'), 'ref:РБ04')
assert.equal(first('M41'), 'ref:РБ04', 'a second number of the road finds it')
assert.equal(first('026'), 'ref:РҶ026', 'digits with leading zeros')
assert.equal(first('rj26'), 'ref:РҶ026')
assert.ok(findRoutes(routes, 'Памирский').some(route => route.id === 'ref:РБ04'))
assert.ok(findRoutes(routes, 'Айни').some(route => route.id === 'ref:РБ04'), 'a street along the road finds the road')
assert.equal(first('проспект рудаки'), 'name:41')
assert.equal(first('Роҳи'), 'ref:R-303'); assert.equal(first('рохи шимоли'), 'ref:R-303', 'Tajik letters fold')
assert.deepEqual(findRoutes(routes, 'r30').map(route => route.id).slice(0, 2).sort(), ['ref:R-30', 'ref:R-303'])
assert.equal(first('R30'), 'ref:R-30', 'an exact number beats a longer one')
assert.deepEqual(findRoutes(routes, ''), [])
assert.equal(findRoutes(routes, 'рб', 1).length, 1)
assert.equal(findRoutes([...routes, stroke], 'Дорога').length, 0)

// --- edits ------------------------------------------------------------------------------------
const snapshot = JSON.stringify(routes)
const edited = applyRouteEdits(routes, {
  'route/ref:РБ04': { roadId: 'route/ref:РБ04', name: 'Памирское шоссе' },
  'route/ref:R-303': { roadId: 'route/ref:R-303', ref: '' },
  'way/13': { roadId: 'way/13', name: 'улица Шарк' },
  'way/99999': { roadId: 'way/99999', name: 'не на дороге' },
  'route/name:missing': { roadId: 'route/name:missing', name: 'Сирота' },
})
assert.equal(JSON.stringify(routes), snapshot, 'inputs are not mutated')
const editedById = new Map(edited.map(route => [route.id, route]))
const newPamir = editedById.get('ref:РБ04')
assert.equal(newPamir.name, 'Памирское шоссе'); assert.equal(newPamir.edited, true); assert.equal(newPamir.ref, 'РБ04')
assert.deepEqual(newPamir.ways.map(way => way.name), ['Памирское шоссе', 'улица Айни', 'улица Шарк', 'Памирское шоссе'], 'unnamed and same-name ways follow the road, city streets keep theirs, a way edit wins')
const hidden = editedById.get('ref:R-303')
assert.equal(hidden.ref, null); assert.equal(hidden.cls, 'none'); assert.equal(hidden.name, 'Роҳи шимолӣ'); assert.equal(hidden.edited, true)
assert.equal(editedById.get('ref:РҶ026'), byId.get('ref:РҶ026'), 'an untouched road is the same object')
const renumbered = applyRouteEdits(routes, { 'route/ref:РҶ026': { roadId: 'route/ref:РҶ026', ref: 'M41', name: '' } })[1]
assert.equal(renumbered.ref, 'M41'); assert.equal(renumbered.cls, 'intl'); assert.equal(renumbered.name, null)
const cleared = applyRouteEdits(routes, { 'route/ref:РБ04': { roadId: 'route/ref:РБ04', name: '' } })[0]
assert.deepEqual(cleared.ways.map(way => way.name), [null, 'улица Айни', null, null])
assert.equal(applyRouteEdits(routes, { 'route/ref:РБ04': { roadId: 'route/ref:РБ04', ref: 'M41' } })[0].refs.length, 0, 'the new number leaves the list of other numbers')

// --- places, shapes, index ---------------------------------------------------------------------
const place = routePlace(byId.get('ref:R-303'))
assert.equal(place.id, 'route:ref:R-303'); assert.equal(place.tags['atlas:type'], 'route'); assert.equal(place.tags['atlas:route-id'], 'ref:R-303')
assert.equal(place.tags.ref, 'R-303'); assert.equal(place.tags['name:ru'], 'R-303 · Роҳи шимолӣ')
assert.ok(place.tags['atlas:search'].split(' ').includes('r303'))
assert.ok(place.tags['addr:city'].startsWith('Таджикистан · '))
near(place.lat, 40.66, 1e-6, 'place on the road'); near(place.lon, 70.367, 1e-6, 'midpoint of the joined stretch')
const tappedName = routePlace(pamir, 'улица Айни', { lat: 38.5501, lon: 68.807 })
assert.equal(tappedName.tags['name:ru'], 'улица Айни'); assert.equal(tappedName.id, 'route:ref:РБ04|улица Айни'); assert.equal(tappedName.tags['atlas:route-name'], 'улица Айни')
assert.deepEqual([tappedName.lat, tappedName.lon], [38.5501, 68.807], 'the card sits where the name was tapped')
const tappedShield = routePlace(pamir, 'РБ04')
assert.equal(tappedShield.tags['name:ru'], 'РБ04 · Памирский тракт'); assert.equal(tappedShield.id, 'route:ref:РБ04'); assert.equal(tappedShield.tags['atlas:route-name'], undefined)
assert.deepEqual(tappedShield.tags, routePlace(pamir).tags, 'a shield tap is the search place of the road')
assert.equal(routePlace(byId.get('name:41')).tags.ref, undefined)
const shape = routeShape(pamir)
assert.equal(shape.type, 'MultiLineString'); assert.equal(shape.coordinates.length, 4)
assert.equal(routeShape(pamir, 'Памирский тракт').coordinates.length, 2, 'only the ways of the tapped name')
assert.equal(routeShape(pamir, 'нет такой').coordinates.length, 4)
const index = createRouteIndex(routes)
assert.equal(index.nearest(40.6601, 70.365, 50)?.id, 'ref:R-303')
assert.equal(index.nearest(40.7, 70.365, 50), null)
assert.equal(index.routeOfWay('way/242752039')?.id, 'ref:R-303')
assert.equal(index.routeOfWay('way/1'), null)

// --- chains -----------------------------------------------------------------------------------
assert.equal(buildChains([[[0, 0], [0.01, 0]], [[0.01, 0], [0.02, 0]], [[0.02, 0], [0.03, 0]]]).length, 1, 'consecutive pieces make one chain')
const reversed = buildChains([[[0, 0], [0.01, 0]], [[0.02, 0], [0.01, 0]], [[0.02, 0], [0.03, 0]]])
assert.equal(reversed.length, 1, 'a reversed piece is merged'); assert.equal(reversed[0].line.length, 4)
near(reversed[0].length, 0.03 * Math.PI / 180 * 6371008.8, 1, 'chain length in metres')
assert.equal(buildChains([[[0, 0], [0.01, 0]], [[0.01, 0], [0.02, 0]], [[0.01, 0], [0.01, 0.01]]]).length, 3, 'a Y junction splits into three')
const ring = buildChains([[[0, 0], [0.01, 0]], [[0.01, 0], [0.01, 0.01]], [[0.01, 0.01], [0, 0]]])
assert.equal(ring.length, 1, 'a ring is one chain'); assert.equal(ring[0].line.length, 4)
assert.equal(buildChains([[[0, 0]], []]).length, 0)

// --- anchors ----------------------------------------------------------------------------------
near(metersPerPixel(14, 0), 40075016.686 / (512 * 2 ** 14), 1e-9, 'metersPerPixel')
const longLine = Array.from({ length: 301 }, (_, i) => [66.5 + i * (300000 / 300) / (111320 * Math.cos(38.5 * Math.PI / 180)) * 1.0, 38.5])
const [long] = buildChains([longLine])
near(long.length, 300000, 600, 'test line is 300 km')
const anchors = anchorsAlong(long, 320, 14, 6)
const middle = anchors.find(anchor => Math.abs(anchor.s - long.length / 2) < 1)
assert.ok(middle && (middle.level === 6 || middle.level === 7), `middle anchor level ${middle?.level}`)
assert.ok(anchors.every((anchor, i) => i === 0 || anchors[i - 1].level <= anchor.level), 'anchors sorted by level')
for (let z = 8; z <= 14; z++) {
  const shown = anchors.filter(anchor => anchor.level <= z).map(anchor => anchor.s).sort((a, b) => a - b)
  const want = 320 * metersPerPixel(z, 38.5)
  for (let i = 1; i < shown.length; i++) near(shown[i] - shown[i - 1], want, want * 0.01, `anchor spacing at z${z}`)
}
const short = buildChains([[[70, 40], [70 + 200 / (111320 * Math.cos(40 * Math.PI / 180)), 40]]])[0]
assert.deepEqual(anchorsAlong(short, 320, 14, 6).map(anchor => anchor.level), [14], 'a 200 m stretch shows only close up')
assert.ok(anchorsAlong(long, 560, 18, 12.5).every(anchor => anchor.level >= 12.5 && anchor.level <= 18))
// A dual carriageway running north-south, 25 m apart: the second side adds no shields.
const side = offset => buildChains([Array.from({ length: 201 }, (_, i) => [69.5 + offset / (111320 * Math.cos(39 * Math.PI / 180)), 39 + i * 0.001])])[0]
const oneSide = anchorsAlong(side(0), 320, 14, 6)
const bothSides = [...oneSide, ...anchorsAlong(side(25), 320, 14, 6)].map(anchor => ({ anchor }))
assert.equal(thinAnchors(bothSides, 320, 14).length, oneSide.length, 'the other carriageway is thinned away')
const apart = [...oneSide, ...anchorsAlong(side(20000), 320, 14, 6)].map(anchor => ({ anchor }))
assert.equal(thinAnchors(apart, 320, 14).length, 2 * oneSide.length, 'a road 20 km away keeps its own shields')
const stacked = thinAnchors(oneSide.map(anchor => ({ anchor })), 320, 14)
assert.equal(stacked.length, oneSide.length, 'a single stretch keeps every anchor')
assert.equal(shieldMinZoom(pamir), 7); assert.equal(shieldMinZoom(byId.get('ref:R-303')), 10); assert.equal(shieldMinZoom(byId.get('ref:РҶ026')), 9)
assert.equal(shieldMinZoom(byId.get('name:41')), 99); assert.equal(nameMinZoom(pamir), 12.5); assert.equal(nameMinZoom(byId.get('ref:R-30')), 14.5)

// --- text along a line --------------------------------------------------------------------------
assert.equal(layoutAlong([{ x: 0, y: 100 }, { x: 40, y: 100 }, { x: 40, y: 60 }], [10, 10, 10, 10, 10]), null, 'a right angle under the text')
const flat = layoutAlong([{ x: 200, y: 50 }, { x: 150, y: 50 }, { x: 100, y: 50 }], [8, 8, 8])
assert.ok(flat, 'a straight line takes the text')
assert.ok(flat.every(glyph => Math.abs(glyph.angle - flat[0].angle) < 1e-9) && Math.abs(flat[0].angle) < 1e-9, 'right to left is reversed, one angle')
assert.ok(flat[0].x < flat[1].x && flat[1].x < flat[2].x, 'reads left to right')
near(flat[1].x, 150, 1e-9, 'text centred on the line')
assert.equal(layoutAlong([{ x: 0, y: 0 }, { x: 10, y: 0 }], [8, 8]), null, 'too short')
const gentle = layoutAlong([{ x: 0, y: 0 }, { x: 50, y: 10 }, { x: 100, y: 30 }], [10, 10, 10])
assert.ok(gentle && gentle[0].angle < gentle[2].angle, 'glyphs follow a gentle bend')
const curl = [0, 25, 50, 75].reduce((points, degrees) => { const last = points[points.length - 1]; return [...points, { x: last.x + 30 * Math.cos(degrees * Math.PI / 180), y: last.y + 30 * Math.sin(degrees * Math.PI / 180) }] }, [{ x: 0, y: 0 }])
assert.equal(layoutAlong(curl, [10, 10, 10, 10]), null, 'more than 60 degrees in all')
assert.ok(layoutAlong(curl.slice(0, 4), [10, 10, 10, 10]), 'up to 60 degrees in all is fine')

// --- the renderer, against a stand-in canvas ------------------------------------------------------
const calls = { drawImage: 0, fillText: 0, strokeText: 0 }
const stub = () => {
  const target = { getTransform: () => ({ a: 2 }), measureText: text => ({ width: [...String(text)].length * 6.5 }) }
  return new Proxy(target, { get: (object, key) => key in object ? object[key] : key in calls ? (() => { calls[key]++ }) : () => {}, set: () => true })
}
globalThis.document ??= { createElement: () => ({ width: 0, height: 0, getContext: () => stub() }) }
const highway = decodeRoadRoutes({ ...file, routes: [{ id: 'ref:M41', ref: 'M41', name: null, hw: 'trunk', km: 17, ways: [record(51, -1, 0, line(70.30, 40.70, 100))] }] })[0]
const labels = createRoadLabels()
labels.setRoutes([...routes, stroke, highway])
assert.equal(labels.covers('way/391146809'), true); assert.equal(labels.covers('way/77'), true); assert.equal(labels.covers('way/5'), false); assert.equal(labels.covers(undefined), false)
const frame = (zoom, lon, lat) => {
  const scale = 512 * 2 ** zoom / 360, width = 1000, height = 800
  const map = { project: ([x, y]) => ({ x: width / 2 + (x - lon) * scale, y: height / 2 - (y - lat) * scale / Math.cos(lat * Math.PI / 180) }) }
  const spanLon = width / 2 / scale, spanLat = height / 2 / scale * Math.cos(lat * Math.PI / 180)
  return { ctx: stub(), map, zoom, width, height, floor: 0, west: lon - spanLon, east: lon + spanLon, south: lat - spanLat, north: lat + spanLat, occupied: [], boxes: [] }
}
const shieldsAt = frame(14, 70.37, 40.66)
labels.drawShields(shieldsAt)
assert.equal(shieldsAt.boxes.length, 1, 'a 1 km road has one shield at z14')
assert.ok(shieldsAt.boxes.every(item => item.label.kind === 'route' && item.label.owner === 'ref:R-303' && item.label.name === 'R-303'))
assert.equal(calls.drawImage, 1)
const along = frame(14, 70.40, 40.70); labels.drawShields(along)
const spacing = along.boxes.map(item => (item.box[0] + item.box[2]) / 2).sort((a, b) => a - b)
assert.ok(spacing.length >= 3, `M41 shields at z14: ${spacing.length}`)
for (let i = 1; i < spacing.length; i++) near(spacing[i] - spacing[i - 1], 320, 4, 'shields 320 px apart on screen')
const out = frame(10, 70.40, 40.70); labels.drawShields(out)
assert.equal(out.boxes.length, 1, 'at zoom 10 the 17 km road has one shield')
const tooFar = frame(6, 70.40, 40.70); labels.drawShields(tooFar)
assert.equal(tooFar.boxes.length, 0, 'no shields below 6.5')
for (let i = 0; i < shieldsAt.boxes.length; i++) for (let j = i + 1; j < shieldsAt.boxes.length; j++) {
  const [a, b] = [shieldsAt.boxes[i].box, shieldsAt.boxes[j].box]
  assert.ok(!(a[0] < b[2] && a[2] > b[0] && a[1] < b[3] && a[3] > b[1]), 'shields never overlap')
}
const blocked = frame(14, 70.37, 40.66); blocked.occupied.push([0, 0, 1000, 800]); labels.drawShields(blocked)
assert.equal(blocked.boxes.length, 0, 'taken space is respected')
const far = frame(9, 70.37, 40.66); labels.drawShields(far)
assert.equal(far.boxes.length, 0, 'R-303 has no shield at zoom 9')
const namesAt = frame(16.5, 68.803, 38.55)
for (const key in calls) calls[key] = 0
labels.drawNames(namesAt)
assert.ok(namesAt.boxes.some(item => item.label.name === 'Памирский тракт' && item.label.owner === 'ref:РБ04'), 'name written along the road')
assert.ok(calls.fillText >= 'Памирский тракт'.length && calls.strokeText === calls.fillText, `every glyph has its halo: ${JSON.stringify(calls)}`)
const noNames = frame(12, 68.803, 38.55); labels.drawNames(noNames)
assert.equal(noNames.boxes.length, 0, 'no along-road names below 12.5')
const hiddenRoad = createRoadLabels(); hiddenRoad.setRoutes(applyRouteEdits(routes, { 'route/ref:R-303': { roadId: 'route/ref:R-303', ref: '' } }))
const none = frame(14, 70.37, 40.66); hiddenRoad.drawShields(none)
assert.equal(none.boxes.length, 0, 'a cleared number hides the shields')
console.log(`PASS: road refs, search, edits, places, chains, anchors, text layout and renderer (${Math.round(performance.now() - started)} ms)`)

// --- the builder on a fixture (optional) --------------------------------------------------------------
if (process.argv.includes('--builder')) {
  const dir = mkdtempSync(join(os.tmpdir(), 'road-routes-'))
  try {
    const nodes = {
      1: [70.360, 40.660], 2: [70.362, 40.660], 3: [70.364, 40.660], 4: [70.366, 40.660], 5: [70.367, 40.6605],
      10: [70.300, 40.600], 11: [70.302, 40.601], 12: [70.304, 40.602], 13: [70.306, 40.603], 14: [70.308, 40.604],
      20: [68.800, 38.550], 21: [68.805, 38.552], 22: [68.810, 38.554], 23: [68.815, 38.556], 24: [68.820, 38.558], 25: [68.825, 38.560],
      26: [68.700, 38.600], 27: [68.705, 38.600], 30: [69.000, 39.000], 31: [69.004, 39.000], 32: [69.010, 39.000], 33: [69.012, 39.001],
      50: [68.780, 38.570], 51: [68.782, 38.570], 52: [68.784, 38.570], 53: [68.785, 38.5705], 54: [68.787, 38.5705], 55: [69.600, 40.280], 56: [69.602, 40.280],
      60: [69.100, 39.100], 61: [69.102, 39.1001], 62: [69.104, 39.100], 63: [69.106, 39.1001], 64: [69.104, 39.103], 65: [69.108, 39.100],
      66: [69.200, 39.200], 67: [69.203, 39.200], 68: [69.300, 39.300],
    }
    const ways = [
      [101, 'secondary', [1, 2, 3], { ref: 'R-303', 'name:tg': 'Роҳи шимолӣ' }], [102, 'secondary', [3, 4], { ref: 'R303', 'name:tg': 'Роҳи шимолӣ' }],
      [103, 'secondary_link', [4, 5], { ref: 'Р-303' }], [201, 'primary', [10, 11, 12], { ref: 'РҶ026' }], [202, 'primary', [12, 13], { ref: 'РЧ026' }],
      [203, 'tertiary', [13, 14], { name: 'улица Ленина' }], [301, 'trunk', [20, 21], { ref: 'RB04', name: 'RB04 (M41)' }],
      [302, 'trunk', [21, 22, 23], { ref: 'РБ04;M41', name: 'Памирский тракт' }], [303, 'trunk', [23, 24], { ref: 'РБ04', 'name:ru': 'улица Айни', name: 'кӯчаи Айнӣ' }],
      [304, 'trunk', [24, 25], { name: 'РБ04' }], [305, 'trunk', [26, 27], { name: 'РБ01 (М34) Душанбе - Худжанд' }],
      [401, 'tertiary', [30, 31], { ref: 'РБ09;;РҶ053' }], [402, 'residential', [31, 32], { ref: 'Шагал', name: 'улица Шагал' }],
      [403, 'residential', [32, 33], { ref: 'D046' }], [404, 'footway', [30, 33], { ref: 'R-1' }], [405, 'residential', [33, 30], { ref: 'Old M41' }],
      [501, 'secondary', [50, 51], { 'name:ru': 'проспект Рудаки' }], [502, 'secondary', [51, 52], { name: 'Проспект  Рудаки' }],
      [503, 'secondary', [53, 54], { 'name:ru': 'проспект Рудаки' }], [504, 'secondary', [55, 56], { 'name:ru': 'проспект Рудаки' }],
      [601, 'primary', [60, 61, 62], {}], [602, 'primary', [62, 63], {}], [603, 'primary', [62, 64], {}], [604, 'tertiary', [63, 65], {}],
      [605, 'primary_link', [61, 64], {}], [606, 'primary', [66, 67], { oneway: '-1', bridge: 'yes' }], [607, 'primary', [68, 9999], {}],
      [608, 'pedestrian', [66, 68, 67, 66], { area: 'yes', name: 'площадь' }],
    ]
    const esc = text => String(text).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n<osm version="0.6" generator="check-road-routes">\n'
    for (const [id, [lon, lat]] of Object.entries(nodes)) xml += `<node id="${id}" version="1" lat="${lat}" lon="${lon}"/>\n`
    for (const [id, highway, refs, tags] of ways) xml += `<way id="${id}" version="1">${refs.map(ref => `<nd ref="${ref}"/>`).join('')}${Object.entries({ highway, ...tags }).map(([k, v]) => `<tag k="${esc(k)}" v="${esc(v)}"/>`).join('')}</way>\n`
    xml += '<relation id="9001" version="1"><member type="way" ref="201" role=""/><member type="way" ref="202" role=""/><member type="way" ref="203" role=""/><tag k="type" v="route"/><tag k="route" v="road"/><tag k="ref" v="РҶ026"/><tag k="name:ru" v="РҶ026 Бустон — Гафуров"/></relation>\n</osm>\n'
    writeFileSync(join(dir, 'fixture.osm'), xml)
    const python = process.platform === 'win32' ? 'python' : 'python3'
    execFileSync(python, [join(root, 'scripts/build-road-routes.py'), join(dir, 'fixture.osm'), dir, '--date', '12.09.2026'], { stdio: 'pipe', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    const built = JSON.parse(readFileSync(join(dir, 'road-routes.json'), 'utf8'))
    const extra = JSON.parse(readFileSync(join(dir, 'road-routes-extra.json'), 'utf8'))
    assert.equal(built.kind, 'labelled'); assert.equal(extra.kind, 'extra'); assert.equal(built.source, 'OpenStreetMap contributors, Geofabrik extract of 12.09.2026')
    const got = new Map(built.routes.map(route => [route.id, route]))
    const wayIds = id => got.get(id)?.ways.map(way => way[0])
    assert.deepEqual([...got.keys()], ['ref:РБ01', 'ref:РБ04', 'ref:РБ09', 'ref:РҶ026', 'ref:R-303', 'ref:D046', 'name:501', 'name:504'], 'routes, national roads first')
    assert.deepEqual(wayIds('ref:R-303'), [101, 102, 103], 'R-303, R303 and Р-303 are one road')
    assert.equal(got.get('ref:R-303').hw, 'secondary'); assert.equal(got.get('ref:R-303').name, 'Роҳи шимолӣ')
    assert.equal(got.get('ref:R-303').ways[2][2] & 2, 2, 'link flag')
    assert.deepEqual(wayIds('ref:РҶ026'), [201, 202, 203], 'РЧ026 is РҶ026; relation members join')
    assert.equal(got.get('ref:РҶ026').name, 'Бустон — Гафуров', 'relation name without its number')
    assert.deepEqual(wayIds('ref:РБ04'), [301, 302, 303, 304]); assert.deepEqual(got.get('ref:РБ04').refs, ['M41'])
    assert.equal(got.get('ref:РБ04').name, 'Памирский тракт'); assert.equal(got.get('ref:РБ04').hw, 'trunk')
    const names = built.names, wayName = (route, id) => { const way = got.get(route).ways.find(w => w[0] === id); return way[1] < 0 ? null : names[way[1]] }
    assert.equal(wayName('ref:РБ04', 301), null, "'RB04 (M41)' is not a name"); assert.equal(wayName('ref:РБ04', 303), 'улица Айни', 'name:ru first')
    assert.equal(wayName('ref:РБ04', 304), null)
    assert.deepEqual(got.get('ref:РБ01').refs, ['M34']); assert.equal(got.get('ref:РБ01').name, 'Душанбе - Худжанд', 'numbers at the start of a name')
    assert.deepEqual(got.get('ref:РБ09').refs, ['РҶ053'])
    assert.ok(!got.has('ref:Шагал') && !built.routes.some(route => /Old|R-1$/.test(route.id)), 'junk refs and footways dropped')
    assert.deepEqual(wayIds('name:501'), [501, 502, 503], 'same-name pieces within 120 m join'); assert.deepEqual(wayIds('name:504'), [504], 'a namesake far away stays apart')
    assert.deepEqual(new Set(got.get('name:501').ways.map(way => way[1])).size, 1, 'one spelling per road')
    const strokes = new Map(extra.routes.map(route => [route.id, route.ways.map(way => way[0])]))
    assert.deepEqual(strokes.get('way:601'), [601, 602], 'straight continuation joins'); assert.deepEqual(strokes.get('way:603'), [603], 'a right-angle turn does not')
    assert.deepEqual(strokes.get('way:604'), [604], 'classes do not mix'); assert.ok(!strokes.has('way:605') && !strokes.has('way:607'), 'links and broken ways left out')
    const reversedWay = extra.routes.find(route => route.id === 'way:606').ways[0]
    assert.equal(reversedWay[2], 9, 'one-way and bridge flags'); assert.equal(reversedWay[3], 6920300, 'oneway=-1 runs in its direction of travel')
    for (const route of [...built.routes, ...extra.routes]) for (const way of route.ways) assert.ok(way.length >= 7 && (way.length - 3) % 2 === 0)
    const decoded = decodeRoadRoutes(built)
    assert.equal(findRoutes(decoded, 'r303')[0].id, 'ref:R-303'); assert.equal(findRoutes(decoded, 'рб 4')[0].id, 'ref:РБ04')
    console.log('PASS: builder on the .osm fixture (refs, relations, names, strokes, flags)')
  } finally { rmSync(dir, { recursive: true, force: true }) }
}

// --- the real data (after python scripts/build-road-routes.py ..\tajikistan.osm.pbf public) --------------
const dataFile = resolve(root, 'public/road-routes.json')
if (!existsSync(dataFile)) {
  console.log('SKIP: public/road-routes.json is not built yet — run python scripts/build-road-routes.py ..\\tajikistan.osm.pbf public')
} else {
  const data = JSON.parse(readFileSync(dataFile, 'utf8'))
  assert.equal(data.version, 1); assert.equal(data.kind, 'labelled'); assert.equal(data.scale, 100000)
  assert.ok(statSync(dataFile).size <= 1_000_000, `road-routes.json is ${statSync(dataFile).size} bytes (limit 1 MB)`)
  const ids = new Set()
  for (const route of data.routes) {
    assert.match(route.id, /^(ref|name|way):[\p{L}\p{N}_.:-]+$/u); assert.ok(!ids.has(route.id), `duplicate ${route.id}`); ids.add(route.id)
    assert.ok(!route.ref || !/^RB|^РЧ/.test(route.ref), `canonical ref ${route.ref}`)
    assert.ok(!route.name || refClass(route.name) === 'foreign' ? true : !/^(RB|РБ|РҶ|M|AH|E|R-)\d/.test(route.name), `ref-like name ${route.name}`)
    assert.ok(!route.name || !(route.ref && refKey(route.name) === refKey(route.ref)), `name repeats the number: ${route.name}`)
    for (const way of route.ways) {
      assert.ok(way.length >= 7 && (way.length - 3) % 2 === 0, `way record ${way[0]}`)
      assert.ok(way[1] >= -1 && way[1] < data.names.length, `name index of way ${way[0]}`)
      let x = way[3], y = way[4]
      for (let i = 3; i < way.length; i += 2) {
        if (i > 3) { x += way[i]; y += way[i + 1] }
        assert.ok(x >= 6600000 && x <= 7600000 && y >= 3500000 && y <= 4200000, `way ${way[0]} inside Tajikistan`)
      }
    }
  }
  const real = decodeRoadRoutes(data)
  const realById = new Map(real.map(route => [route.id, route]))
  const shaydon = realById.get('ref:R-303')
  assert.ok(shaydon, 'ref:R-303 exists'); assert.equal(shaydon.hw, 'secondary')
  for (const id of [391146809, 242752039, 320961543, 799241162, 799241168, 1148935962, 1148935963, 1369363488]) assert.ok(shaydon.ways.some(way => way.id === `way/${id}`), `R-303 has way/${id}`)
  assert.ok((realById.get('ref:РБ04')?.km ?? 0) >= 700, 'РБ04 is at least 700 km')
  const streetsFile = resolve(root, 'public/streets.json')
  if (existsSync(streetsFile)) {
    const typo = JSON.parse(readFileSync(streetsFile, 'utf8')).roads.filter(road => /РЧ\s*-?0*26\b/.test(road.ref || '')).map(road => road.id)
    const rj26 = new Set(realById.get('ref:РҶ026')?.ways.map(way => way.id))
    assert.ok(typo.every(id => rj26.has(id)), `РЧ026 ways are in РҶ026: ${typo.filter(id => !rj26.has(id))}`)
  }
  const classes = real.reduce((count, route) => ({ ...count, [route.cls]: (count[route.cls] ?? 0) + 1 }), {})
  assert.ok(real.filter(route => route.ref).length >= 150 && classes.rb >= 15, `ref routes ${JSON.stringify(classes)}`)
  for (const query of ['R303', 'r-303', 'Р-303']) assert.equal(findRoutes(real, query)[0]?.id, 'ref:R-303', `real search ${query}`)
  assert.equal(findRoutes(real, 'рб 4')[0]?.id, 'ref:РБ04')
  assert.ok(findRoutes(real, 'Памирский').some(route => route.id === 'ref:РБ04'), 'real search Памирский')
  const t0 = performance.now(); const realLabels = createRoadLabels(); realLabels.setRoutes(real); const setupMs = performance.now() - t0
  assert.ok(realLabels.covers('way/391146809'))
  const t1 = performance.now(); const dushanbe = frame(13, 68.78, 38.56); realLabels.drawShields(dushanbe); realLabels.drawNames(frame(16, 68.78, 38.56)); const drawMs = performance.now() - t1
  const extraFile = resolve(root, 'public/road-routes-extra.json')
  if (existsSync(extraFile)) {
    assert.ok(statSync(extraFile).size <= 1_500_000, 'road-routes-extra.json at most 1.5 MB')
    const extraData = JSON.parse(readFileSync(extraFile, 'utf8'))
    assert.equal(extraData.kind, 'extra'); assert.ok(extraData.routes.every(route => route.id.startsWith('way:') && !route.ref))
  }
  console.log(`PASS: real data — ${real.length} roads ${JSON.stringify(classes)}, ${data.routes.reduce((n, r) => n + r.ways.length, 0)} ways, ${statSync(dataFile).size} bytes; label setup ${Math.round(setupMs)} ms, a frame ${drawMs.toFixed(1)} ms`)
}
