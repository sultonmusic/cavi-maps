import assert from 'node:assert/strict';
import { validateCityObject, encodeCloudCityObject, decodeCloudCityObject, isNarrowOutline } from '../lib/city-objects.mjs';
import { validateCityObject as serverValidateCityObject } from '../server/model.mjs';

assert.equal(validateCityObject, serverValidateCityObject, 'Local API and browser use the same validator');
const at = [70.357, 40.6655];
const flag = validateCityObject({ id: 'flag-1', kind: 'flag', geometry: { type: 'Point', coordinates: at }, height: 18 });
assert.deepEqual([flag.geometry.coordinates, flag.height], [at, 18]);
assert.equal(validateCityObject({ id: 'flag-2', kind: 'flag', geometry: { type: 'Point', coordinates: at } }).height, 12);
const path = { id: 'path-1', kind: 'path', width: 4, geometry: { type: 'LineString', coordinates: [[70.3569, 40.665], [70.3572, 40.6653], [70.3575, 40.6653]] } };
const lawn = { id: 'lawn-1', kind: 'lawn', geometry: { type: 'Polygon', coordinates: [[[70.3569, 40.665], [70.357, 40.665], [70.357, 40.6651], [70.3569, 40.665]]] } };
const octagon = Array.from({ length: 8 }, (_, i) => [70.357 + Math.cos(i / 4 * Math.PI) * 0.00005, 40.6655 + Math.sin(i / 4 * Math.PI) * 0.00004]);
const fountain = { id: 'fountain-1', kind: 'fountain', geometry: { type: 'Polygon', coordinates: [[...octagon, octagon[0]]] } };
const lamp = validateCityObject({ id: 'lamp-1', kind: 'lamp', geometry: { type: 'Point', coordinates: at }, rotation: 90 });
for (const object of [flag, path, lawn, fountain, lamp]) {
  const encoded = encodeCloudCityObject(object);
  assert.deepEqual(Object.keys(encoded.geometry).sort(), ['coordinatesJson', 'type']);
  assert.deepEqual(decodeCloudCityObject(encoded).geometry, validateCityObject(object).geometry);
}

// Walkways, surfaces and outlines.
assert.equal(validateCityObject(path).width, 4);
assert.equal(validateCityObject(path).surface, 'tiles');
assert.equal(validateCityObject({ ...path, surface: 'plain' }).surface, 'plain');
assert.equal(validateCityObject({ ...path, surface: 'asphalt' }).surface, 'asphalt');
assert.throws(() => validateCityObject({ ...path, surface: 'lava' }), /покрытие/);
assert.equal('surface' in validateCityObject(lawn), false);
assert.equal('width' in validateCityObject({ ...lawn, width: 5 }), false);
assert.equal(validateCityObject(fountain).geometry.coordinates[0].length, 9);
assert.throws(() => validateCityObject({ ...path, geometry: { type: 'LineString', coordinates: [[70.3569, 40.665]] } }), /2 до 500/);
assert.throws(() => validateCityObject({ ...path, width: 90 }), /Ширина/);
assert.throws(() => validateCityObject({ ...lawn, geometry: { type: 'Polygon', coordinates: [[[70.3569, 40.665], [70.357, 40.665], [70.357, 40.6651], [70.3568, 40.6651]]] } }), /замкнут/);
assert.throws(() => validateCityObject({ ...lawn, kind: 'fountain', geometry: path.geometry }), /Нарисуйте/);
// A lawn or a square may also be a strip along a line, with a width.
const strip = validateCityObject({ id: 'strip-1', kind: 'lawn', geometry: path.geometry });
assert.deepEqual([strip.geometry.type, strip.width, 'surface' in strip], ['LineString', 3, false]);
assert.equal(validateCityObject({ ...strip, width: 12 }).width, 12);
assert.equal(validateCityObject({ id: 'strip-2', kind: 'square', width: 8, geometry: path.geometry }).surface, 'tiles');
assert.throws(() => validateCityObject({ ...strip, width: 500 }), /Ширина/);
// Corners tapped along one line make a hairline, not a lawn; the admin refuses to save one.
const thread = [[70.356976, 40.664617], [70.35796727567961, 40.6652658465473], [70.35789478511128, 40.665216700803256], [70.356976, 40.664617]];
assert.equal(isNarrowOutline(thread), true);
assert.equal(isNarrowOutline([[70.357, 40.665], [70.357, 40.665]]), true);
for (const ring of [lawn.geometry.coordinates[0], fountain.geometry.coordinates[0]]) assert.equal(isNarrowOutline(ring), false);
const strip1m = [[70.357, 40.665], [70.357 + 10 / 84440, 40.665], [70.357 + 10 / 84440, 40.665 + 1 / 110540], [70.357, 40.665 + 1 / 110540], [70.357, 40.665]];
assert.equal(isNarrowOutline(strip1m), false, 'A 10 × 1 m bed is still an area');

// Details and their sizes.
assert.deepEqual([lamp.height, lamp.rotation], [5, 90]);
assert.equal(validateCityObject({ id: 'bench-1', kind: 'bench', geometry: { type: 'Point', coordinates: at } }).length, 1.8);
const tree = validateCityObject({ id: 'tree-1', kind: 'tree', width: 4, geometry: { type: 'Point', coordinates: at } });
assert.deepEqual([tree.height, tree.width, 'rotation' in tree], [6, 4, false]);
assert.equal('thickness' in validateCityObject({ ...flag, thickness: '' }), false);
assert.deepEqual((({ thickness, length }) => [thickness, length])(validateCityObject({ ...flag, thickness: 0.4, length: 6 })), [0.4, 6]);
assert.throws(() => validateCityObject({ ...flag, thickness: 5 }), /Толщина/);
assert.throws(() => validateCityObject({ ...lamp, rotation: 400 }), /Направление/);
assert.throws(() => validateCityObject({ ...flag, height: 1 }), /Высота/);
assert.throws(() => validateCityObject({ ...flag, kind: 'fountainhead' }), /тип/);
assert.throws(() => validateCityObject({ ...flag, kind: 'constructor' }), /тип/);
assert.throws(() => validateCityObject({ ...flag, geometry: { type: 'Point', coordinates: [0, 0] } }), /Долгота/);
assert.throws(() => validateCityObject({ ...flag, name: '<b>' }), /название/);
assert.throws(() => validateCityObject({ ...flag, name: 'line\nbreak' }), /название/);
assert.equal(validateCityObject({ ...flag, name: 'Флаг у Фарханга, 2026' }).name, 'Флаг у Фарханга, 2026');
assert.throws(() => decodeCloudCityObject({ ...encodeCloudCityObject(flag), geometry: { type: 'Point', coordinatesJson: '[broken' } }));
console.log('PASS: landscaping and park details share one validator, round-trip through Firestore-safe geometry, keep per-kind sizes and surfaces, and reject short walkways, open outlines, wrong geometry, unknown kinds and out-of-range sizes.');
