/* A minimal Mapbox Vector Tile writer.
 *
 * Atlas already stores its geometry as integers on a 0..4096 grid per tile,
 * which is exactly the MVT coordinate space, so tiles are re-encoded on the fly
 * instead of being converted and shipped a second time. */

export type MvtGeometryType = 1 | 2 | 3 // point, line, polygon
export type MvtFeature = { type: MvtGeometryType; rings: number[][][]; properties?: Record<string, string | number | boolean> }
export type MvtLayer = { name: string; features: MvtFeature[] }

const EXTENT = 4096
const zigzag = (value: number) => (value << 1) ^ (value >> 31)

class Writer {
  private bytes: number[] = []

  varint(value: number) {
    let rest = value
    while (rest > 0x7f) {
      this.bytes.push((rest & 0x7f) | 0x80)
      rest = Math.floor(rest / 128)
    }
    this.bytes.push(rest)
  }

  tag(field: number, wire: number) { this.varint((field << 3) | wire) }
  uint(field: number, value: number) { this.tag(field, 0); this.varint(value) }

  raw(field: number, payload: number[]) {
    this.tag(field, 2)
    this.varint(payload.length)
    for (const byte of payload) this.bytes.push(byte)
  }

  string(field: number, value: string) { this.raw(field, [...new TextEncoder().encode(value)]) }

  double(field: number, value: number) {
    const view = new DataView(new ArrayBuffer(8))
    view.setFloat64(0, value, true)
    this.tag(field, 1)
    for (let i = 0; i < 8; i++) this.bytes.push(view.getUint8(i))
  }

  take() { return this.bytes }
}

/** Command/parameter integers per the MVT geometry encoding. */
function geometry(feature: MvtFeature) {
  const out: number[] = []
  let x = 0, y = 0
  for (const ring of feature.rings) {
    const points = feature.type === 3 && ring.length > 1 &&
      ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
      ? ring.slice(0, -1)
      : ring
    if (!points.length) continue
    out.push((1 & 0x7) | (1 << 3)) // MoveTo, one point
    out.push(zigzag(points[0][0] - x), zigzag(points[0][1] - y))
    x = points[0][0]; y = points[0][1]
    if (points.length > 1) {
      out.push((2 & 0x7) | ((points.length - 1) << 3)) // LineTo
      for (let i = 1; i < points.length; i++) {
        out.push(zigzag(points[i][0] - x), zigzag(points[i][1] - y))
        x = points[i][0]; y = points[i][1]
      }
    }
    if (feature.type === 3) out.push((7 & 0x7) | (1 << 3)) // ClosePath
  }
  return out
}

function packed(values: number[]) {
  const writer = new Writer()
  for (const value of values) writer.varint(value)
  return writer.take()
}

function value(entry: string | number | boolean) {
  const writer = new Writer()
  if (typeof entry === 'string') writer.string(1, entry)
  else if (typeof entry === 'boolean') writer.uint(7, entry ? 1 : 0)
  else if (Number.isInteger(entry) && entry >= 0) writer.uint(5, entry)
  else writer.double(3, entry)
  return writer.take()
}

function encodeLayer(layer: MvtLayer) {
  const writer = new Writer()
  writer.uint(15, 2)
  writer.string(1, layer.name)
  const keys: string[] = [], keyIndex = new Map<string, number>()
  const values: number[][] = [], valueIndex = new Map<string, number>()
  const features: number[][] = []

  for (const feature of layer.features) {
    const shape = geometry(feature)
    if (!shape.length) continue
    const tags: number[] = []
    for (const [key, entry] of Object.entries(feature.properties ?? {})) {
      if (entry === undefined || entry === null) continue
      let k = keyIndex.get(key)
      if (k === undefined) { k = keys.length; keys.push(key); keyIndex.set(key, k) }
      const token = typeof entry + ':' + entry
      let v = valueIndex.get(token)
      if (v === undefined) { v = values.length; values.push(value(entry)); valueIndex.set(token, v) }
      tags.push(k, v)
    }
    const body = new Writer()
    if (tags.length) body.raw(2, packed(tags))
    body.uint(3, feature.type)
    body.raw(4, packed(shape))
    features.push(body.take())
  }

  if (!features.length) return null
  for (const feature of features) writer.raw(2, feature)
  for (const key of keys) writer.string(3, key)
  for (const entry of values) writer.raw(4, entry)
  writer.uint(5, EXTENT)
  return writer.take()
}

export function encodeTile(layers: MvtLayer[]): Uint8Array {
  const writer = new Writer()
  for (const layer of layers) {
    const encoded = encodeLayer(layer)
    if (encoded) writer.raw(3, encoded)
  }
  return Uint8Array.from(writer.take())
}
