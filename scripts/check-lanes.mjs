/* Lanes: how many a street may have, which lane a car keeps to, how wide the asphalt is drawn,
 * and how a route is cut into pieces that follow each street's lanes.
 *
 *   node scripts/check-lanes.mjs
 */
import assert from 'node:assert/strict';
import { LANE_METRES, carriagewayMetres, isLanes, isOneway, laneAt, laneLines, lanePieces, laneSegments, laneShift, offsetLine, ribbon, streetAt, streetCrossings, totalLanes, trimLine, zebra } from '../lib/lanes.mjs';
import { validateRoad } from '../server/model.mjs';

for (const value of [0, 1, 6]) assert.ok(isLanes(value));
for (const value of [-1, 7, 1.5, '2', null]) assert.ok(!isLanes(value));
assert.equal(validateRoad({ roadId: 'way/1', asphalt: 6 }).asphalt, 6);
assert.throws(() => validateRoad({ roadId: 'way/1', asphalt: 7 }), /полос/);
assert.deepEqual([totalLanes(0, false), totalLanes(1, false), totalLanes(3, false), totalLanes(3, true), totalLanes(6, false)], [0, 2, 6, 3, 12]);
// Keep right: the middle of the rightmost lane, in lane widths from the centre line.
assert.deepEqual([laneShift(0, false), laneShift(1, false), laneShift(2, false), laneShift(1, true), laneShift(2, true), laneShift(3, true)], [0, 0.5, 1.5, 0, 0.5, 1]);
assert.ok(isOneway({ oneway: 'yes' }) && isOneway({ junction: 'roundabout' }) && !isOneway({ oneway: 'no' }) && !isOneway(undefined));

// Asphalt to scale: lanes of 3.4 m, one shared lane of 4.6 m.
assert.deepEqual([carriagewayMetres(0, false), carriagewayMetres(1, false), carriagewayMetres(3, true), carriagewayMetres(6, false)].map(metres => +metres.toFixed(1)), [4.6, 6.8, 10.2, 40.8]);
const apart = (a, b) => Math.hypot((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180) * 111_320, (b[1] - a[1]) * 111_320);
const north = [[69.64, 40.27], [69.64, 40.271]];
const moved = offsetLine(north, 2);
assert.ok(Math.abs(apart(north[0], moved[0]) - 2) < 0.01 && moved[0][0] > north[0][0], 'right of a northbound line is east');
assert.ok(offsetLine(north, -2)[1][0] < north[1][0], 'a negative offset goes left');
const corner = [[69.64, 40.27], [69.64, 40.271], [69.6413, 40.271]];
assert.ok(Math.abs(apart(corner[1], offsetLine(corner, 2)[1]) - 2 * Math.SQRT2) < 0.02, 'a right-angle corner is mitred');
const trimmed = trimLine(north, 4);
assert.ok(Math.abs(apart(trimmed[0], trimmed.at(-1)) - (111.32 - 8)) < 0.05, 'four metres off each end');
assert.equal(trimLine([[69.64, 40.27], [69.64, 40.27005]], 4), null, 'a 5.6 m stretch keeps no lane lines');
// Outlines: one per stretch between sharp bends and a disc at every bend and end, rings closed.
assert.equal(ribbon(north, 6.8).length, 3);
const bent = ribbon(corner, 6.8);
assert.equal(bent.length, 5);
for (const [ring] of bent) assert.deepEqual(ring[0], ring.at(-1));
assert.equal(ribbon(north, 6.8, [0, 0]).length, 1, 'flat ends where streets carry on');
const narrowCap = ribbon(north, 13.6, [3.4, 0])[1][0];
assert.ok(Math.abs(apart(north[0], narrowCap[0]) - 3.4) < 0.01, 'a wide street ends in a disc no wider than the street it meets');
// Lane lines break off before a crossing street's kerb, and before dead ends.
const crossed = [[69.64, 40.27], [69.64, 40.2705], [69.64, 40.271]];
const pieces2 = laneLines({ coordinates: crossed, asphalt: 1, oneway: false }, point => point[1] === 40.2705 ? 3.4 : 0);
assert.equal(pieces2.length, 2, 'a centre line on each side of the crossing');
assert.ok(Math.abs(apart(pieces2[0].coordinates[0], pieces2[0].coordinates.at(-1)) - (55.66 - 4.9 - 4)) < 0.1);
// Lane lines: dashed between lanes, a double line down a two-way street with two lanes or more each way.
assert.deepEqual(laneLines({ coordinates: north, asphalt: 2, oneway: false }).map(line => line.kind), ['dash', 'centre', 'centre', 'dash']);
assert.deepEqual(laneLines({ coordinates: north, asphalt: 1, oneway: false }).map(line => line.kind), ['dash']);
assert.deepEqual(laneLines({ coordinates: north, asphalt: 3, oneway: true }).map(line => line.kind), ['dash', 'dash']);
assert.deepEqual(laneLines({ coordinates: north, asphalt: 0, oneway: false }), []);
const [leftmost, , , rightmost] = laneLines({ coordinates: north, asphalt: 2, oneway: false });
assert.ok(Math.abs(apart(leftmost.coordinates[0], rightmost.coordinates[0]) - 2 * LANE_METRES) < 0.02, 'the outer lane lines are two lanes apart');

// A northbound two-way street with two lanes each way, a one-way carriageway 85 m east, and a shared-lane lane across.
const street = { coordinates: [[69.64, 40.27], [69.64, 40.275]], asphalt: 2, oneway: false };
const carriageway = { coordinates: [[69.641, 40.27], [69.641, 40.275]], asphalt: 2, oneway: true };
const lane = { coordinates: [[69.639, 40.272], [69.642, 40.272]], asphalt: 0, oneway: false };
const index = laneSegments([street, carriageway, lane]);
assert.deepEqual(laneAt(index, 69.64, 40.2725, 0), { shift: 1.5, half: 6.8 }, 'northbound keeps to its right lane');
assert.deepEqual(laneAt(index, 69.64, 40.2725, 180), { shift: 1.5, half: 6.8 }, 'southbound keeps to the right on its own side');
assert.deepEqual(laneAt(index, 69.641, 40.2725, 2), { shift: 0.5, half: 3.4 }, 'the right of two lanes on a one-way carriageway');
assert.equal(laneAt(index, 69.64, 40.2725, 90), null, 'crossing the street is not driving along it');
assert.equal(laneAt(index, 69.6405, 40.2725, 0), null, 'between the carriageways belongs to neither');
assert.deepEqual(laneAt(index, 69.64003, 40.2725, 0, 4), { shift: 1.5, half: 6.8 }, 'a few metres off the centre line still counts');

// A route along the street that turns off onto an unstyled road is cut where the offset changes.
const pieces = lanePieces(index, [[69.64, 40.2701], [69.64, 40.274], [69.64, 40.2749], [69.638, 40.276]]);
assert.deepEqual(pieces.map(piece => [+piece.shift.toFixed(2), piece.coordinates.length]), [[5.1, 3], [0, 2]]);
const onFoot = lanePieces(index, [[69.64, 40.2701], [69.64, 40.274]], spot => spot ? spot.half + 1.5 : 0);
assert.equal(onFoot[0].shift, 8.3, 'a pedestrian keeps beside the kerb');

// Zebras: where a path crosses a street's centre line, or at a crossing point mapped on the street.
const crossings = streetCrossings(index, [[69.6395, 40.2725], [69.6405, 40.2725]]);
assert.equal(crossings.length, 1, 'the path crosses the two-way street once');
assert.ok(Math.abs(crossings[0].point[0] - 69.64) < 1e-9 && Math.abs(crossings[0].point[1] - 40.2725) < 1e-9);
assert.deepEqual([Math.round(crossings[0].bearing), crossings[0].half], [0, 6.8]);
assert.deepEqual(streetCrossings(index, [[69.6395, 40.2725], [69.6398, 40.2725]]), [], 'a path that stops short crosses nothing');
const mapped = streetAt(index, 69.64002, 40.2731);
assert.deepEqual([Math.round(mapped.bearing), mapped.half], [0, 6.8], 'a crossing point beside the centre line finds its street');
assert.equal(streetAt(index, 69.6405, 40.2731), null);
const bars = zebra([69.64, 40.2725], 0, 6.8);
assert.equal(bars.length, 13, 'a bar every metre across 13.6 m of asphalt');
const barLons = bars[0][0].map(p => p[0]), barLats = bars[0][0].map(p => p[1]);
assert.ok(Math.abs((Math.max(...barLats) - Math.min(...barLats)) * 111_320 - 4) < 0.01, 'bars run four metres along a northbound street');
assert.ok(Math.abs((Math.max(...barLons) - Math.min(...barLons)) * 111_320 * Math.cos(40.2725 * Math.PI / 180) - 0.5) < 0.01, 'and are half a metre wide');
assert.deepEqual(lanePieces(index, [[69.64, 40.271]]), []);

console.log('PASS: 0–6 lanes each way, keep-right lane shifts for two-way and one-way streets, asphalt to scale with mitred offsets, round joins and lane lines kept out of junctions, and routes cut into pieces that follow each street\'s lanes.');
