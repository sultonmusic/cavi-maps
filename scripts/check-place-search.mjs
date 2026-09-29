// Checks the search (lib/place-search.ts), the place kinds and the town list on hand-made cases and
// on the real places, streets and settlement names in public/.
//   node scripts/check-place-search.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { fold, loose, refKey, isRefQuery, coordinateQuery, plural, distanceLabel, metersBetween, indexPlaces, settlementPlaces, searchPlaces, prepareSearch } from '../lib/place-search.ts';
import { kindLabel, chipOf, kindKey, focusZoom, CHIPS, KINDS } from '../lib/place-kinds.mjs';
import { CITIES, REGIONS, COUNTRY, cityAt, cityByName, nearestCity, inCity } from '../lib/cities.mjs';

const pub = file => fileURLToPath(new URL(`../public/${file}`, import.meta.url));
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++ };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ };

// ---- units -------------------------------------------------------------------------------
for (const v of ['Р-303', 'R 303', 'r303', 'р303']) eq(refKey(v), 'R303', `refKey(${v})`);
for (const v of ['РБ04', 'RB4', 'rb 04', 'рб-4']) eq(refKey(v), 'RB4', `refKey(${v}): leading zeros do not count`);
eq(refKey('РҶ068'), 'RJ68', 'refKey(РҶ068)');
eq(refKey('рч 68'), 'RJ68', 'a Russian Ч typed for Ҷ');
eq(refKey('M41'), 'M41', 'refKey(M41)');
eq(fold('Ҳисор'), 'хисор', 'fold Tajik letters');
eq(fold('R-303'), 'r 303', 'fold punctuation');
eq(fold('Ёвон  «Хуҷанд»'), 'евон худжанд'.replace('дж', 'ч'), 'fold ё and ҷ');
eq(fold("Xo'jand"), 'xojand', 'fold drops apostrophes');
eq(fold('Göreme Şehir'), 'goreme sehir', 'fold drops Latin accents');
eq(loose(fold('Рудаки')), loose(fold('Rudaki')), 'Latin skeleton of Рудаки and Rudaki');
eq(loose(fold('Худжанд')), loose(fold('Khujand')), 'Latin skeleton of Худжанд and Khujand');
ok(isRefQuery('R-303') && isRefQuery('р303') && isRefQuery('rb 04') && isRefQuery('М41'), 'isRefQuery');
ok(!isRefQuery('аптека') && !isRefQuery('Рудаки 12а дом'), 'isRefQuery rejects words');
eq(['место', 'места', 'мест', 'мест', 'место', 'места'], [1, 2, 5, 11, 21, 104].map(n => plural(n, 'место', 'места', 'мест')), 'plural');
eq(distanceLabel(350), '350 м', 'distanceLabel 350');
eq(distanceLabel(1234), '1,2 км', 'distanceLabel 1234');
eq(distanceLabel(23456), '23 км', 'distanceLabel 23456');
eq(distanceLabel(996), '1,0 км', 'distanceLabel rounds up to a kilometre');
eq(distanceLabel(9990), '10 км', 'distanceLabel at 10 km');
eq(coordinateQuery('40.2824, 69.6227'), { lat: 40.2824, lon: 69.6227 }, 'coordinates');
eq(coordinateQuery('69.6227, 40.2824'), { lat: 40.2824, lon: 69.6227 }, 'coordinates written longitude first');
eq(coordinateQuery('кафе'), null, 'not coordinates');
ok(Math.abs(metersBetween({ lat: 40, lon: 69 }, { lat: 40.01, lon: 69 }) - 1112) < 3, 'metersBetween');

eq(kindLabel({ amenity: 'pharmacy' }), 'Аптека', 'kindLabel pharmacy');
eq(kindLabel({ shop: 'convenience' }), 'Продукты', 'kindLabel convenience');
eq(kindLabel({ shop: 'something_new' }), 'Магазин', 'kindLabel unknown shop');
eq(kindLabel({ amenity: 'place_of_worship', religion: 'christian' }), 'Церковь', 'kindLabel church');
eq(kindLabel({ 'atlas:type': 'business', 'atlas:category': 'hotel' }), 'Отель', 'kindLabel business');
eq(chipOf({ amenity: 'atm' }), 'bank', 'chipOf atm');
eq(chipOf({ shop: 'convenience' }), 'shop', 'chipOf convenience');
eq(chipOf({ 'atlas:type': 'business', 'atlas:category': 'food' }), 'food', 'chipOf food business');
eq(chipOf({ 'atlas:type': 'business', 'atlas:category': 'service' }), 'all', 'chipOf service business');
eq(chipOf({ amenity: 'school' }), 'edu', 'chipOf school');
eq(chipOf({ amenity: 'place_of_worship' }), 'all', 'chipOf mosque');
eq(kindKey({ 'atlas:type': 'business', 'atlas:category': 'food' }), 'business:food', 'kindKey business');
eq(focusZoom({ 'atlas:type': 'label', 'atlas:place': 'city' }), 12, 'focusZoom city');
eq(focusZoom({ 'atlas:type': 'street' }), 16, 'focusZoom street');
eq(focusZoom({ amenity: 'cafe' }), 17, 'focusZoom place');
const chipIds = new Set(CHIPS.map(([id]) => id));
ok(Object.values(KINDS).every(([label, chip]) => label && (chip === '' || chipIds.has(chip))), 'KINDS chips are chip ids');

eq(CITIES.length, 32, 'the country and 31 towns');
eq(COUNTRY.name, 'Таджикистан', 'the country comes first');
eq(new Set(CITIES.map(c => c.region)).size, REGIONS.length, 'five regions');
ok(CITIES.every(c => REGIONS.includes(c.region)), 'every town in a known region');
eq(cityAt(40.66, 70.36)?.name, 'Шайдон', 'cityAt Shaydon');
eq(cityAt(38.58, 68.78)?.name, 'Душанбе', 'cityAt Dushanbe');
eq(cityAt(39.5, 72.5), null, 'cityAt nowhere');
eq(cityAt(38.561, 69.017)?.name, 'Вахдат', 'cityAt Vahdat next to Dushanbe');
eq(nearestCity(40.3, 69.63)?.city.name, 'Худжанд', 'nearestCity');
ok(inCity(cityByName('Худжанд'), 40.3, 69.65) && !inCity(cityByName('Худжанд'), 40.5, 69.65), 'inCity');

// Whole roads as lib/road-routes.ts routePlace() makes them: the number, then the road's own name.
const routeSample = [
  { id: 'route:w1', lat: 40.55, lon: 70.2, tags: { name: 'R-303 · Роҳи шимолӣ', 'name:ru': 'R-303 · Роҳи шимолӣ', 'atlas:type': 'route', 'atlas:route-id': 'w1', ref: 'R-303', 'atlas:search': 'r-303 r303 р-303 р303 r 303 р 303 Роҳи шимолӣ', 'addr:city': 'Таджикистан · 120 км' } },
  { id: 'route:w2', lat: 38.9, lon: 69.1, tags: { name: 'РБ04 · Душанбе — Худжанд', 'name:ru': 'РБ04 · Душанбе — Худжанд', 'atlas:type': 'route', 'atlas:route-id': 'w2', ref: 'РБ04', 'atlas:search': 'рб04 rb04 rb4 рб4 rb 04 рб 04 Душанбе — Худжанд', 'addr:city': 'Таджикистан · 340 км' } },
  { id: 'street:s1', lat: 40.66, lon: 70.36, tags: { name: 'Роҳи шимолӣ', 'name:ru': 'Роҳи шимолӣ', highway: 'primary', ref: 'R-303', 'atlas:type': 'street', 'addr:city': 'Шайдон' } },
  { id: 'node/1', lat: 40.66, lon: 70.36, tags: { name: 'Кафе у дороги', amenity: 'cafe' } },
];
const routeEntries = indexPlaces(routeSample);
const find = query => searchPlaces(routeEntries, { query, chip: 'all', savedOnly: null, city: null, centre: { lat: 40.66, lon: 70.36 } }).map(p => p.id);
for (const q of ['R-303', 'р303', 'r 303']) eq(find(q)[0], 'route:w1', `${q}: the whole road comes first`);
eq(find('рохи шимоли').slice(0, 2), ['route:w1', 'street:s1'], 'a road found by its name comes before its stretches');
eq(find('Роҳи')[0], 'route:w1', 'and by the start of its name');
for (const q of ['rb 04', 'РБ4', 'rb4']) eq(find(q)[0], 'route:w2', `${q} finds РБ04`);
ok(!searchPlaces(routeEntries, { query: '', chip: 'all', savedOnly: null, city: null, centre: { lat: 40.66, lon: 70.36 } }).some(p => p.id.startsWith('route:')), 'roads are not listed while browsing');
// A place rebuilt by a live edit is searched by its new text, not by the text cached for its old self.
const cafe = { id: 'node/77', lat: 38.5, lon: 68.7, tags: { name: 'Чайхона', amenity: 'cafe' } };
const cafeFind = (place, query) => searchPlaces(indexPlaces([place]), { query, chip: 'all', savedOnly: null, city: null, centre: { lat: 38.5, lon: 68.7 } }).length;
eq(cafeFind(cafe, 'рохат'), 0, 'before the edit');
eq(cafeFind({ ...cafe, tags: { ...cafe.tags, alt_name: 'Рохат' } }, 'рохат'), 1, 'an edited alt_name is found at once');
eq(cafeFind({ ...cafe, tags: { ...cafe.tags, 'addr:housenumber': '12а' } }, '12а'), 1, 'an edited house number too');

// ---- real data ---------------------------------------------------------------------------
const places = JSON.parse(readFileSync(pub('places.json'), 'utf8'));
const streets = JSON.parse(readFileSync(pub('streets.json'), 'utf8')).roads;
const meta = JSON.parse(readFileSync(pub('atlas-data/index.json'), 'utf8'));
// Like lib/map-places.ts roadPlace: the road's middle vertex stands for it.
const streetPlaces = streets.map(r => {
  const c = r.coordinates[Math.floor(r.coordinates.length / 2)];
  const name = r.name || r.ref || 'Безымянный проезд';
  return { id: 'street:' + r.id, lat: c[1], lon: c[0], tags: { ...r.tags, name, 'name:ru': name, 'atlas:type': 'street', 'atlas:road-id': r.id, 'addr:city': 'Таджикистан' } };
});
const labels = meta.labels.map(([nx, ny, name, kind]) => ({ lon: nx * 360 - 180, lat: Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180 / Math.PI, name, kind }));
const settlements = settlementPlaces(labels, new Set(places.map(p => p.id)));
ok(settlements.length > 2500, `settlements: ${settlements.length}`);
eq(new Set(settlements.map(p => p.id)).size, settlements.length, 'settlement ids are unique');
ok(CITIES.slice(1).every(c => settlements.some(p => p.tags.name === c.name)), 'every town is findable');
// Road numbers made by scripts/build-road-routes.py, when the build has them.
let routes = [];
if (existsSync(pub('road-routes.json'))) {
  try {
    const data = JSON.parse(readFileSync(pub('road-routes.json'), 'utf8'));
    routes = (data.routes || []).filter(r => r.ref).slice(0, 3000).map(r => ({ id: 'route:' + r.id, lat: 0, lon: 0, tags: { name: r.name || r.ref, 'name:ru': r.name || r.ref, ref: r.ref, 'atlas:type': 'route', 'atlas:route-id': String(r.id), 'atlas:search': r.ref } }));
  } catch { routes = [] }
}
const all = [...places, ...routes, ...streetPlaces, ...settlements];

// The time limits are for an ordinary desktop. On a slower or busy machine they stretch by how much
// slower a fixed plain-JavaScript loop runs than the ~45 ms it takes on such a desktop.
const calibrate = () => { const t = performance.now(); let x = 0; for (let i = 0; i < 3e7; i++) x += i % 7; return [performance.now() - t, x] };
calibrate();
const slow = Math.max(1, calibrate()[0] / 45);

const t0 = performance.now();
const entries = indexPlaces(all);
const shaydon = cityByName('Шайдон'), dushanbe = cityByName('Душанбе'), khujand = cityByName('Худжанд');
const at = c => ({ lat: c.lat, lon: c.lon });
const run = (query, city, extra = {}) => searchPlaces(entries, { query, chip: 'all', savedOnly: null, city, centre: at(city ?? COUNTRY), ...extra });
const r303 = run('R-303', shaydon);
const firstMs = performance.now() - t0;
const t1 = performance.now();
const r303b = run('р303', shaydon);
const secondMs = performance.now() - t1;
const t2 = performance.now();
run('рудаки 12', dushanbe);
const thirdMs = performance.now() - t2;

ok(String(r303[0]?.tags.ref).includes('R-303'), `R-303 first: ${r303[0]?.tags.name}`);
const r303rows = r303.filter(p => /R-303/.test(p.tags.ref || '') && p.tags['atlas:type'] === 'street').length;
ok(r303rows >= 1 && r303rows <= 3, `R-303 street rows after dedupe: ${r303rows}`);
eq(r303b[0]?.id, r303[0]?.id, 'р303 finds the same road first');
eq(run('Р-303', shaydon)[0]?.id, r303[0]?.id, 'Р-303 in Cyrillic finds the same road first');

const rb4 = run('rb 04', dushanbe);
ok(rb4.length && refKey(rb4[0].tags.ref.split(';')[0]) === 'RB4', `rb 04 finds РБ04: ${rb4[0]?.tags.ref}`);
eq(refKey(run('РБ4', dushanbe)[0]?.tags.ref.split(';')[0] ?? ''), 'RB4', 'РБ4 finds РБ04');

const pharmacies = run('аптека', dushanbe);
ok(pharmacies.length >= 100, `аптека: ${pharmacies.length} results`);
ok(pharmacies.slice(0, 20).every(p => p.tags.amenity === 'pharmacy' || p.tags.healthcare === 'pharmacy' || /аптек/i.test(fold(p.tags['name:ru'] || p.tags.name || ''))), 'аптека: the first 20 are pharmacies');
const onlyPharmacies = pharmacies.filter(p => p.tags.amenity === 'pharmacy');
ok(onlyPharmacies.length >= 200, `аптека finds pharmacies not named so: ${onlyPharmacies.length}`);
ok(run('банкомат', dushanbe).slice(0, 5).every(p => p.tags.amenity === 'atm' || /банкомат/.test(fold(p.tags.name || ''))), 'банкомат finds ATMs');
const refuel = run('заправка', khujand);
ok(refuel.slice(0, 10).every(p => p.tags.amenity === 'fuel' || /заправк/.test(fold(p.tags.name || ''))), 'заправка finds fuel stations');
ok(refuel.filter(p => p.tags.amenity === 'fuel').length >= 150, `заправка finds fuel stations not named so: ${refuel.filter(p => p.tags.amenity === 'fuel').length}`);
const refuelGaps = refuel.slice(0, 30).map(p => Math.hypot(p.lat - khujand.lat, (p.lon - khujand.lon) * Math.cos(khujand.lat * Math.PI / 180)));
ok(refuelGaps.every((g, i) => i === 0 || g >= refuelGaps[i - 1]), 'a kind word lists the nearest places first, whatever they are called');

const rudaki = run('rudaki', dushanbe);
ok(rudaki.slice(0, 10).some(p => fold(p.tags['name:ru'] || p.tags.name || '').includes('рудаки')), 'rudaki finds «Рудаки»');

for (const town of ['Худжанд', 'Истаравшан', 'Куляб']) {
  const c = cityByName(town), first = run(town, shaydon)[0];
  ok(first?.tags['atlas:type'] === 'label' && Math.abs(first.lat - c.lat) < 0.05 && Math.abs(first.lon - c.lon) < 0.05, `${town} from Shaydon: ${first?.tags.name} ${first?.lat},${first?.lon}`);
}
eq(run('Khujand', shaydon)[0]?.tags.name, 'Худжанд', 'Khujand in Latin finds Худжанд');
eq(run('Ходжент', shaydon)[0]?.tags.name, 'Худжанд', 'an old name finds Худжанд');
const multi = run('кафе худжанд', khujand);
ok(multi.length > 0 && multi.slice(0, 10).every(p => chipOf(p.tags) === 'food'), 'кафе худжанд: every word has to match');
const coord = run('40.2824, 69.6227', khujand);
eq(coord[0]?.id, 'coord:40.282400,69.622700', 'coordinates come first');

const browse = run('', dushanbe);
ok(browse.length >= 1000, `browse Dushanbe: ${browse.length}`);
ok(browse.every(p => !['street', 'district', 'label', 'route'].includes(p.tags['atlas:type'])), 'browse lists no streets, districts, settlements or roads');
const gaps = browse.map(p => Math.hypot(p.lat - dushanbe.lat, (p.lon - dushanbe.lon) * Math.cos(dushanbe.lat * Math.PI / 180)));
ok(gaps.every((g, i) => i === 0 || g >= gaps[i - 1]), 'browse is sorted by distance');
ok(browse.every(p => inCity(dushanbe, p.lat, p.lon)), 'browse stays in the town');
ok(run('', shaydon).length >= 20, 'browse Shaydon falls back to the nearest places');
const fuel = run('', khujand, { chip: 'fuel' });
ok(fuel.length > 0 && fuel.every(p => chipOf(p.tags) === 'fuel'), `chip fuel in Khujand: ${fuel.length}`);
const savedIds = [places[0].id, places[10].id, 'street:' + streets[0].id];
eq(new Set(run('', null, { savedOnly: savedIds }).map(p => p.id)), new Set(savedIds), 'favourites list every saved place');
eq(run('кафе', khujand, { savedOnly: [] }).length, 0, 'favourites search stays in the favourites');

ok(firstMs < 1500 * slow, `first query with indexing: ${firstMs.toFixed(0)} ms (limit ${(1500 * slow).toFixed(0)})`);
ok(secondMs < 100 * slow, `second query: ${secondMs.toFixed(0)} ms (limit ${(100 * slow).toFixed(0)})`);
ok(thirdMs < 100 * slow, `third query: ${thirdMs.toFixed(0)} ms (limit ${(100 * slow).toFixed(0)})`);
// prepareSearch builds every text ahead (the page runs it while idle); after it nothing is left to build.
eq(prepareSearch(entries), 0, 'the queries above already built every text');
const fresh = indexPlaces(places.map(p => ({ ...p })));
ok(prepareSearch(fresh, 100) === 100 && prepareSearch(fresh) === places.length - 100, 'prepareSearch works in slices');
// Reindexing after a live edit: unchanged place objects keep their entries, and places rebuilt with
// the same names reuse the cached text.
ok(indexPlaces(all).every((e, i) => e === entries[i]), 'an unchanged place keeps its entry');
const t3 = performance.now();
const again = indexPlaces(all.map(p => ({ ...p })));
searchPlaces(again, { query: 'аптека', chip: 'all', savedOnly: null, city: dushanbe, centre: at(dushanbe) });
const reindexMs = performance.now() - t3;
ok(reindexMs < 400 * slow, `reindex and query: ${reindexMs.toFixed(0)} ms (limit ${(400 * slow).toFixed(0)})`);

console.log(`check-place-search: ${checks} checks passed (${all.length} places, ${routes.length} roads; first query ${firstMs.toFixed(0)} ms, then ${secondMs.toFixed(0)} / ${thirdMs.toFixed(0)} ms, reindex ${reindexMs.toFixed(0)} ms; this machine ${slow.toFixed(1)}× slower than the reference desktop)`);
