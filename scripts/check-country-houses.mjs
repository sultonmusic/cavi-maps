/* Houses across Tajikistan: every file reads back to its last byte, each house lands in exactly
 * one tile per zoom, outlines keep the vector-tile winding, and Shaydon is left to its own
 * editable footprints.
 *
 *   node scripts/check-country-houses.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOUSE_UNIT, houseGroupOf, housesInTile, indexHouses } from '../lib/country-houses.mjs';

// The decoder on a file written by hand: a 20 × 10 unit house, 13 m tall.
const sample = new DataView(new ArrayBuffer(8 + 10 + 3 * 4));
sample.setUint32(0, 0x31424841, true); sample.setUint32(4, 1, true);
sample.setUint8(8, 4); sample.setUint8(9, 13); sample.setInt32(10, 1000, true); sample.setInt32(14, 2000, true);
[[20, 0], [0, 10], [-20, 0]].forEach(([dx, dy], i) => { sample.setInt16(18 + i * 4, dx, true); sample.setInt16(20 + i * 4, dy, true) });
const handmade = indexHouses(sample.buffer);
assert.deepEqual(houseGroupOf(16, 80, 112), [5, 7]);
assert.deepEqual(housesInTile(handmade, 5, 7, 16, 80, 112), [{ ring: [[1000, 2000], [1020, 2000], [1020, 2010], [1000, 2010], [1000, 2000]], height: 13 }]);
assert.deepEqual(housesInTile(handmade, 5, 7, 16, 81, 112), [], 'a house belongs to the tile its middle is in');
assert.deepEqual(housesInTile(handmade, 5, 7, 13, 10, 14)[0].ring, [[125, 250], [128, 250], [128, 251], [125, 251], [125, 250]]);
assert.equal(houseGroupOf(12, 5, 7), null);
assert.throws(() => indexHouses(new Uint8Array([65, 72, 66]).buffer), /файл/i);
assert.throws(() => indexHouses(sample.buffer.slice(0, 26)), /повреждён/, 'a cut-off file is refused');

const root = new URL('../public/atlas-houses/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
assert.deepEqual([meta.format, meta.unit, meta.tier, meta.group, meta.licence], ['AHB1', HOUSE_UNIT, 13, 2, 'ODbL']);
assert.ok(meta.counts.osm > 400_000, 'OpenStreetMap buildings of the whole country');
assert.ok(meta.counts.microsoft > 100_000, 'Microsoft footprints where OpenStreetMap has none');
const read = name => {
  const bytes = readFileSync(new URL(`${name}.bin`, root));
  return indexHouses(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

let total = 0;
for (const name of meta.groups) total += read(name).count;
assert.equal(total, meta.counts.osm + meta.counts.microsoft, 'the files hold every house counted');

const tileOf = (lon, lat, z) => {
  const n = 2 ** z, rad = lat * Math.PI / 180;
  return [Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * n)];
};
const lonLat = (x, y) => [x / HOUSE_UNIT * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y / HOUSE_UNIT))) * 180 / Math.PI];

// Central Dushanbe: at full detail every house is cut into exactly one zoom-16 tile.
const [gx, gy] = houseGroupOf(13, ...tileOf(68.7791, 38.5737, 13));
const dushanbe = read(`${gx}-${gy}`);
assert.ok(dushanbe.count > 5000, 'central Dushanbe has houses');
let finest = 0, tall = 0;
for (let x = gx * 16; x < gx * 16 + 32; x++) for (let y = gy * 16; y < gy * 16 + 32; y++) {
  for (const { ring, height } of housesInTile(dushanbe, gx, gy, 16, x, y)) {
    finest++;
    if (height > 4) tall++;
    assert.ok(ring.length >= 4 && ring[0][0] === ring.at(-1)[0] && ring[0][1] === ring.at(-1)[1], 'a closed outline');
    for (const [px, py] of ring) assert.ok(px > -4096 && px < 8192 && py > -4096 && py < 8192, 'corners near their tile');
    let twice = 0;
    for (let i = 0; i < ring.length - 1; i++) twice += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    assert.ok(twice > 0, 'clockwise on screen, as a vector-tile exterior ring');
  }
}
assert.equal(finest, dushanbe.count);
assert.ok(tall > 100, 'stated floors and heights are kept');
let coarse = 0;
for (let x = gx * 2; x < gx * 2 + 2; x++) for (let y = gy * 2; y < gy * 2 + 2; y++) coarse += housesInTile(dushanbe, gx, gy, 13, x, y).length;
assert.ok(coarse <= dushanbe.count && coarse > dushanbe.count * 0.99, 'far out only specks collapse');

// Shaydon keeps its own numbered footprints, so the country files leave its box empty.
const [W, S, E, N] = [70.318, 40.628, 70.402, 40.692];
const [westFile, southFile] = houseGroupOf(13, ...tileOf(W, S, 13)), [eastFile, northFile] = houseGroupOf(13, ...tileOf(E, N, 13));
let aroundShaydon = 0;
for (let fx = westFile; fx <= eastFile; fx++) for (let fy = northFile; fy <= southFile; fy++) {
  if (!meta.groups.includes(`${fx}-${fy}`)) continue;
  const file = read(`${fx}-${fy}`);
  for (let i = 0; i < file.count; i++) {
    const [lon, lat] = lonLat(file.cx[i] + fx * 65536, file.cy[i] + fy * 65536);
    assert.ok(!(lon > W && lon < E && lat > S && lat < N), `no country house inside Shaydon (${lon.toFixed(6)}, ${lat.toFixed(6)})`);
    aroundShaydon++;
  }
}
assert.ok(aroundShaydon > 0, 'villages around Shaydon still get houses');

console.log(`PASS: ${meta.groups.length} house files read back whole with ${total} houses (${meta.counts.osm} OpenStreetMap, ${meta.counts.microsoft} Microsoft); central Dushanbe cuts into zoom-16 tiles once each (${dushanbe.count}, ${tall} taller than 4 m) with vector-tile winding; Shaydon is left to its own footprints.`);
