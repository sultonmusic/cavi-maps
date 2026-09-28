/* Checks the Shaydon dataset the map ships: street numbering, the four
 * microdistricts, and the house numbers attached to them.
 *
 *   node scripts/check-shaydon.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = async name => JSON.parse(await fs.readFile(path.join(project, 'public', name), 'utf8'));
const METRES_PER_DEGREE = 111_320;
const CARRIAGEWAY = { secondary: 7, tertiary: 6, primary: 8, trunk: 9 };
const CARRIAGEWAY_DEFAULT = 3.5;

const { roads } = await read('streets.json');
const { districts } = await read('districts.json');
const houses = await read('shaydon-buildings.json');

// --- streets ------------------------------------------------------------
const proposed = roads.filter(road => road.namingStatus === 'proposed');
assert(proposed.length > 150, 'Shaydon should carry a full set of proposed street names');
for (const road of proposed) assert.match(road.name, /^Улица \d+$/, `unexpected proposed name: ${road.name}`);

const groups = new Map();
for (const road of proposed) {
  const key = road.groupId || road.id;
  const latitudes = road.coordinates.map(point => point[1]);
  const middle = (Math.min(...latitudes) + Math.max(...latitudes)) / 2;
  const entry = groups.get(key) || { name: road.name, latitudes: [] };
  assert.equal(entry.name, road.name, `one street must carry one name: ${key}`);
  entry.latitudes.push(middle);
  groups.set(key, entry);
}
const ordered = [...groups.values()]
  .map(entry => ({ number: Number(entry.name.replace(/\D+/g, '')), lat: entry.latitudes.reduce((a, b) => a + b, 0) / entry.latitudes.length }))
  .sort((a, b) => a.number - b.number);
const numbers = ordered.map(entry => entry.number);
assert.deepEqual(numbers, [...new Set(numbers)], 'street numbers must be unique');
assert.equal(numbers[0], 1, 'street numbering starts at 1');

// Neighbouring streets overlap in latitude, so rank correlation is the honest
// measure of "numbered north to south", not adjacent pairs.
const rank = values => {
  const order = [...values.keys()].sort((a, b) => values[a] - values[b]);
  const out = new Array(values.length);
  order.forEach((index, position) => { out[index] = position });
  return out;
};
const byNumber = rank(ordered.map(entry => entry.number));
const byLat = rank(ordered.map(entry => entry.lat));
const spread = byNumber.reduce((sum, value, index) => sum + (value - byLat[index]) ** 2, 0);
const count = ordered.length;
const correlation = 1 - 6 * spread / (count * (count * count - 1));
assert(correlation < -0.9, `street numbers should run north to south (correlation ${correlation.toFixed(3)})`);

// --- microdistricts -----------------------------------------------------
assert.equal(districts.length, 4, 'Shaydon has four proposed microdistricts');
const byLatitude = [...districts].sort((a, b) => b.center[1] - a.center[1]);
byLatitude.forEach((district, index) => {
  assert.equal(district.name, `${index + 1} микрорайон`, 'microdistricts are numbered north to south');
  assert.equal(district.namingStatus, 'proposed');
});

// --- houses -------------------------------------------------------------
assert.equal(houses.licence, 'ODbL');
assert.match(houses.source, /Microsoft/);
assert(houses.buildings.length > 5000, 'the Shaydon footprint set looks truncated');
assert.equal(houses.heights.every(height => height === 0), true,
  'no surveyed heights exist, so none may be published');

const [originLon, originLat] = houses.origin;
const centres = houses.buildings.map(flat => {
  let x = 0, y = 0, sumLon = 0, sumLat = 0;
  const points = flat.length / 2;
  for (let i = 0; i < flat.length; i += 2) {
    x += flat[i];
    y += flat[i + 1];
    sumLon += originLon + x / houses.scale;
    sumLat += originLat + y / houses.scale;
  }
  return [sumLon / points, sumLat / points];
});
assert.equal(centres.length, houses.number.length, 'every footprint needs a number slot');
assert.equal(centres.length, houses.street.length, 'every footprint needs a street slot');

const perStreet = new Map();
houses.number.forEach((number, index) => {
  const slot = houses.street[index];
  if (!number) { assert.equal(slot, -1, 'an unnumbered house belongs to no street'); return }
  assert(slot >= 0 && slot < houses.streets.length, 'a numbered house needs a real street');
  const list = perStreet.get(slot) || [];
  list.push(number);
  perStreet.set(slot, list);
});
for (const [slot, list] of perStreet) {
  const sorted = [...list].sort((a, b) => a - b);
  assert.deepEqual(sorted, sorted.map((_, index) => index + 1),
    `houses on ${houses.streets[slot]} must be numbered 1..${list.length} without gaps`);
}

// --- nothing may sit on a carriageway -----------------------------------
const cos = Math.cos(40.66 * Math.PI / 180);
const segments = [];
for (const road of roads) {
  const box = road.bbox;
  if (!box || box[2] < 70.31 || box[0] > 70.41 || box[3] < 40.62 || box[1] > 40.70) continue;
  const clearance = CARRIAGEWAY[(road.tags || {}).highway] ?? CARRIAGEWAY_DEFAULT;
  for (let i = 1; i < road.coordinates.length; i++) segments.push([road.coordinates[i - 1], road.coordinates[i], clearance]);
}
let onRoad = 0;
for (const [lon, lat] of centres) {
  for (const [start, end, clearance] of segments) {
    if (Math.abs(start[1] - lat) > 0.001 && Math.abs(end[1] - lat) > 0.001) continue;
    const px = (lon - start[0]) * cos, py = lat - start[1];
    const dx = (end[0] - start[0]) * cos, dy = end[1] - start[1];
    const length = dx * dx + dy * dy;
    const t = length ? Math.max(0, Math.min(1, (px * dx + py * dy) / length)) : 0;
    if (Math.hypot(px - dx * t, py - dy * t) * METRES_PER_DEGREE < clearance) { onRoad++; break }
  }
}
assert.equal(onRoad, 0, `${onRoad} footprints still sit on a carriageway`);

const numbered = houses.number.filter(Boolean).length;
console.log(`Shaydon: ${ordered.length} streets numbered 1..${numbers[numbers.length - 1]} north to south, ` +
  `4 microdistricts, ${houses.buildings.length} houses (${numbered} numbered across ${houses.streets.length} streets), ` +
  'none on a carriageway');
