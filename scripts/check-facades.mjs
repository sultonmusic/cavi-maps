/* Procedural facades, rooftop details and street trees (lib/facades.mjs, lib/mesh-kit.mjs,
 * lib/greenery.mjs): counts and placement on hand-made houses, the vertex budget, and one dense
 * real neighbourhood (central Khujand) built from the country house files.
 *
 *   node scripts/check-facades.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import {
  BAY, HOUSE_TONES, MAX_DECAL_VERTICES, ROOF_SHADE, TEXTURE, buildFacades, houseTone, insetPolygon, lightShade,
  markStorefronts, storeys, toneColour, triangulate, wallShade, outlineTone, liftedHeight, TONE_LIFT, WORLD_METRE, worldRoof,
} from '../lib/facades.mjs';
import { block, facet, rectangleAround, SUN, unit } from '../lib/mesh-kit.mjs';
import { lowTreeTriangles, openGround, parkTrees, streetTrees, TREE_VERTICES, worldGrid } from '../lib/greenery.mjs';
import { HOUSE_UNIT, housesNear, indexHouses } from '../lib/country-houses.mjs';

// Floors and tones.
assert.deepEqual([storeys(4), storeys(16), storeys(13), storeys(2), storeys(7), storeys(8)], [1, 5, 4, 0, 2, 2]);
const buckets = new Array(8).fill(0);
for (let i = 0; i < 10_000; i++) {
  const tone = houseTone(`cty:2840-1546:${i}`);
  assert.ok(Number.isInteger(tone) && tone >= 0 && tone < 8);
  buckets[tone]++;
}
assert.equal(houseTone('ms:17'), houseTone('ms:17'), 'a tone is the same every time');
for (const count of buckets) assert.ok(count >= 900 && count <= 1600, `tones spread evenly (${buckets})`);
assert.equal(HOUSE_TONES.length, 8);
assert.deepEqual(toneColour(2).map(c => Math.round(c * 255)), [0xf3, 0xf1, 0xec]);
// The light: the south-west wall is the bright one, the north-east one gets the ambient part only, and roofs are brightest.
assert.ok(wallShade(-0.7071, -0.7071) > 0.95 && Math.abs(wallShade(0.7071, 0.7071) - 0.75) < 1e-9 && ROOF_SHADE > wallShade(-0.7071, -0.7071));
assert.ok(lightShade(0, 0, 1) === ROOF_SHADE && SUN[0] < 0 && SUN[1] < 0, 'meshes and extrusions are lit from the same side');

// A 20 × 10 m five-storey block, anticlockwise and clockwise.
const rect = (w, h, x = 0, y = 0) => [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
const inside = (pts, x, y) => {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
};
const edgeGap = (pts, x, y) => Math.min(...pts.map((a, i) => {
  const b = pts[(i + 1) % pts.length], dx = b[0] - a[0], dy = b[1] - a[1], t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(a[0] + t * dx - x, a[1] + t * dy - y);
}));
const range = (mesh, name) => mesh.ranges.find(r => r.texture === TEXTURE[name]) ?? { first: 0, count: 0 };
const vertices = (mesh, name) => { const r = range(mesh, name); return Array.from({ length: r.count }, (_, i) => Array.from(mesh.decals.subarray((r.first + i) * 6, (r.first + i) * 6 + 6))); };
const counts = [];
for (const ring of [rect(20, 10), rect(20, 10).reverse()]) {
  const mesh = buildFacades([{ id: 'a', ring, height: 16 }]);
  const walls = vertices(mesh, 'block');
  const quads = Array.from({ length: walls.length / 6 }, (_, q) => walls.slice(q * 6, q * 6 + 6));
  const ground = quads.filter(q => Math.min(...q.map(v => v[2])) === 0), upper = quads.filter(q => Math.min(...q.map(v => v[2])) === 3);
  const doorOnly = buildFacades([{ id: 'a', ring, height: 16 }], { solidRadius: -1 });
  counts.push([ground.length * 6, upper.length * 6, range(mesh, 'shadow').count, range(mesh, 'roof').count, range(mesh, 'door').count, doorOnly.solids.length / 7, mesh.solids.length / 7]);
  for (const [x, y, z] of walls) {
    assert.ok(!inside(ring, x, y), 'wall decals stand outside the walls');
    const gap = edgeGap(ring, x, y);
    assert.ok(gap >= 0.05 && gap <= 0.07, `wall decals are 6 cm out (${gap})`);
    assert.ok(z >= 0 && z <= 15.01);
  }
  for (const q of quads) for (const v of q) assert.ok(Math.abs(v[3] - Math.round(v[3])) < 1e-9, 'bays end on whole repeats');
  for (const q of upper) for (const v of q) if (v[2] === 3) assert.equal(v[4], 4, 'the texture repeats every floor');
  for (const q of ground) for (const v of q) assert.equal(v[4], v[2] === 0 ? 1 : 0);
  // Canopy first, then the parapet: 72 vertices from 16 m to the coping 0.6 m above.
  for (let i = 30; i < 102; i++) { const z = mesh.solids[i * 7 + 2]; assert.ok(z >= 16 && z <= 16.9, `parapet height ${z}`); }
  for (const [x, y, z, u, v, shade] of vertices(mesh, 'door')) {
    assert.ok(z >= 0 && z <= 2.40001 && u >= 0 && u <= 1 && v >= 0 && v <= 1 && shade > 0);
    assert.ok(Math.abs(edgeGap(ring, x, y) - 0.1) < 1e-6, 'doors stand 10 cm out');
  }
  for (const [, , z] of vertices(mesh, 'roof')) assert.ok(Math.abs(z - 16.02) < 1e-5);
}
assert.deepEqual(counts[0], counts[1], 'winding does not matter');
const [ground, upper, shadow, roof, door, canopy, solids] = counts[0];
assert.deepEqual([ground, upper, shadow, roof, door, canopy], [24, 24, 24, 6, 6, 30]);
assert.ok(solids - canopy - 72 >= 30, 'stair housing and air-conditioning boxes on the roof');
const low = buildFacades([{ id: 'b', ring: rect(30, 10), height: 9 }]);
assert.equal(low.solids.length / 7, 30 + 72, 'a two-storey block: canopy and parapet, no rooftop boxes');
const gabled = buildFacades([{ id: 'a', ring: rect(20, 10), height: 16, roof: 'gabled' }]);
assert.equal(range(gabled, 'roof').count, 0, 'a pitched roof gets no flat roof');
assert.equal(gabled.solids.length / 7, 30, 'nor a parapet or rooftop boxes');
const shed = buildFacades([{ id: 'c', ring: rect(10, 8), height: 4 }]);
assert.deepEqual([range(shed, 'house').count, range(shed, 'door').count, shed.solids.length], [24, 0, 0], 'a one-storey house: one row of windows');
const shop = buildFacades([{ id: 'c', ring: rect(10, 8), height: 4, storefront: true }]);
assert.deepEqual([range(shop, 'shop').count, range(shop, 'house').count, range(shop, 'door').count], [24, 0, 6], 'a shop front and its door');
assert.equal(buildFacades([{ id: 'd', ring: rect(20, 10), height: 16, style: 'none' }]).houses, 0, "style 'none' is left bare");
const walled = buildFacades([{ id: 'e', ring: rect(20, 10), height: 16, holes: true }]);
assert.equal(range(walled, 'roof').count, 0, 'a courtyard house keeps its extruded roof');
assert.equal(walled.solids.length / 7, 30 + 72, 'and gets no rooftop boxes over its yard');
assert.equal(BAY.block, 3.3);

// Polygons.
const L = [[0, 0], [20, 0], [20, 8], [8, 8], [8, 20], [0, 20]];
const area = pts => Math.abs(pts.reduce((sum, p, i) => sum + p[0] * pts[(i + 1) % pts.length][1] - pts[(i + 1) % pts.length][0] * p[1], 0) / 2);
const inner = insetPolygon(L, 0.3);
assert.ok(inner && area(inner) < area(L) && area(inner) > area(L) * 0.9);
assert.ok(inner.every(([x, y]) => inside(L, x, y)));
assert.equal(insetPolygon(rect(20, 0.5), 0.3), null, 'a sliver has no inside');
const triangles = triangulate(L);
assert.equal(triangles.length, 12);
let covered = 0;
for (let i = 0; i < triangles.length; i += 3) covered += area([L[triangles[i]], L[triangles[i + 1]], L[triangles[i + 2]]]);
assert.ok(Math.abs(covered - area(L)) < 1e-6);
const lReversed = [...L].reverse(), t2 = triangulate(lReversed);
assert.ok(t2 && t2.length === 12);
const box = rectangleAround(rect(20, 10));
assert.ok(box && Math.abs(box.half[0] - 10) < 1e-9 && Math.abs(box.half[1] - 5) < 1e-9 && Math.abs(box.fill - 1) < 1e-9);
const solidsOut = [];
block(0, 0, 1, 1, 0, 1, 0, [1, 1, 1], solidsOut);
facet([[0, 0, 0], [1, 0, 0], [0, 1, 0]], [0, 0, -1], [1, 1, 1], solidsOut);
assert.equal(solidsOut.length / 7, 33);
assert.deepEqual(unit([3, 0, 4]), [0.6, 0, 0.8]);

// Shop fronts from place points.
const shops = [{ id: 'x', ring: rect(10, 10), height: 4 }, { id: 'y', ring: rect(10, 10, 30), height: 4 }, { id: 'z', ring: rect(10, 10, 60), height: 4 }];
assert.equal(markStorefronts(shops, [[5, 5], [45, 5]]), 2);
assert.deepEqual(shops.map(h => !!h.storefront), [true, true, false], 'a point inside marks its house, one 5 m off the nearest within 8 m');

// Country houses take their tone from the outline hash and rise by it, so overlapping copies'
// roofs stand apart; a given tone wins over the id's.
assert.deepEqual([outlineTone(8), outlineTone(15), outlineTone(2 ** 32 - 1)], [0, 7, 7]);
assert.ok(Math.abs(liftedHeight(4, 7) - 4.28) < 1e-9 && TONE_LIFT * 7 < 0.5 && storeys(liftedHeight(16, 7)) === storeys(16));
const toned = (tone) => buildFacades([{ id: 'same', ring: rect(20, 10), height: 16, tone }]).solids;
assert.notDeepEqual(toned(0), toned(5), 'the tone colours the parapet and rooftop boxes');

// A footprint stored twice is dressed once, as its taller copy.
const single = buildFacades([{ id: 'one', ring: rect(20, 10), height: 16 }]);
const twice = buildFacades([{ id: 'low', ring: rect(20, 10), height: 4 }, { id: 'one', ring: rect(20, 10), height: 16 }, { id: 'again', ring: rect(20, 10), height: 16 }]);
assert.equal(twice.houses, 1, 'duplicates are dressed once');
assert.deepEqual([twice.decals.length, twice.solids.length], [single.decals.length, single.solids.length], 'the taller copy is the one dressed');

// The budget keeps the nearest houses.
let seed = 7;
const random = () => ((seed = Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x9e3779b9 >>> 0) / 4294967296);
const many = Array.from({ length: 3000 }, (_, i) => {
  const angle = random() * Math.PI * 2, distance = Math.sqrt(random()) * 450, x = Math.cos(angle) * distance, y = Math.sin(angle) * distance;
  return { id: `r${i}`, ring: rect(8 + random() * 30, 8 + random() * 14, x, y), height: 3 + random() * 40, gap: distance };
});
const budget = buildFacades(many);
assert.ok(budget.decals.length / 6 <= MAX_DECAL_VERTICES && budget.skipped > 0 && budget.houses + budget.skipped <= 3000);
const kept = [...many].sort((a, b) => a.gap - b.gap);
assert.ok(kept[budget.houses + budget.skipped - 1].gap >= kept[budget.houses - 1].gap, 'the houses left out are the farthest');
assert.equal(budget.ranges.reduce((sum, r) => sum + r.count, 0), budget.decals.length / 6, 'ranges cover the decals');
assert.ok(budget.ranges.every((r, i) => i === 0 || r.first === budget.ranges[i - 1].first + budget.ranges[i - 1].count));

// Trees: along a 2 + 2 lane avenue and in a park, never on a house or the carriageway.
const avenue = { id: 'way/1', line: [[-200, 0], [0, 0], [200, 0]], asphalt: 2, oneway: false };
const side = { id: 'way/2', line: [[0, -150], [0, 0]], asphalt: 1, oneway: false };
const houses = [rect(12, 12, -40, 12), rect(20, 10, 40, -25)];
const isFree = openGround(houses, [avenue, side], [[100, 10]]);
const street = streetTrees([avenue, side], isFree, { centre: [0, 0], radius: 180, max: 120 });
assert.ok(street.length > 20 && street.length <= 120, `street trees ${street.length}`);
for (const tree of street) {
  assert.ok(!houses.some(ring => inside(ring, tree.x, tree.y) || edgeGap(ring, tree.x, tree.y) < 2), 'no tree in a house');
  assert.ok(Math.abs(tree.y) > 6.8 + 1.2 || Math.abs(tree.x) > 3.4 + 1.2, 'no tree on the carriageway');
  assert.ok(Math.hypot(tree.x, tree.y) > 14, 'no tree in the junction');
  assert.ok(Math.hypot(tree.x - 100, tree.y - 10) >= 5, 'mapped trees keep their room');
  assert.ok(tree.height >= 7 && tree.height <= 10 && tree.crown >= 2.2 && tree.crown <= 3);
}
assert.deepEqual(streetTrees([avenue], isFree, { centre: [0, 0], radius: 180, max: 5 }).length, 5);
assert.equal(streetTrees([{ id: 'lane', line: [[-200, 50], [200, 50]], asphalt: 0 }], () => true).length, 0, 'narrow lanes stay bare');
const park = [[-150, 30], [-40, 30], [-40, 110], [-90, 140], [-150, 110]];
const pitch = [[60, 30], [120, 30], [120, 70], [60, 70]];
const parks = parkTrees([park, pitch], isFree, { centre: [0, 0], radius: 400 });
assert.ok(parks.length > 15 && parks.every(t => inside(park, t.x, t.y)), 'trees in the park, none on the pitch');
assert.equal(parkTrees([park, park], isFree, { centre: [0, 0], radius: 400 }).length, parks.length, 'a park cut in two tiles is planted once');
const tree = [];
lowTreeTriangles(0, 0, 8, 2.5, 0, tree);
assert.equal(tree.length / 7, TREE_VERTICES);
// A street across a river: no tree stands in the water along its bridge.
const river = [[-60, -300], [60, -300], [60, 300], [-60, 300]];
const bridge = { id: 'way/3', line: [[-250, 0], [250, 0]], asphalt: 2, oneway: false };
const dry = streetTrees([bridge], openGround([], [bridge], [], [river]), { centre: [0, 0], radius: 300 });
assert.ok(dry.length > 20 && dry.every(t => Math.abs(t.x) > 60), 'no street tree in the water');
assert.ok(streetTrees([bridge], openGround([], [bridge], []), { centre: [0, 0], radius: 300 }).some(t => Math.abs(t.x) < 60));

// World-fixed patterns: a roof pattern and a park grid seen from two origins 90 m apart (one due
// north-east of the other) stay where they are in the world, with small texture coordinates.
const EARTH = 2 * Math.PI * 6371008.8;
const mercator = (lon, lat) => [(lon + 180) / 360, 0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI)];
const scaleAt = my => 1 / (EARTH * Math.cos(Math.atan(Math.sinh(Math.PI * (1 - 2 * my)))));
const [ax, ay] = mercator(69.6227, 40.2824), [bx, by] = [ax + 64 * scaleAt(ay), ay - 64 * scaleAt(ay)];
const corner = [ax + 380 * scaleAt(ay), ay - 150 * scaleAt(ay)];  // a house's corner, in the world
const roofAt = (ox, oy) => {
  const s = scaleAt(oy), x = (corner[0] - ox) / s, y = (oy - corner[1]) / s;
  const mesh = buildFacades([{ id: 'w', ring: rect(24, 12, x, y), height: 9 }], worldRoof(ox, oy, s));
  const [first] = vertices(mesh, 'roof').filter(v => Math.hypot(v[0] - x - 0.3, v[1] - y - 0.3) < 1e-3);
  assert.ok(first, 'the roof has the inset corner');
  for (const v of vertices(mesh, 'roof')) assert.ok(v[3] >= 0 && v[3] < 6 && v[4] >= 0 && v[4] < 4, `roof texture coordinates stay small (${v[3]}, ${v[4]})`);
  return [first[3] % 1, first[4] % 1];
};
const [roofA, roofB] = [roofAt(ax, ay), roofAt(bx, by)];
assert.ok(Math.abs(roofA[0] - roofB[0]) < 1e-4 && Math.abs(roofA[1] - roofB[1]) < 1e-4, `the roof pattern holds still (${roofA} / ${roofB})`);
assert.ok(Math.abs(worldRoof(ax, ay, scaleAt(ay)).roofSize - 6 * WORLD_METRE / scaleAt(ay)) < 1e-12);
const parkAt = (ox, oy) => {
  const s = scaleAt(oy), local = ([lon, lat]) => { const [mx, my] = mercator(lon, lat); return [(mx - ox) / s, (oy - my) / s]; };
  const ring = [[69.6205, 40.2805], [69.6235, 40.2805], [69.6235, 40.2830], [69.6205, 40.2830]].map(local);
  return parkTrees([ring], () => true, { centre: [0, 0], radius: 1000, max: 5000, ...worldGrid(ox, oy, s) })
    .map(t => [ox + t.x * s, oy - t.y * s]).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
};
const [parkA, parkB] = [parkAt(ax, ay), parkAt(bx, by)];
assert.ok(parkA.length > 100 && parkA.length === parkB.length, `the same park trees (${parkA.length} / ${parkB.length})`);
assert.ok(parkA.every((p, i) => Math.hypot(p[0] - parkB[i][0], p[1] - parkB[i][1]) / scaleAt(ay) < 0.01), 'park trees hold still across rebuilds');

// Central Khujand from the house files: within budget and quick.
const root = new URL('../public/atlas-houses/', import.meta.url);
const CIRCUMFERENCE = 2 * Math.PI * 6371008.8, GROUP = 65536;
const [lon, lat] = [69.6227, 40.2824], R = 450;
const X = (lon + 180) / 360 * HOUSE_UNIT, Y = (0.5 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / (2 * Math.PI)) * HOUSE_UNIT;
const metres = CIRCUMFERENCE * Math.cos(lat * Math.PI / 180) / HOUSE_UNIT, reach = R / metres;
const real = [];
let estimated = 0;
for (let gx = Math.floor((X - reach) / GROUP); gx <= Math.floor((X + reach) / GROUP); gx++) for (let gy = Math.floor((Y - reach) / GROUP); gy <= Math.floor((Y + reach) / GROUP); gy++) {
  const file = new URL(`${gx}-${gy}.bin`, root);
  if (!existsSync(file)) continue;
  const bytes = readFileSync(file), index = indexHouses(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  for (const house of housesNear(index, gx, gy, X, Y, reach)) {
    const ring = [];
    for (let i = 0; i < house.points.length; i += 2) ring.push([(house.points[i] - X) * metres, (Y - house.points[i + 1]) * metres]);
    if (house.estimated) estimated++;
    real.push({ id: `cty:${gx}-${gy}:${house.index}`, ring, height: house.height || 4, style: house.style, gap: house.gap * metres });
  }
}
assert.ok(real.length > 500, `central Khujand has houses (${real.length})`);
// The machine may be busy with other work: the build's own cost is the processor time this
// process spends on it (not the wall clock, which waits for other programs), best of five.
let khujand, took = Infinity, wall = Infinity;
for (let run = 0; run < 5; run++) {
  const started = performance.now(), cpu = process.cpuUsage();
  khujand = buildFacades(real, { solidRadius: 320 });
  const used = process.cpuUsage(cpu);
  took = Math.min(took, (used.user + used.system) / 1000);
  wall = Math.min(wall, performance.now() - started);
}
const decalCount = khujand.decals.length / 6, solidCount = khujand.solids.length / 7;
assert.equal(khujand.skipped, 0);
assert.ok(decalCount < 90_000, `decals ${decalCount}`);
assert.ok(solidCount < 40_000, `solids ${solidCount}`);
assert.ok(took < 150, `built in ${took.toFixed(0)} ms of processor time (${wall.toFixed(0)} ms on the clock)`);

console.log(`PASS facades: 20 × 10 m block ${ground}+${upper} window, ${shadow} shadow, ${roof} roof, ${door} door vertices, ${solids} solid; tones ${buckets.join('/')}; budget kept ${budget.houses} of 3000 nearest; ${street.length} street and ${parks.length} park trees clear of houses, asphalt and water; roof pattern and ${parkA.length} park trees fixed to the world; central Khujand ${real.length} houses (${estimated} estimated heights): ${decalCount} decal + ${solidCount} solid vertices (${((decalCount * 24 + solidCount * 28) / 1e6).toFixed(2)} MB) in ${took.toFixed(0)} ms of processor time (${wall.toFixed(0)} ms on the clock)`);
