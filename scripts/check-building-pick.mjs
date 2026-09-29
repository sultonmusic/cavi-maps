// Checks the line-of-sight building pick: the pure ray geometry of lib/building-ray.mjs against hand-worked
// cases and a brute-force march along random lines of sight, then lib/building-pick.ts against a stand-in
// map with a real pinhole camera, including the Khujand case where a tap on a tower's roof used to land
// on the ground behind it. Runs in node in well under a second.
import assert from 'node:assert/strict';
import {
  EARTH_CIRCUMFERENCE, closeRing, floorsLabel, floorsOf, insideRing, insideRings, mercator, metricFrame,
  rayPrism, rayRoof, raySolid, ringCentre, roofBox, roofRise,
} from '../lib/building-ray.mjs';
import { countryKey, groundDistance, isShaydonKey, liftOffset, pickBuilding, standsBefore } from '../lib/building-pick.ts';

const near = (a, b, e = 1e-9, what = '') => assert.ok(a !== null && Math.abs(a - b) < e, `${what} ${a} ≈ ${b}`);
const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]];

// ---------------------------------------------------------------------------------------------------
// 1. Pure geometry, worked by hand. The camera is 100 m south of the ground point and 50 m up.
const camera = [0, -100, 50], ground = [0, 0];
near(rayPrism(camera, ground, box(-10, -40, 10, -20), 0, 30), 0.6, 1e-9, 'front wall, met 20 m up');
assert.equal(rayPrism(camera, ground, box(-10, 10, 10, 30), 0, 60), null, 'a tower behind the tapped ground never wins');
near(rayPrism(camera, ground, box(-10, -95, 10, -50), 0, 45), 0.1, 1e-9, 'in through the roof');
assert.equal(rayPrism(camera, ground, box(-3, -8, 3, -2), 0, 0.9), null, 'the line clears low walls');
assert.ok(rayPrism(camera, ground, box(-10, -60, 10, -50), 0, 30) < rayPrism(camera, ground, box(-10, -40, 10, -20), 0, 30), 'front-most first');
// Camera lower than the roof: outside the building it meets the near wall; inside it sees out (the
// map culls back faces), so nothing is hit.
near(rayPrism([0, -30, 50], ground, box(-10, -10, 10, 10), 0, 80), 20 / 30, 1e-9, 'camera below the roof, outside');
assert.equal(rayPrism([0, -5, 50], ground, box(-10, -10, 10, 10), 0, 80), null, 'camera inside the building');
assert.equal(rayPrism([0, -100, 0], ground, box(-10, -40, 10, -20), 0, 30), null, 'camera on the ground');
assert.equal(rayPrism(camera, ground, box(-10, -40, 10, -20), 0, 0), null, 'a building with no height');
// Open and closed outlines, either winding, give the same answer.
const open = box(-10, -40, 10, -20).slice(0, 4);
near(rayPrism(camera, ground, open, 0, 30), 0.6, 1e-9, 'open outline');
near(rayPrism(camera, ground, [...open].reverse(), 0, 30), 0.6, 1e-9, 'clockwise outline');

// A concave L: the line passes over the notch without touching the building, and one landing in the
// notch meets the inner walls.
const ell = [[-20, -60], [20, -60], [20, -50], [-10, -50], [-10, -20], [-20, -20], [-20, -60]];
assert.equal(insideRing([5, -40], ell), false, 'the notch is outside');
assert.equal(rayPrism([5, -100, 50], [5, -30], ell, 0, 8), null, 'over the notch, past the low arm');
near(rayPrism([5, -100, 50], [5, -30], ell, 0, 30), 40 / 70, 1e-9, 'taller, the front wall stops it');
// Standing in the notch looking west, the line meets the inner wall x = -10 of the long arm.
near(rayPrism([10, -35, 20], [-30, -35], ell, 0, 12), 0.5, 1e-9, 'inner wall of the L');

// Grazing: a line through a corner meets it there; a centimetre aside it passes by; a line running
// along a wall's own line meets the wall's end.
{
  const square = box(0, 0, 10, 10);
  near(rayPrism([-10, -10, 4], [10, 10], square, 0, 5), 0.5, 1e-9, 'in through the corner (0, 0)');
  const graze = rayPrism([-10, 10, 4], [10, -10], square, 0, 5);
  assert.ok(graze === null || Math.abs(graze - 0.5) < 1e-9, 'touching only the corner: there or nowhere');
  assert.equal(rayPrism([-10, -0.01, 4], [20, -0.01], square, 0, 5), null, 'a centimetre past the wall');
  assert.equal(rayPrism([-10, 9.99, 4], [9.99, -10], square, 0, 5), null, 'a centimetre past the corner');
  near(rayPrism([-10, 10.01, 4], [10.01, -10], square, 0, 5), 0.5, 1e-3, 'a centimetre inside the corner');
  const along = rayPrism([-10, 0, 4], [20, 0], square, 0, 5);
  assert.ok(along === null || (along >= 0 && along <= 1), 'along a wall line: a hit or none, never NaN');
  near(rayPrism([-10, 10, 2], [30, 10], square, 0, 5), 0.25, 1e-9, 'along the top wall line meets its end');
}

// Courtyards: the line may fall into the yard and meet its far wall, or land on the yard's ground.
{
  const rings = [box(-20, -20, 20, 20), box(-10, -10, 10, 10)];
  assert.equal(insideRings([0, 0], rings), false, 'the yard is not the building');
  assert.equal(insideRings([15, 0], rings), true, 'the wing is');
  assert.equal(raySolid([0, -5, 100], [0, 0], rings, 0, 10), null, 'straight down into the yard');
  near(raySolid([0, -100, 50], [0, 5], rings, 0, 10), 0.8, 1e-9, 'onto the south wing\'s roof');
  near(raySolid([0, -100, 50], [0, -5], rings, 0, 10), 80 / 95, 1e-9, 'the outer south wall');
  near(raySolid([0, -5, 10], [0, 20], rings, 0, 10), 0.6, 1e-9, 'across the yard into its north wall');
  assert.equal(raySolid([0, -15, 8], [0, 20], rings, 0, 10), null, 'a camera inside the wing');
}

assert.ok(insideRing([1, 1], box(0, 0, 2, 2)) && !insideRing([3, 1], box(0, 0, 2, 2)));
assert.deepEqual(ringCentre(box(0, 0, 2, 4)), [1, 2]);
assert.deepEqual(ringCentre(box(0, 0, 2, 4).slice(0, 4)), [1, 2]);
assert.deepEqual(closeRing([[0, 0], [1, 0], [1, 1]]), [[0, 0], [1, 0], [1, 1], [0, 0]]);
assert.deepEqual(closeRing([]), []);
near(metricFrame(68.78, 38.57)([68.781, 38.57])[0], 86.93, 0.05, 'a thousandth of a degree east');
near(metricFrame(68.78, 38.57)([68.78, 38.571])[1], 111.19, 0.1, 'a thousandth of a degree north');
near(metricFrame(68.78, 38.57, 40)([68.781, 38.57])[0], 86.93 * Math.cos(40 * Math.PI / 180) / Math.cos(38.57 * Math.PI / 180), 0.05, 'scale latitude');
assert.deepEqual([floorsOf(4), floorsOf(7), floorsOf(28), floorsOf(40), floorsOf(0), floorsOf(3)], [1, 2, 9, 13, 0, 0]);
assert.deepEqual([1, 2, 5, 11, 13, 21, 22, 104, 112].map(floorsLabel),
  ['1 этаж', '2 этажа', '5 этажей', '11 этажей', '13 этажей', '21 этаж', '22 этажа', '104 этажа', '112 этажей']);

// Roof rectangles: the long side leads, whatever the outline's turn or winding.
{
  const angle = 0.4, c = Math.cos(angle), s = Math.sin(angle);
  const turned = box(-8, -3, 8, 3).map(([x, y]) => [x * c - y * s + 100, x * s + y * c - 50]);
  const fit = roofBox(turned);
  near(fit.half[0], 8, 1e-9, 'long half'); near(fit.half[1], 3, 1e-9, 'short half'); near(fit.fill, 1, 1e-9, 'fill');
  near(Math.abs(fit.along[0] * c + fit.along[1] * s), 1, 1e-9, 'ridge along the long side');
  near(fit.centre[0], 100, 1e-9); near(fit.centre[1], -50, 1e-9);
  near(roofRise(fit), 3 * Math.tan(Math.PI / 6), 1e-12, 'rise');
  near(roofRise(roofBox(box(0, 0, 60, 40))), 8, 1e-12, 'rise is capped at 8 m');
  assert.equal(roofRise(roofBox(ell)), 0, 'an L keeps a flat top');
  assert.equal(roofBox([[0, 0], [1, 1], [2, 2], [0, 0]]), null, 'a line has no rectangle');
}

// ---------------------------------------------------------------------------------------------------
// 2. Random lines of sight against a brute-force march: the exact entry must be where the line first
//    comes inside, with nothing inside before it, and a miss must never be inside anywhere.
let seed = 0x5eed;
const random = () => { seed = (seed + 0x6d2b79f5) | 0; let t = seed; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const between = (a, b) => a + (b - a) * random();
const STEPS = 1500, EPS = 1e-7;
function march(camera, ground, inside, exact, label) {
  const at = t => [camera[0] + (ground[0] - camera[0]) * t, camera[1] + (ground[1] - camera[1]) * t, camera[2] * (1 - t)];
  if (inside(at(0))) { assert.equal(exact, null, `${label}: a camera inside sees nothing`); return 'inside'; }
  const end = exact === null ? 1 : exact;
  for (let i = 0; i <= STEPS; i++) {
    const t = end * i / STEPS - (exact === null ? 0 : EPS);
    if (t > 0 && inside(at(t))) assert.fail(`${label}: inside at t=${t} before the reported ${exact}`);
  }
  if (exact === null) return 'miss';
  assert.ok(exact > 0 && exact <= 1, `${label}: t in (0, 1]`);
  assert.ok(inside(at(Math.min(1, exact + EPS))) || exact + EPS > 1, `${label}: inside just after ${exact}`);
  return 'hit';
}
const tally = { hit: 0, miss: 0, inside: 0 };
const shapes = {
  box: [box(-10, -6, 12, 9)],
  ell: [ell.map(([x, y]) => [x, y + 40])],
  yard: [box(-20, -20, 20, 20), box(-8, -12, 9, 8)],
  zigzag: [[[-15, -10], [15, -10], [15, 10], [5, 0], [0, 10], [-5, 0], [-15, 10], [-15, -10]]],
};
for (const [name, rings] of Object.entries(shapes)) {
  for (let n = 0; n < 400; n++) {
    const cam = [between(-70, 70), between(-70, 70), between(2, 120)], gr = [between(-24, 24), between(-24, 24)];
    const base = random() < 0.2 ? between(0, 5) : 0, top = base + between(1, 60);
    const inside = ([x, y, z]) => z >= base && z <= top && insideRings([x, y], rings);
    tally[march(cam, gr, inside, raySolid(cam, gr, rings, base, top), `${name} #${n}`)]++;
  }
}
for (const shape of ['gabled', 'hipped', 'pyramidal']) {
  for (const [a, b] of [[8, 3], [5, 5], [20, 12], [6, 5.97]]) {
    const angle = between(0, Math.PI), c = Math.cos(angle), s = Math.sin(angle), ox = between(-5, 5), oy = between(-5, 5);
    const ring = box(-a, -b, a, b).map(([x, y]) => [ox + x * c - y * s, oy + x * s + y * c]);
    const fit = roofBox(ring), rise = roofRise(fit), base = between(3, 30);
    // The roof as roofTriangles draws it, height by height.
    const height = (u, v) => {
      const across = 1 - Math.abs(v) / b;
      if (shape === 'gabled') return across;
      if (shape === 'hipped' && a - b > 0.05) return Math.min(across, (a - Math.abs(u)) / b);
      return Math.min(across, 1 - Math.abs(u) / a);
    };
    const inside = ([x, y, z]) => {
      const dx = x - fit.centre[0], dy = y - fit.centre[1];
      const u = dx * fit.along[0] + dy * fit.along[1], v = dy * fit.along[0] - dx * fit.along[1];
      return Math.abs(u) <= fit.half[0] && Math.abs(v) <= fit.half[1] && z >= base && z <= base + rise * height(u, v);
    };
    for (let n = 0; n < 250; n++) {
      const cam = [ox + between(-50, 50), oy + between(-50, 50), base + between(-2, 40)], gr = [ox + between(-14, 14), oy + between(-14, 14)];
      if (!(cam[2] > 0)) continue;
      tally[march(cam, gr, inside, rayRoof(cam, gr, fit, shape, base), `${shape} ${a}x${b} #${n}`)]++;
    }
  }
}
assert.ok(tally.hit > 1200 && tally.miss > 1200, `both hits and misses exercised: ${JSON.stringify(tally)}`);

// ---------------------------------------------------------------------------------------------------
// 3. pickBuilding on a stand-in map: a pinhole camera like MapLibre's, looking at the map's centre.
const LON = 69.6232, LAT = 40.2815; // Khujand, the reported tap
const K = EARTH_CIRCUMFERENCE * Math.cos(LAT * Math.PI / 180), [OX, OY] = mercator(LON, LAT);
/** Metres east and north of the centre back to lon/lat. */
const lonLat = ([x, y]) => {
  const mx = OX + x / K, my = OY - y / K;
  return [mx * 360 - 180, 360 / Math.PI * Math.atan(Math.exp((180 - my * 360) * Math.PI / 180)) - 90];
};
const toMetres = metricFrame(LON, LAT);
function standIn({ pitch = 60, bearing = 0, distance = 300, width = 800, height = 600, features = [], layers = ['admin-3d', 'houses-3d', 'country-3d'], broken = false } = {}) {
  const p = pitch * Math.PI / 180, b = bearing * Math.PI / 180, h = [Math.sin(b), Math.cos(b)];
  const eye = [-h[0] * distance * Math.sin(p), -h[1] * distance * Math.sin(p), distance * Math.cos(p)];
  const forward = [h[0] * Math.sin(p), h[1] * Math.sin(p), -Math.cos(p)], right = [Math.cos(b), -Math.sin(b), 0];
  const up = [h[0] * Math.cos(p), h[1] * Math.cos(p), Math.sin(p)], focal = height / 2 / Math.tan(0.6435011087932844 / 2);
  const dot = (a, c) => a[0] * c[0] + a[1] * c[1] + a[2] * c[2];
  const screen = point => {
    const v = [point[0] - eye[0], point[1] - eye[1], (point[2] ?? 0) - eye[2]], depth = dot(v, forward);
    return { x: width / 2 + focal * dot(v, right) / depth, y: height / 2 - focal * dot(v, up) / depth };
  };
  const queried = [];
  const map = {
    getLayer: id => (layers.includes(id) ? { id } : undefined),
    getCenter: () => ({ lng: LON, lat: LAT }),
    queryRenderedFeatures: (area, options) => { queried.push({ area, options }); return features.filter(f => options.layers.includes(f.layer.id)); },
    unproject: ([x, y]) => {
      const d = [0, 1, 2].map(i => forward[i] * focal + right[i] * (x - width / 2) - up[i] * (y - height / 2));
      const s = -eye[2] / d[2], [lon, lat] = lonLat([eye[0] + d[0] * s, eye[1] + d[1] * s]);
      return { lng: lon, lat };
    },
    transform: {
      width, height,
      getCameraLngLat: () => { if (broken) throw new Error('no camera'); const [lon, lat] = lonLat(eye); return { lng: lon, lat }; },
      getCameraAltitude: () => eye[2],
      getProjectionDataForCustomLayer: () => {
        // Web Mercator (x, y, z) to clip space, built from the same camera: rows for x, y and w.
        const m = new Float64Array(16), put = (row, [a, c, e, f]) => { m[row] = a; m[4 + row] = c; m[8 + row] = e; m[12 + row] = f; };
        // Local metres are (mx - OX) K east, (OY - my) K north and mz K up.
        const axis = (vec, scale) => [vec[0] * K * scale, -vec[1] * K * scale, vec[2] * K * scale, 0];
        const affine = (vec, scale) => { const [a, c, e] = axis(vec, scale); return [a, c, e, -(a * OX + c * OY) - scale * dot(vec, eye)]; };
        put(0, affine(right, focal / (width / 2)));
        put(1, affine(up, focal / (height / 2)));
        put(3, affine(forward, 1));
        return { mainMatrix: m };
      },
    },
  };
  return { map, screen, queried, eye };
}
const feature = (layer, key, ring, extra = {}) => ({
  layer: { id: layer }, properties: { key, ...extra },
  geometry: { type: 'Polygon', coordinates: [ring.map(lonLat)] },
});
const record = (key, source, ring, height, extra = {}) => ({ key, source, ring: ring.map(lonLat), height, ...extra });
const catalogueOf = (known = [], solids = [], layers = ['admin-3d', 'houses-3d', 'country-3d']) => {
  const byKey = new Map(known.map(item => [item.key, item]));
  return { layers, known: key => byKey.get(key), solids: () => solids };
};

{
  // The report: a 40 m tower, a low house in front of it and a block behind. MapLibre lists the block
  // first, and the tap on the tower's roof lands on the ground 100 m behind the tower.
  const tower = box(-10, 40, 10, 60), front = box(-8, 10, 8, 20), behind = box(-15, 150, 15, 175);
  const features = [
    feature('country-3d', 'cty:2840-1546:9', behind, { height: 12 }),
    feature('country-3d', 'cty:2840-1546:12267', tower, { height: 40, stated: 1 }),
    feature('country-3d', 'cty:2840-1546:4', front, { height: 6 }),
  ];
  const { map, screen, queried, eye } = standIn({ features });
  const roofPoint = screen([0, 50, 40]), tapped = map.unproject([roofPoint.x, roofPoint.y]);
  const groundBehind = toMetres([tapped.lng, tapped.lat]);
  assert.ok(groundBehind[1] > 100, `the old pick used the ground ${groundBehind[1].toFixed(0)} m north, behind the tower`);
  const hit = pickBuilding(map, roofPoint, catalogueOf());
  assert.equal(hit?.key, 'cty:2840-1546:12267', 'the tower, not the ground or the block behind it');
  assert.equal(hit.source, 'country'); assert.equal(hit.stated, true); assert.equal(hit.height, 40); assert.equal(hit.exact, true);
  const [cx, cy] = toMetres([hit.lon, hit.lat]);
  near(cx, 0, 1e-4, 'centre east'); near(cy, 50, 1e-4, 'centre north'); // averaged in degrees
  near(hit.distance, Math.hypot(0 - eye[0], 50 - eye[1], 40 - eye[2]), 1e-3, 'distance to the roof point');
  assert.deepEqual(hit.shape.coordinates[0], hit.ring); assert.equal(hit.ring.length, 5);
  assert.equal(queried[0].options.layers.join(), 'admin-3d,houses-3d,country-3d');
  assert.deepEqual(queried[0].area, [[roofPoint.x - 9, roofPoint.y - 9], [roofPoint.x + 9, roofPoint.y + 9]]);
  // Every pixel up the tower's face, from its foot to just under its roof edge, is the tower.
  const foot = screen([0, 40, 0]), top = screen([0, 40, 40]);
  for (let y = foot.y - 1; y > top.y + 1; y -= 5) assert.equal(pickBuilding(map, { x: foot.x, y }, catalogueOf())?.key, 'cty:2840-1546:12267', `face at y=${y}`);
  // Above the roof's far edge the line of sight goes on to the block behind.
  const far = screen([0, 60, 40]), block = screen([0, 150, 12]);
  const beyond = pickBuilding(map, { x: far.x, y: (far.y + block.y) / 2 - 20 }, catalogueOf());
  assert.ok(beyond === null || beyond.key === 'cty:2840-1546:9', 'past the silhouette: whatever is behind, never the tower');
  // A street label anchored on the ground behind the tower does not win the tap; one in front does.
  const [behindLon, behindLat] = lonLat([0, 120]), [frontLon, frontLat] = lonLat([0, 30]);
  assert.equal(standsBefore(map, hit, behindLon, behindLat), true, 'label behind the tower');
  assert.equal(standsBefore(map, hit, frontLon, frontLat), false, 'label in front of the tower');
  near(groundDistance(map, frontLon, frontLat), Math.hypot(0 - eye[0], 30 - eye[1], eye[2]), 1e-3, 'ground distance');
  // Pins lifted onto the roof: 40 m up is the roof point on screen.
  const [lon, lat] = lonLat([0, 50]), base = screen([0, 50, 0]), [dx, dy] = liftOffset(map, lon, lat, 40);
  near(dx, roofPoint.x - base.x, 0.05, 'lift x'); near(dy, roofPoint.y - base.y, 0.05, 'lift y');
  assert.ok(dy < -50, 'lifted up the screen');
}

{
  // A finger a few pixels off the building's edge still gets it, but not as an exact hit, so a label
  // right under the finger keeps the tap.
  const house = box(-6, -6, 6, 6);
  const { map, screen } = standIn({ features: [feature('houses-3d', 'ms:7', house, { height: 7 })] });
  const edge = screen([6, 0, 7]);
  const hit = pickBuilding(map, { x: edge.x + 5, y: edge.y }, catalogueOf());
  assert.equal(hit?.key, 'ms:7'); assert.equal(hit.exact, false);
  const [lon, lat] = lonLat([0, 200]);
  assert.equal(standsBefore(map, hit, lon, lat), false, 'an inexact hit never hides a label');
  assert.equal(pickBuilding(map, { x: edge.x + 30, y: edge.y }, catalogueOf()), null, 'too far off');
}

{
  // GeoJSON tiles cut outlines: the catalogue's whole outline is what is tested and returned, and its
  // centre is the whole house's centre.
  const whole = box(-10, -5, 10, 5), piece = box(-10, -5, 0, 5);
  const known = record('ms:3', 'houses', whole, 10, { number: 12, street: 'улица 87', levels: 3, stated: true });
  const { map, screen } = standIn({ features: [feature('houses-3d', 'ms:3', piece, { height: 10 })] });
  const point = screen([5, 0, 10]); // on the part the tile cut away
  const hit = pickBuilding(map, point, catalogueOf([known]));
  assert.equal(hit?.key, 'ms:3'); assert.equal(hit.number, 12); assert.equal(hit.street, 'улица 87'); assert.equal(hit.levels, 3);
  const [cx, cy] = toMetres([hit.lon, hit.lat]);
  near(cx, 0, 1e-4); near(cy, 0, 1e-4);
  // Without the catalogue's copy, the feature's own properties still name the house.
  const bare = pickBuilding(map, screen([-5, 0, 10]), catalogueOf());
  assert.equal(bare?.key, 'ms:3'); assert.equal(bare.source, 'houses'); assert.equal(bare.stated, false);
}

{
  // A pitched roof is its own mesh: at a steep tilt, the line of sight through the roof just under its
  // ridge passes over the walls' flat top, so only the roof test finds the house.
  const walls = box(-5, -60, 5, -54), house = record('admin:roofed', 'admin', walls, 3, { label: 'Дом культуры' });
  const { map, screen } = standIn({ pitch: 70, features: [] });
  const rise = 3 * Math.tan(Math.PI / 6), target = screen([0, -57.2, 3 + rise * (1 - 0.2 / 3) - 0.01]);
  assert.notEqual(pickBuilding(map, target, catalogueOf([house], [{ record: house }]))?.exact, true, 'walls alone: not under the finger');
  const hit = pickBuilding(map, target, catalogueOf([house], [{ record: house, roof: 'gabled', base: 3 }]));
  assert.equal(hit?.key, 'admin:roofed'); assert.equal(hit.label, 'Дом культуры'); assert.equal(hit.exact, true);
  // Just over the ridge the line goes on (the far slope is hidden behind the ridge).
  const over = screen([0, -57, 3 + rise + 0.3]);
  assert.equal(pickBuilding(map, { x: over.x, y: over.y - 6 }, catalogueOf([house], [{ record: house, roof: 'gabled', base: 3 }]))?.exact ?? false, false);
}

{
  // A landmark mesh and an admin drawing over a surveyed footprint: the more specific source wins a tie,
  // the nearer one wins otherwise.
  const stadium = box(-40, 80, 40, 140), shared = box(-5, 0, 5, 10);
  const landmark = { record: record('landmark:national-stadium', 'landmark', stadium, 33, { label: 'Национальный стадион' }), top: 33 };
  const admin = record('admin:a1', 'admin', shared, 9);
  const features = [feature('houses-3d', 'ms:1', shared, { height: 9 }), feature('admin-3d', 'admin:a1', shared, { height: 9 })];
  const { map, screen } = standIn({ features });
  assert.equal(pickBuilding(map, screen([0, 5, 9]), catalogueOf([admin], [landmark]))?.key, 'admin:a1', 'admin over its footprint');
  const hit = pickBuilding(map, screen([0, 110, 33]), catalogueOf([admin], [landmark]));
  assert.equal(hit?.key, 'landmark:national-stadium'); assert.equal(hit.source, 'landmark');
  // A solid far from the line of sight is skipped without being measured.
  let touched = 0;
  const far = { record: { ...record('landmark:far', 'landmark', box(2000, 2000, 2100, 2100), 50), get ring() { touched++; return box(2000, 2000, 2100, 2100).map(lonLat); } }, top: 50 };
  assert.equal(pickBuilding(map, screen([0, 5, 9]), catalogueOf([admin], [far]))?.key, 'admin:a1');
  assert.ok(touched <= 1, 'far solids are ruled out by their bounds');
}

{
  // Above the horizon (only with more tilt than the map allows) no line of sight reaches the ground, and
  // MapLibre's reported point lies behind the camera: MapLibre's own order stands, as without a camera.
  const tower = box(-10, 40, 10, 60);
  const { map } = standIn({ pitch: 70, features: [feature('country-3d', 'cty:1-2:3', tower, { height: 40 })] });
  const sky = pickBuilding(map, { x: 400, y: -2000 }, catalogueOf());
  assert.equal(sky?.key, 'cty:1-2:3'); assert.equal(sky.exact, false); assert.equal(sky.distance, Infinity);
  assert.equal(pickBuilding(standIn({ pitch: 70 }).map, { x: 400, y: -2000 }, catalogueOf()), null, 'sky with nothing drawn');
  const broken = standIn({ broken: true, features: [feature('country-3d', 'cty:1-2:3', tower, { height: 40 })] });
  const hit = pickBuilding(broken.map, { x: 400, y: 300 }, catalogueOf());
  assert.equal(hit?.key, 'cty:1-2:3'); assert.equal(hit.distance, Infinity); assert.equal(hit.exact, false);
  assert.equal(groundDistance(broken.map, LON, LAT), Infinity);
  assert.equal(standsBefore(broken.map, hit, LON, LAT), false);
  const empty = standIn({ layers: [] });
  assert.equal(pickBuilding(empty.map, { x: 400, y: 300 }, catalogueOf()), null, 'no layers, no solids');
}

{
  // Straight down, a tap inside a footprint is its roof.
  const house = box(-6, -6, 6, 6);
  const { map, screen } = standIn({ pitch: 0, features: [feature('houses-3d', 'osm:way/5', house, { height: 4 })] });
  const hit = pickBuilding(map, screen([2, 2, 0]), catalogueOf());
  assert.equal(hit?.key, 'osm:way/5'); assert.equal(hit.exact, true);
  assert.equal(pickBuilding(map, screen([20, 20, 0]), catalogueOf()), null, 'bare ground');
}

assert.equal(countryKey('2840-1546', 12267), 'cty:2840-1546:12267');
assert.deepEqual(['ms:1', 'osm:way/2', 'admin:x', 'cty:1-2:3', 'landmark:y'].map(isShaydonKey), [true, true, false, false, false]);

console.log(`building pick: ok (${tally.hit} hits, ${tally.miss} misses, ${tally.inside} inside against the march)`);
