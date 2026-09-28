/* The browser re-encodes Atlas tiles as MVT on the fly; this decodes one back
 * and checks it survives the trip.
 *
 *   node --experimental-strip-types scripts/check-mvt.mjs
 */
import assert from 'node:assert/strict';
import { encodeTile } from '../lib/mvt.ts';

/** Just enough protobuf to read a vector tile back. */
function reader(bytes) {
  let at = 0;
  const varint = () => {
    let value = 0, shift = 1;
    for (;;) {
      const byte = bytes[at++];
      value += (byte & 0x7f) * shift;
      if (!(byte & 0x80)) return value;
      shift *= 128;
    }
  };
  return {
    get done() { return at >= bytes.length },
    field() { const key = varint(); return { number: key >> 3, wire: key & 7 } },
    varint,
    bytes() { const length = varint(); const out = bytes.subarray(at, at + length); at += length; return out },
    skip(wire) { if (wire === 0) varint(); else if (wire === 2) this.bytes(); else if (wire === 5) at += 4; else if (wire === 1) at += 8 },
  };
}

function readLayer(bytes) {
  const read = reader(bytes);
  const layer = { name: '', extent: 4096, features: [], keys: [], values: [] };
  while (!read.done) {
    const { number, wire } = read.field();
    if (number === 1) layer.name = new TextDecoder().decode(read.bytes());
    else if (number === 2) layer.features.push(readFeature(read.bytes()));
    else if (number === 3) layer.keys.push(new TextDecoder().decode(read.bytes()));
    else if (number === 4) layer.values.push(readValue(read.bytes()));
    else if (number === 5) layer.extent = read.varint();
    else read.skip(wire);
  }
  return layer;
}

function readFeature(bytes) {
  const read = reader(bytes);
  const feature = { tags: [], type: 0, geometry: [] };
  while (!read.done) {
    const { number, wire } = read.field();
    if (number === 2) { const packed = reader(read.bytes()); while (!packed.done) feature.tags.push(packed.varint()) }
    else if (number === 3) feature.type = read.varint();
    else if (number === 4) { const packed = reader(read.bytes()); while (!packed.done) feature.geometry.push(packed.varint()) }
    else read.skip(wire);
  }
  return feature;
}

function readValue(bytes) {
  const read = reader(bytes);
  const { number, wire } = read.field();
  if (number === 1) return new TextDecoder().decode(read.bytes());
  if (number === 5) return read.varint();
  read.skip(wire);
  return null;
}

function readTile(bytes) {
  const read = reader(bytes);
  const layers = [];
  while (!read.done) {
    const { number, wire } = read.field();
    if (number === 3) layers.push(readLayer(read.bytes()));
    else read.skip(wire);
  }
  return layers;
}

const line = [[10, 20], [30, 40], [30, 90]];
const ring = [[0, 0], [100, 0], [100, 100], [0, 100], [0, 0]];
const encoded = encodeTile([
  { name: 'lines', features: [{ type: 2, rings: [line], properties: { kind: 'road-main', asphalt: 1, way: 391146809 } }] },
  { name: 'areas', features: [{ type: 3, rings: [ring], properties: { kind: 'water' } }] },
  { name: 'empty', features: [] },
]);

const layers = readTile(encoded);
assert.deepEqual(layers.map(layer => layer.name), ['lines', 'areas'], 'an empty layer must be dropped');

const [lines, areas] = layers;
assert.equal(lines.extent, 4096);
assert.equal(lines.features.length, 1);

const road = lines.features[0];
assert.equal(road.type, 2, 'a line keeps geometry type 2');
// MoveTo one point, then LineTo the remaining two.
assert.equal(road.geometry[0], (1 & 7) | (1 << 3));
assert.equal(road.geometry[3], (2 & 7) | (2 << 3));
const unzig = value => (value >> 1) ^ -(value & 1);
assert.deepEqual([unzig(road.geometry[1]), unzig(road.geometry[2])], [10, 20], 'first vertex is absolute');
assert.deepEqual([unzig(road.geometry[4]), unzig(road.geometry[5])], [20, 20], 'later vertices are deltas');

const properties = {};
for (let i = 0; i < road.tags.length; i += 2) properties[lines.keys[road.tags[i]]] = lines.values[road.tags[i + 1]];
assert.deepEqual(properties, { kind: 'road-main', asphalt: 1, way: 391146809 }, 'properties round-trip');

const water = areas.features[0];
assert.equal(water.type, 3, 'a polygon keeps geometry type 3');
assert.equal(water.geometry[water.geometry.length - 1], (7 & 7) | (1 << 3), 'a ring ends with ClosePath');
// The duplicated closing vertex is dropped: MoveTo + 3 LineTo + ClosePath.
assert.equal(water.geometry.length, 1 + 2 + 1 + 6 + 1);

console.log('MVT encoder: 2 layers, geometry, properties and ring closing all check out');
