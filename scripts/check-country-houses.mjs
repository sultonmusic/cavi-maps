/* Houses across Tajikistan: every file reads back to its last byte, each house lands in exactly
 * one tile per zoom, outlines keep the vector-tile winding, and Shaydon is left to its own
 * editable footprints. After scripts/estimate-country-heights.mjs the files are AHB2: every
 * house has a facade style, and every guessed height is flagged as a guess.
 *
 *   node scripts/check-country-houses.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { HOUSE_UNIT, houseFlags, houseGroupOf, housesInTile, housesNear, indexHouses } from '../lib/country-houses.mjs';

// The decoder on a file written by hand: a 20 × 10 unit house, 13 m tall.
const sample = new DataView(new ArrayBuffer(8 + 10 + 3 * 4));
sample.setUint32(0, 0x31424841, true); sample.setUint32(4, 1, true);
sample.setUint8(8, 4); sample.setUint8(9, 13); sample.setInt32(10, 1000, true); sample.setInt32(14, 2000, true);
[[20, 0], [0, 10], [-20, 0]].forEach(([dx, dy], i) => { sample.setInt16(18 + i * 4, dx, true); sample.setInt16(20 + i * 4, dy, true) });
const handmade = indexHouses(sample.buffer);
assert.deepEqual(houseGroupOf(16, 80, 112), [5, 7]);
const [tileHouse] = housesInTile(handmade, 5, 7, 16, 80, 112);
assert.ok(Number.isInteger(tileHouse.outline) && tileHouse.outline >= 0 && tileHouse.outline < 2 ** 32);
assert.deepEqual(housesInTile(handmade, 5, 7, 16, 80, 112), [{ ring: [[1000, 2000], [1020, 2000], [1020, 2010], [1000, 2010], [1000, 2000]], height: 13, index: 0, style: null, estimated: false, outline: tileHouse.outline }]);
assert.equal(housesInTile(handmade, 5, 7, 13, 10, 14)[0].outline, tileHouse.outline, 'the outline hash does not depend on the zoom');
assert.deepEqual(housesInTile(handmade, 5, 7, 16, 81, 112), [], 'a house belongs to the tile its middle is in');
assert.deepEqual(housesInTile(handmade, 5, 7, 13, 10, 14)[0].ring, [[125, 250], [128, 250], [128, 251], [125, 251], [125, 250]]);
assert.equal(houseGroupOf(12, 5, 7), null);
assert.throws(() => indexHouses(new Uint8Array([65, 72, 66]).buffer), /файл/i);
assert.throws(() => indexHouses(sample.buffer.slice(0, 26)), /повреждён/, 'a cut-off file is refused');
// Houses near a point, in world units: the file's corner is 5 × 65536, 7 × 65536.
const [ox, oy] = [5 * 65536, 7 * 65536], middle = [ox + 1010, oy + 2005];
const near = housesNear(handmade, 5, 7, middle[0] + 30, middle[1], 31);
assert.equal(near.length, 1, 'a radius reaching the middle finds the house');
assert.deepEqual(near[0].points, [ox + 1000, oy + 2000, ox + 1020, oy + 2000, ox + 1020, oy + 2010, ox + 1000, oy + 2010]);
assert.deepEqual([near[0].index, near[0].height, near[0].gap, near[0].style, near[0].estimated], [0, 13, 30, null, false]);
assert.equal(housesNear(handmade, 5, 7, middle[0] + 30, middle[1], 29).length, 0, 'a radius stopping short finds none');
assert.equal(near[0].outline, tileHouse.outline, 'housesNear and housesInTile hash an outline alike');
// A copy of the outline that starts at another corner and runs the other way hashes the same;
// a house one unit wider does not.
const written = corners => {
  const bytes = new DataView(new ArrayBuffer(8 + 10 + (corners.length - 1) * 4));
  bytes.setUint32(0, 0x31424841, true); bytes.setUint32(4, 1, true);
  bytes.setUint8(8, corners.length); bytes.setUint8(9, 0); bytes.setInt32(10, corners[0][0], true); bytes.setInt32(14, corners[0][1], true);
  corners.slice(1).forEach(([x, y], i) => { bytes.setInt16(18 + i * 4, x - corners[i][0], true); bytes.setInt16(20 + i * 4, y - corners[i][1], true) });
  return indexHouses(bytes.buffer);
};
assert.equal(housesNear(written([[1020, 2010], [1020, 2000], [1000, 2000], [1000, 2010]]), 5, 7, middle[0], middle[1], 5)[0].outline, tileHouse.outline);
assert.notEqual(housesNear(written([[1000, 2000], [1021, 2000], [1021, 2010], [1000, 2010]]), 5, 7, middle[0], middle[1], 5)[0].outline, tileHouse.outline);
// The same house in AHB2: one more byte per house, style 'block' (2) and the estimate bit (8).
const sample2 = new DataView(new ArrayBuffer(8 + 11 + 3 * 4));
sample2.setUint32(0, 0x32424841, true); sample2.setUint32(4, 1, true);
sample2.setUint8(8, 4); sample2.setUint8(9, 16); sample2.setUint8(10, 2 | 8); sample2.setInt32(11, 1000, true); sample2.setInt32(15, 2000, true);
[[20, 0], [0, 10], [-20, 0]].forEach(([dx, dy], i) => { sample2.setInt16(19 + i * 4, dx, true); sample2.setInt16(21 + i * 4, dy, true) });
const handmade2 = indexHouses(sample2.buffer);
assert.deepEqual(housesInTile(handmade2, 5, 7, 16, 80, 112), [{ ring: [[1000, 2000], [1020, 2000], [1020, 2010], [1000, 2010], [1000, 2000]], height: 16, index: 0, style: 'block', estimated: true, outline: tileHouse.outline }]);
assert.deepEqual(housesNear(handmade2, 5, 7, middle[0], middle[1], 1)[0].points, near[0].points);
assert.throws(() => indexHouses(sample2.buffer.slice(0, 29)), /повреждён/, 'a cut-off AHB2 file is refused');

const root = new URL('../public/atlas-houses/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
assert.ok(['AHB1', 'AHB2'].includes(meta.format), 'a known house format');
assert.deepEqual([meta.unit, meta.tier, meta.group, meta.licence], [HOUSE_UNIT, 13, 2, 'ODbL']);
assert.ok(meta.counts.osm > 400_000, 'OpenStreetMap buildings of the whole country');
assert.ok(meta.counts.microsoft > 100_000, 'Microsoft footprints where OpenStreetMap has none');
const read = name => {
  const bytes = readFileSync(new URL(`${name}.bin`, root));
  return indexHouses(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};

let total = 0, estimated = 0, styled = 0;
for (const name of meta.groups) {
  const file = read(name);
  total += file.count;
  assert.equal(file.head, meta.format === 'AHB2' ? 11 : 10, `${name} is written as ${meta.format}`);
  if (file.head !== 11) continue;
  for (let i = 0; i < file.count; i++) {
    const flags = file.view.getUint8(file.starts[i] + 2);
    if (flags & 7) styled++;
    if (!(flags & 8)) continue;
    estimated++;
    assert.ok([7, 8, 16].includes(file.view.getUint8(file.starts[i] + 1)), 'an estimate is one of the stated guesses');
  }
}
assert.equal(total, meta.counts.osm + meta.counts.microsoft, 'the files hold every house counted');
if (meta.format === 'AHB2') {
  assert.equal(estimated, meta.counts.estimated, 'every guessed height is flagged and counted');
  assert.equal(styled, total, 'every house has a facade style');
  assert.ok(estimated > 50_000 && estimated < total * 0.3, 'only larger footprints get a guess');
} else assert.equal(estimated + styled, 0);

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
let statedTall = 0;
for (let i = 0; i < dushanbe.count; i++) if (dushanbe.view.getUint8(dushanbe.starts[i] + 1) > 4 && !houseFlags(dushanbe, i).estimated) statedTall++;
assert.ok(statedTall > 100, 'stated floors and heights survive the estimates');
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

console.log(`PASS: ${meta.groups.length} ${meta.format} house files read back whole with ${total} houses (${meta.counts.osm} OpenStreetMap, ${meta.counts.microsoft} Microsoft; ${estimated} estimated heights, flagged); central Dushanbe cuts into zoom-16 tiles once each (${dushanbe.count}, ${tall} taller than 4 m) with vector-tile winding; Shaydon is left to its own footprints.`);
