import assert from 'node:assert/strict';
import { distance, buildManeuvers, projectOnRoute, navigationSnapshot } from '../lib/navigation.ts';

const near = (actual, expected, delta = 1) => assert.ok(Math.abs(actual - expected) <= delta, `${actual} ≈ ${expected}`);
const origin = [40.65, 70.38];
const north = [40.651, 70.38];
const east = [40.651, 70.381];
const west = [40.651, 70.379];

near(distance(origin, north), 111.195, 0.01);
near(distance(origin, origin), 0);
assert.throws(() => distance([NaN, 70], origin), RangeError);
assert.deepEqual(buildManeuvers([origin, north]).map(s => s.kind), ['straight', 'arrive']);
assert.deepEqual(buildManeuvers([origin, north, east]).map(s => s.kind), ['straight', 'right', 'arrive']);
assert.deepEqual(buildManeuvers([origin, north, west]).map(s => s.kind), ['straight', 'left', 'arrive']);
assert.deepEqual(buildManeuvers([origin, north, origin]).map(s => s.kind), ['straight', 'uturn', 'arrive']);

const path = [origin, north, east];
const halfway = projectOnRoute([40.6505, 70.38], path);
near(halfway.progressMeters, distance(origin, north) / 2, 0.05);
near(halfway.remainingMeters + halfway.progressMeters, halfway.totalMeters, 0.0001);
near(halfway.offRouteMeters, 0, 0.0001);
assert.equal(halfway.segmentIndex, 0);
const offRoute = projectOnRoute([40.6505, 70.3798], path);
near(offRoute.offRouteMeters, 16.87, 0.2);
near(offRoute.progressMeters, halfway.progressMeters, 0.02);
const snapshot = navigationSnapshot([40.6505, 70.38], path);
assert.equal(snapshot.instruction, 'Поверните направо');
near(snapshot.metersToManeuver, distance(origin, north) / 2, 0.05);
assert.equal(snapshot.arrived, false);
assert.equal(navigationSnapshot(east, path).arrived, true);
assert.equal(navigationSnapshot([40.652, 70.381], path).arrived, false);
assert.equal(navigationSnapshot(origin, []).arrived, false);
assert.equal(projectOnRoute(origin, []).valid, false);
assert.equal(projectOnRoute(origin, [[NaN, 70]]).valid, false);
assert.equal(projectOnRoute([Infinity, 70], path).valid, false);
assert.equal(projectOnRoute(origin, [origin]).valid, true);
assert.equal(navigationSnapshot(origin, [origin]).arrived, true);
assert.equal(navigationSnapshot(north, [origin]).arrived, false);

// A GPS fix on the earlier of two close parallel stretches must not mean arrival.
const parallel = [origin, north, [40.651, 70.38015], [40.65, 70.38015]];
assert.equal(navigationSnapshot(origin, parallel, undefined, 0).arrived, false);
// At the exact closure of a loop the prior progress disambiguates start/end.
const loop = [origin, north, east, [40.65, 70.381], origin];
assert.equal(projectOnRoute(origin, loop, 0).segmentIndex, 0);
assert.equal(navigationSnapshot(origin, loop, undefined, 0).arrived, false);
assert.equal(navigationSnapshot(origin, loop, undefined, 350).arrived, true);

// Duplicate vertices and small alternating jitter do not produce false turns.
assert.equal(buildManeuvers([origin, origin, north, north, east]).filter(s => s.kind === 'right').length, 1);
const jitter = Array.from({ length: 31 }, (_, i) => [40.65 + i * 0.000025, 70.38 + (i % 2) * 0.000005]);
assert.deepEqual(buildManeuvers(jitter).map(s => s.kind), ['straight', 'arrive']);

console.log('Navigation checks passed: metric projection, turns, GPS progress, arrival, crossings, invalid coordinates.');
