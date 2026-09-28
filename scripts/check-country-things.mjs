/* OpenStreetMap street furniture for the 3D map: every file reads back into known kinds inside
 * Tajikistan with a facing and size in range, a stop's pole, platform and shelter became one stop,
 * traffic lights stand at their approaches, and Dushanbe has stops, signals and trees.
 *
 *   node scripts/check-country-things.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const KINDS = ['stop', 'signal', 'tree', 'bench', 'fountain', 'monument', 'flag', 'emblem'];
const root = new URL('../public/atlas-things/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
assert.deepEqual([meta.tier, meta.licence], [10, 'ODbL']);

const all = [];
for (const name of meta.groups) {
  const [tx, ty] = name.split('-').map(Number);
  for (const record of JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8')).things) {
    const [kind, x, y, facing, size, label] = record;
    assert.ok(KINDS.includes(kind), `known kind: ${kind}`);
    const lon = x / 1e6, lat = y / 1e6;
    assert.ok(lon > 66 && lon < 76.5 && lat > 35.5 && lat < 42, 'in or near Tajikistan');
    assert.ok(Number.isInteger(facing) && facing >= 0 && facing < 360, 'facing in whole degrees');
    assert.ok(Number.isInteger(size) && size >= 0 && size <= 4000, 'size in decimetres');
    assert.ok(label === undefined || (kind === 'stop' && typeof label === 'string' && label.length > 0), 'only stops carry names');
    const n = 1024, rad = lat * Math.PI / 180;
    assert.deepEqual([Math.floor((lon + 180) / 360 * n), Math.floor((1 - Math.asinh(Math.tan(rad)) / Math.PI) / 2 * n)], [tx, ty], 'filed by its own tile');
    all.push({ kind, lon, lat, facing, label });
  }
}
const count = kind => all.filter(thing => thing.kind === kind).length;
for (const kind of KINDS) assert.equal(count(kind), meta.counts[kind] ?? 0, `${kind} count matches the index`);
assert.ok(count('stop') > 200 && count('signal') > 300 && count('tree') > 4000 && count('fountain') > 100 && count('monument') > 50);

// No two stops closer than the merge distance: one shelter per stop.
const metres = (a, b) => Math.hypot((a.lon - b.lon) * Math.cos(a.lat * Math.PI / 180), a.lat - b.lat) * 111_320;
const stops = all.filter(thing => thing.kind === 'stop').sort((a, b) => a.lon - b.lon);
for (let i = 0; i < stops.length; i++) for (let j = i + 1; j < stops.length && (stops[j].lon - stops[i].lon) * 85_000 < 30; j++) {
  assert.ok(metres(stops[i], stops[j]) >= 29.9, `stops ${stops[i].label || i} and ${stops[j].label || j} were merged`);
}

// Central Dushanbe has stops with names, traffic lights turned to their streets, and trees.
const dushanbe = all.filter(thing => thing.lon > 68.72 && thing.lon < 68.84 && thing.lat > 38.53 && thing.lat < 38.61);
const inCity = kind => dushanbe.filter(thing => thing.kind === kind);
assert.ok(inCity('stop').length > 40 && inCity('stop').some(stop => stop.label), 'named stops in Dushanbe');
assert.ok(inCity('signal').length > 100 && new Set(inCity('signal').map(signal => signal.facing)).size > 20, 'signals face their approaches');
assert.ok(inCity('tree').length > 30);
// The State Emblem monument stands by the Palace of the Nation.
assert.ok(inCity('emblem').some(emblem => Math.abs(emblem.lon - 68.78009) < 0.0005 && Math.abs(emblem.lat - 38.57393) < 0.0005), 'the State Emblem in Dushanbe');

console.log(`PASS: ${all.length} things in ${meta.groups.length} files (${KINDS.map(kind => `${count(kind)} ${kind}`).join(', ')}); known kinds, facings and sizes in range, filed by tile, stops merged, Dushanbe stocked.`);
