/* Place pictograms: every place in public/places.json gets a grey disc with a fitting white
 * pictogram, the glyph data is complete and safe to draw, the discs grow with zoom, minor
 * places wait for closer zooms, and the overlay names only the discs MapLibre kept.
 *
 *   node scripts/check-poi-icons.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { featureFilter, validateStyleMin } from '@maplibre/maplibre-gl-style-spec'
import { POI_BOX, POI_DISC, POI_ICON_NAMES, POI_IMAGE_PREFIX, POI_MINZOOM, POI_RANK_FILTER, poiIconScale, poiIconSizeExpression, poiLabelOffset, poiNearby, poiRadius, poiStyle } from '../lib/poi-icons.mjs'
import { GLYPHS, GLYPH_SOURCE } from '../lib/poi-glyphs.mjs'
import { toPath } from './build-poi-glyphs.mjs'
import { glyphOf, poiIconBoxes, poiPinSvg, poiPlacement } from '../lib/poi-draw.ts'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const places = JSON.parse(readFileSync(resolve(root, 'public/places.json'), 'utf8'))

// Glyphs: one for every pictogram the tables can name, made only of SVG path commands.
const PATH = /^[Mm][\sMmLlHhVvCcSsQqTtAaZz0-9.,eE+-]*$/
assert.match(GLYPH_SOURCE, /^lucide-react \d+\.\d+\.\d+$/)
for (const name of POI_ICON_NAMES) {
  const glyph = GLYPHS[name]
  assert.ok(glyph && glyph.s.length + (glyph.f?.length ?? 0) > 0, `no glyph for ${name}`)
  for (const d of [...glyph.s, ...(glyph.f ?? [])]) assert.match(d, PATH, `${name}: ${d}`)
}
assert.deepEqual([...POI_ICON_NAMES], [...new Set(POI_ICON_NAMES)].sort(), 'icon names are unique and sorted')
assert.deepEqual(Object.keys(GLYPHS).sort(), [...POI_ICON_NAMES], 'lib/poi-glyphs.mjs is up to date: run node scripts/build-poi-glyphs.mjs')

// The generator's shape conversions.
assert.equal(toPath('circle', { cx: '12', cy: '10', r: '3' }), 'M9 10a3 3 0 1 0 6 0a3 3 0 1 0 -6 0Z')
assert.equal(toPath('line', { x1: '2', y1: '3', x2: '20', y2: '3' }), 'M2 3L20 3')
assert.equal(toPath('polyline', { points: '3 6 9 12 3 18' }), 'M3 6L9 12L3 18')
assert.equal(toPath('polygon', { points: '1,2 3,4 5,6' }), 'M1 2L3 4L5 6Z')
assert.equal(toPath('rect', { width: '20', height: '14', x: '2', y: '5' }), 'M2 5h20v14h-20Z')
assert.equal(toPath('rect', { width: '20', height: '14', x: '2', y: '5', rx: '2' }),
  'M4 5h16a2 2 0 0 1 2 2v10a2 2 0 0 1 -2 2h-16a2 2 0 0 1 -2 -2v-10a2 2 0 0 1 2 -2Z')
assert.throws(() => toPath('text', {}), /unsupported/)

// Every place gets a drawable pictogram; almost none fall back to the plain pin.
const counts = new Map(), ranks = [0, 0, 0, 0, 0]
let pins = 0
for (const place of places) {
  const { icon, rank } = poiStyle(place.id, place.tags)
  assert.ok(GLYPHS[icon], `${place.id}: no glyph for ${icon}`)
  assert.ok(Number.isInteger(rank) && rank >= 0 && rank <= 4, `${place.id}: rank ${rank}`)
  counts.set(icon, (counts.get(icon) ?? 0) + 1)
  ranks[rank]++
  if (icon === 'map-pin') pins++
}
assert.ok(pins <= 3, `${pins} places fell back to the map pin`)
assert.ok(counts.size >= 100, `only ${counts.size} distinct pictograms`)
assert.ok(ranks[1] > 0 && ranks[2] > ranks[1] && ranks[4] > 0 && ranks[4] < places.length / 10, `rank spread ${ranks}`)

const icon = (tags, id = 'node/1') => poiStyle(id, tags).icon
const rank = (tags, id = 'node/1') => poiStyle(id, tags).rank
assert.equal(icon({ amenity: 'theatre' }), 'drama')
assert.equal(icon({ shop: 'convenience' }), 'shopping-basket')
assert.equal(icon({ shop: 'supermarket' }), 'shopping-cart')
assert.equal(icon({ amenity: 'pharmacy' }), 'pill')
assert.equal(icon({ amenity: 'pharmacy', shop: 'convenience' }), 'pill', 'amenity wins over shop')
assert.equal(icon({ amenity: 'place_of_worship', religion: 'muslim' }), 'mosque')
assert.equal(icon({ amenity: 'place_of_worship', religion: 'christian' }), 'church')
assert.equal(icon({ amenity: 'place_of_worship', religion: 'zoroastrian' }), 'flame')
assert.equal(icon({ amenity: 'place_of_worship' }), 'mosque')
assert.equal(icon({ amenity: 'dentist' }), 'tooth')
assert.equal(icon({ healthcare: 'laboratory' }), 'flask-conical')
assert.equal(icon({ tourism: 'hotel' }), 'bed-double')
assert.equal(icon({ amenity: 'fuel' }), 'fuel')
assert.equal(icon({ amenity: 'bank' }), 'banknote')
assert.equal(icon({ amenity: 'cafe' }), 'coffee')
assert.equal(icon({ amenity: 'school' }), 'school')
assert.equal(icon({ amenity: 'hospital' }), 'hospital')
assert.equal(icon({ shop: 'reebok' }), 'shopping-bag', 'an unknown shop is a shopping bag')
assert.equal(icon({ shop: 'no', tourism: 'hotel' }), 'bed-double')
assert.equal(icon({ tourism: 'yes' }), 'star')
assert.equal(icon({ amenity: 'fixme' }), 'map-pin')
assert.equal(icon({ amenity: 'constructor' }), 'map-pin', 'table lookups ignore Object.prototype')
assert.equal(icon({ tourism: 'attraction', historic: 'castle' }), 'castle')
assert.equal(icon({ amenity: 'school', historic: 'memorial' }), 'school', 'a historic school is still a school')
assert.equal(icon({ historic: 'memorial' }), 'landmark')
assert.equal(icon({ leisure: 'stadium' }), 'volleyball')
assert.equal(icon({ 'atlas:type': 'business', 'atlas:category': 'shop' }, 'business:1'), 'shopping-bag')
assert.equal(icon({ 'atlas:type': 'business', 'atlas:category': 'service' }, 'business:1'), 'briefcase')
assert.equal(icon({ 'atlas:type': 'business', 'atlas:category': 'nonsense' }, 'business:1'), 'building-2')
assert.equal(icon({ 'atlas:type': 'street', name: 'кӯчаи Рӯдакӣ' }, 'street:1'), 'signpost')
assert.equal(icon({ 'atlas:type': 'district' }, 'district:1'), 'map-pinned')
assert.equal(icon({ 'atlas:type': 'route', ref: 'R-303' }, 'route:r303'), 'route')
assert.equal(icon({ 'atlas:type': 'house' }, 'house:1'), 'house')
assert.equal(icon({}, 'house:ms:1'), 'house')
assert.equal(icon({ name: 'Точка на карте' }, 'point:38.5,68.7'), 'map-pin')
assert.equal(icon({ name: 'Сино', 'atlas:type': 'label' }, 'label:district:38.5,68.7'), 'map-pin')
assert.equal(icon({ 'atlas:type': 'landmark', leisure: 'stadium' }, 'way/1076243310'), 'volleyball')
assert.deepEqual(poiStyle('x', null), { icon: 'map-pin', rank: 4 })

// Ranks: lower is more important.
assert.equal(rank({ 'atlas:type': 'business', 'atlas:category': 'food' }, 'business:1'), 0)
assert.equal(rank({ amenity: 'hospital' }), 1)
assert.equal(rank({ shop: 'mall' }), 1)
assert.equal(rank({ 'atlas:type': 'landmark', leisure: 'stadium' }), 1)
assert.equal(rank({ amenity: 'cafe' }), 2)
assert.equal(rank({ amenity: 'place_of_worship' }), 2)
assert.equal(rank({ shop: 'convenience' }), 3)
assert.equal(rank({ amenity: 'atm' }), 4)
assert.equal(rank({ amenity: 'shelter' }), 4)

// The map's places: the nearest ones, plus the nearest important ones further out.
const row = [
  { id: 'n1', lat: 38.5, lon: 68.001, tags: { shop: 'convenience' } },
  { id: 'n2', lat: 38.5, lon: 68.002, tags: { amenity: 'atm' } },
  { id: 'far-shop', lat: 38.5, lon: 68.01, tags: { shop: 'convenience' } },
  { id: 'far-hospital', lat: 38.5, lon: 68.02, tags: { amenity: 'hospital' } },
  { id: 'far-museum', lat: 38.5, lon: 68.03, tags: { tourism: 'museum' } },
  { id: 'far-business', lat: 38.5, lon: 68.04, tags: { 'atlas:type': 'business', 'atlas:category': 'food' } },
]
assert.deepEqual(poiNearby(row.slice().reverse(), 68, 38.5, 2, 2).map(place => place.id), ['n1', 'n2', 'far-hospital', 'far-museum'])
assert.deepEqual(poiNearby(row, 68, 38.5, 2, 0).map(place => place.id), ['n1', 'n2'])
assert.deepEqual(poiNearby(row, 68, 38.5).map(place => place.id), row.map(place => place.id))
assert.equal(poiNearby([], 68, 38.5).length, 0)
{
  const started = performance.now(), dushanbe = poiNearby(places, 68.78, 38.57)
  const extra = dushanbe.slice(300)
  assert.equal(dushanbe.length, 400, 'Dushanbe has 100 more important places beyond the nearest 300')
  assert.ok(extra.every(place => poiStyle(place.id, place.tags).rank <= 1))
  assert.ok(performance.now() - started < 1000, 'fast enough to run on every map move')
}

// Sizes: a small disc far out, full size from zoom 18, the name just under the disc.
assert.equal(poiIconScale(12), 0.6)
assert.equal(poiIconScale(18), 1)
assert.equal(poiIconScale(5), 0.6)
assert.equal(poiIconScale(22), 1)
assert.ok(Math.abs(poiIconScale(13) - 0.66) < 1e-9 && Math.abs(poiIconScale(17) - 0.93) < 1e-9)
for (let z = 10; z < 20; z += 0.25) assert.ok(poiIconScale(z + 0.25) >= poiIconScale(z), `icon size shrinks at ${z}`)
assert.equal(poiLabelOffset(18), 21.5)
assert.equal(poiRadius(18), POI_DISC.outer)
assert.deepEqual(poiIconSizeExpression(), ['interpolate', ['linear'], ['zoom'], 12, 0.6, 14, 0.72, 16, 0.86, 18, 1])
assert.ok(POI_DISC.cy + POI_DISC.outer + 2.5 <= POI_BOX && POI_DISC.cy - POI_DISC.outer - 1 >= 0, 'the disc and its shadow fit the image box')
// The name's text starts below the disc at every zoom, so its own disc never pushes it away.
for (let z = POI_MINZOOM; z <= 19; z += 0.5) {
  const scale = poiIconScale(z), discBottom = scale * (POI_DISC.cy - POI_BOX / 2 + POI_DISC.outer)
  assert.ok(poiLabelOffset(z) - 13 / 2 - discBottom >= 1.99, `name overlaps its disc at ${z}`)
  assert.ok(poiLabelOffset(z) - 15 / 2 >= poiRadius(z), `a place name box (font + 2) reaches into its disc box at ${z}`)
}

// Zoom thinning: majors from 12, the common kinds from 14, everything from 15; focus (-1) always.
const passes = (rankValue, zoom) => featureFilter(POI_RANK_FILTER).filter({ zoom }, { type: 1, properties: { rank: rankValue }, geometry: [] })
assert.ok(passes(1, 12) && passes(0, 13) && passes(-1, 12))
assert.ok(!passes(2, 13) && passes(2, 14) && passes(2, 15))
assert.ok(!passes(3, 14) && passes(3, 15))
assert.ok(!passes(4, 14) && passes(4, 15) && passes(4, 19))

// The layer the map adds validates against the style spec.
const layer = {
  id: 'points', type: 'symbol', source: 'points', minzoom: POI_MINZOOM, filter: POI_RANK_FILTER,
  layout: {
    'icon-image': ['get', 'icon'], 'icon-size': poiIconSizeExpression(), 'icon-anchor': 'center',
    'icon-allow-overlap': false, 'icon-ignore-placement': false, 'icon-padding': 1,
    'symbol-sort-key': ['get', 'rank'], 'symbol-z-order': 'auto',
    'icon-pitch-alignment': 'viewport', 'icon-rotation-alignment': 'viewport',
  },
  paint: { 'icon-opacity': ['case', ['boolean', ['get', 'focus'], false], 0, 1] },
}
const style = { version: 8, sources: { points: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } } }, layers: [layer] }
assert.deepEqual(validateStyleMin(style).map(error => error.message), [])
assert.equal(POI_IMAGE_PREFIX, 'poi:')

// The destination pin carries the white pictogram; a bare point keeps the plain pin.
const plain = poiPinSvg(null)
assert.match(plain, /^<svg class="selection-pin" viewBox="0 0 40 50" aria-hidden="true"><path d="M20 2C9 2[^"]*" fill="#087fe9" stroke="white" stroke-width="3"\/><\/svg>$/)
assert.equal(poiPinSvg('map-pin'), plain)
assert.equal(poiPinSvg('no-such-icon'), plain)
assert.equal(poiPinSvg('constructor'), plain)
assert.ok(glyphOf('pill') === GLYPHS.pill && !glyphOf('toString') && !glyphOf('') && !glyphOf(null))
const pill = poiPinSvg('pill')
assert.ok(pill.startsWith(plain.slice(0, -6)) && pill.endsWith('</g></svg>'))
assert.equal((pill.match(/<path /g) ?? []).length, 1 + GLYPHS.pill.s.length + (GLYPHS.pill.f?.length ?? 0))
assert.match(pill, /<g transform="translate\(11 11\) scale\(\.75\)" fill="none" stroke="#fff"/)
assert.equal((poiPinSvg('palette').match(/fill="#fff"/g) ?? []).length, GLYPHS.palette.f.length, 'filled parts are filled')

// The overlay names only the discs MapLibre drew, and keeps other labels off them.
let drawn = [{ properties: { id: 'a' } }, { properties: { id: 'b' } }], queries = 0
const fakeMap = {
  getLayer: id => id === 'points' ? {} : undefined,
  queryRenderedFeatures: () => { queries++; return drawn },
  project: ([lon, lat]) => ({ x: lon * 100, y: lat * 100 }),
  getCanvas: () => ({ clientWidth: 400, clientHeight: 300 }),
}
const placement = poiPlacement(fakeMap)
assert.equal(placement.refresh(), true)
assert.ok(placement.has('a') && placement.has('b') && !placement.has('c') && !placement.has(undefined))
assert.equal(placement.refresh(), false, 'throttled')
assert.equal(queries, 1)
assert.equal(placement.refresh(true), false, 'same discs: nothing changed')
drawn = [{ properties: { id: 'a' } }, { properties: { id: 'c' } }]
assert.equal(placement.refresh(true), true)
assert.ok(placement.has('c') && !placement.has('b'))
placement.stale()
drawn = [{ properties: { id: 'a' } }, { properties: { id: 'c' } }, { properties: { id: 7 } }]
assert.equal(placement.refresh(), true, 'stale data reads again at once')
assert.ok(placement.has('7'))
const r = poiRadius(18)
assert.deepEqual(poiIconBoxes(fakeMap, [
  { lon: 1, lat: 1, owner: 'a' }, { lon: 2, lat: 2, owner: 'b' }, { lon: 3, lat: 2, owner: 'c' }, { lon: 50, lat: 1, owner: '7' }, { lon: 1, lat: 1 },
], placement, 18), [[100 - r, 100 - r, 100 + r, 100 + r], [300 - r, 200 - r, 300 + r, 200 + r]])
assert.deepEqual(poiIconBoxes(fakeMap, [{ lon: 1, lat: 1, owner: 'a' }, { lon: 3, lat: 2, owner: 'c' }], placement, 18, { width: 200, height: 300 }),
  [[100 - r, 100 - r, 100 + r, 100 + r]], 'a view size given by the caller')
const broken = poiPlacement({ getLayer: () => ({}), queryRenderedFeatures: () => { throw new Error('style gone') } })
assert.equal(broken.refresh(true), false)

console.log(`PASS: ${places.length} places drawn with ${counts.size} of ${POI_ICON_NAMES.length} pictograms from ${GLYPH_SOURCE} (${pins} on the plain pin), ranks 0–4: ${ranks.join(' / ')}; disc sizes, name offsets, zoom thinning, the style layer, the destination pin and the overlay's disc tracking all check out.`)
