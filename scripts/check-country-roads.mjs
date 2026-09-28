/* OpenStreetMap asphalt streets: every file reads back into lines inside Tajikistan with a valid
 * lane count, main roads are there without a surface tag, one-way carriageways are marked, and
 * Shaydon's already styled R-303 is left to the map tiles.
 *
 *   node scripts/check-country-roads.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isLanes } from '../lib/lanes.mjs';

const root = new URL('../public/atlas-roads/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
assert.equal(meta.tier, 10);
assert.equal(meta.licence, 'ODbL');
assert.ok(meta.counts.roads > 3000, 'asphalt streets across the country');
assert.ok(meta.counts.paved_tag > 1000 && meta.counts.main_road_assumed_paved > 1000);

const ways = new Map();
for (const name of meta.groups) {
  const [tx, ty] = name.split('-').map(Number);
  for (const [way, lanes, oneway, ...steps] of JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8')).roads) {
    assert.ok(Number.isInteger(way) && way > 0);
    assert.ok(isLanes(lanes), `lanes of way/${way}`);
    assert.ok(oneway === 0 || oneway === 1);
    assert.ok(steps.length >= 4 && steps.length % 2 === 0, `way/${way} has at least two points`);
    let x = 0, y = 0, west = Infinity, east = -Infinity, south = Infinity, north = -Infinity;
    for (let i = 0; i < steps.length; i += 2) {
      x += steps[i]; y += steps[i + 1];
      const lon = x / 1e6, lat = y / 1e6;
      assert.ok(lon > 66 && lon < 76.5 && lat > 35.5 && lat < 42, `way/${way} lies in or near Tajikistan`);
      west = Math.min(west, lon); east = Math.max(east, lon); south = Math.min(south, lat); north = Math.max(north, lat);
    }
    // A file holds only streets whose bounds reach its tile.
    const n = 1024, column = lon => Math.floor((lon + 180) / 360 * n), row = lat => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
    assert.ok(tx >= column(west) && tx <= column(east) && ty >= row(north) && ty <= row(south), `way/${way} belongs in ${name}`);
    ways.set(way, { lanes, oneway });
  }
}
assert.equal(ways.size, meta.counts.roads, 'every street is in at least one file');

// Ismoili Somoni Avenue in Khujand: a one-way primary carriageway tagged lanes=3, with no surface tag.
assert.deepEqual(ways.get(22884100), { lanes: 3, oneway: 1 });
// Shaydon's R-303 and its bridge, which the user asked to see as asphalt, are always in.
const style = JSON.parse(readFileSync(new URL('../public/atlas-data/shaydon-style.json', import.meta.url), 'utf8'));
for (const way of style.way_ids) assert.ok(ways.has(Number(String(way).replace(/\D/g, ''))), `${way} is drawn as asphalt`);

console.log(`PASS: ${meta.counts.roads} asphalt streets in ${meta.groups.length} files (${meta.counts.paved_tag} tagged paved, ${meta.counts.main_road_assumed_paved} main roads without a surface tag, ${meta.counts.oneway} one-way); lanes 0–6, lines inside Tajikistan, filed by tile; R-303 included.`);
