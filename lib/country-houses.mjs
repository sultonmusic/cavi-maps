// Houses across Tajikistan: the binary files scripts/build-country-houses.py writes, cut into
// vector-tile outlines. Shared by the map and the verification script.
//
//   file    'AHB1' or 'AHB2', uint32 house count, then the houses
//   house   uint8 corners n, uint8 wall height in metres (0 when no source states one),
//           AHB2 only: uint8 flags (bits 0-2 facade style, bit 3 height estimated),
//           int32 x, int32 y of the first corner from the file's north-west corner,
//           then n - 1 int16 steps to the next corners
//   units   2^28 across the world in Web Mercator, about 11.5 cm in Tajikistan
//
// build-country-houses.py writes AHB1; scripts/estimate-country-heights.mjs turns the files into
// AHB2, adding a facade style to every house and a flagged estimate where no height is stated.
export const HOUSE_UNIT = 2 ** 28;
/** Each file holds 2 × 2 tiles of zoom 13, named by column and row: `/atlas-houses/<x>-<y>.bin`. */
export const HOUSE_TIER = 13;
export const HOUSE_GROUP = 2;
const GROUP_UNITS = HOUSE_UNIT / 2 ** HOUSE_TIER * HOUSE_GROUP;
export const MAGIC_AHB1 = 0x31424841;
export const MAGIC_AHB2 = 0x32424841;
/** Facade styles by their number in the flags; 0 is a house nobody has classified. */
export const HOUSE_STYLES = [null, 'house', 'block', 'office', 'hall', 'shop'];
export const ESTIMATED = 8;
const EXTENT = 4096;

/** The file holding tile z/x/y's houses as [column, row], or null above zoom 13 where a tile spans several. */
export function houseGroupOf(z, x, y) {
  if (z < HOUSE_TIER) return null;
  const factor = 2 ** (z - HOUSE_TIER) * HOUSE_GROUP;
  return [Math.floor(x / factor), Math.floor(y / factor)];
}

/** Reads a file once: where each house starts and where its middle is. */
export function indexHouses(bytes) {
  const view = new DataView(bytes);
  const magic = view.byteLength >= 8 ? view.getUint32(0, true) : 0;
  if (magic !== MAGIC_AHB1 && magic !== MAGIC_AHB2) throw new Error('Некорректный файл домов');
  const head = magic === MAGIC_AHB2 ? 11 : 10, flagged = head === 11;
  const count = view.getUint32(4, true);
  const starts = new Uint32Array(count), cx = new Float64Array(count), cy = new Float64Array(count);
  let at = 8;
  for (let i = 0; i < count; i++) {
    const n = at + head <= view.byteLength ? view.getUint8(at) : 0, end = at + head + (n - 1) * 4;
    if (n < 3 || end > view.byteLength) throw new Error('Файл домов повреждён');
    const first = flagged ? at + 3 : at + 2;
    let x = view.getInt32(first, true), y = view.getInt32(first + 4, true), sumX = x, sumY = y;
    for (let k = at + head; k < end; k += 4) {
      x += view.getInt16(k, true); y += view.getInt16(k + 2, true);
      sumX += x; sumY += y;
    }
    starts[i] = at; cx[i] = sumX / n; cy[i] = sumY / n;
    at = end;
  }
  if (at !== view.byteLength) throw new Error('Файл домов повреждён');
  return { view, count, starts, cx, cy, head };
}

/** A house's facade style and whether its height is an estimate (always unknown and false in AHB1). */
export function houseFlags(index, i) {
  if (index.head !== 11) return { style: null, estimated: false };
  const flags = index.view.getUint8(index.starts[i] + 2);
  return { style: HOUSE_STYLES[flags & 7] ?? null, estimated: (flags & ESTIMATED) !== 0 };
}

/** A number from a house's bounding box in world units, the same for every copy of one outline
    (the files hold some outlines twice, from two sources or starting at another corner), so
    copies get one wall tone and never flicker against each other in two colours. */
function outlineHash(minX, minY, maxX, maxY) {
  let h = 0x9e3779b9;
  for (const v of [minX, minY, maxX, maxY]) { h = Math.imul(h ^ v, 0x85ebca6b); h ^= h >>> 13; }
  h = Math.imul(h, 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The houses of file gx/gy whose middle lies in tile z/x/y, so each is cut into exactly one tile
    per zoom: closed outlines on the tile's 0..4096 grid, with a wall height in metres or 0, the
    house's position in its file (`index`, stable for a given build), its facade style or null,
    whether the height is an estimate rather than stated by a source, and `outline`, a hash of its
    bounding box that is equal for duplicate outlines. */
export function housesInTile(index, gx, gy, z, x, y) {
  const size = HOUSE_UNIT / 2 ** z, scale = EXTENT / size;
  const left = x * size - gx * GROUP_UNITS, top = y * size - gy * GROUP_UNITS;
  const { view, count, starts, cx, cy } = index, head = index.head ?? 10, houses = [];
  for (let i = 0; i < count; i++) {
    if (cx[i] < left || cx[i] >= left + size || cy[i] < top || cy[i] >= top + size) continue;
    const at = starts[i], end = at + head + (view.getUint8(at) - 1) * 4, first = at + head - 8;
    let px = view.getInt32(first, true), py = view.getInt32(first + 4, true);
    let minX = px, minY = py, maxX = px, maxY = py;
    const ring = [[Math.round((px - left) * scale), Math.round((py - top) * scale)]];
    for (let k = at + head; k < end; k += 4) {
      px += view.getInt16(k, true); py += view.getInt16(k + 2, true);
      if (px < minX) minX = px; else if (px > maxX) maxX = px;
      if (py < minY) minY = py; else if (py > maxY) maxY = py;
      const tx = Math.round((px - left) * scale), ty = Math.round((py - top) * scale), last = ring[ring.length - 1];
      // Far out, neighbouring corners land on one grid point.
      if (tx !== last[0] || ty !== last[1]) ring.push([tx, ty]);
    }
    const last = ring[ring.length - 1];
    if (ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1]) ring.pop();
    if (ring.length < 3) continue;
    ring.push(ring[0]);
    const { style, estimated } = houseFlags(index, i);
    const ox = gx * GROUP_UNITS, oy = gy * GROUP_UNITS;
    houses.push({ ring, height: view.getUint8(at + 1), index: i, style, estimated, outline: outlineHash(minX + ox, minY + oy, maxX + ox, maxY + oy) });
  }
  return houses;
}

/** The houses of file gx/gy whose middle lies within `radius` of world point x, y (all in world
    units, 2^28 across the world), nearest first: corners as a flat list of world units without
    the closing corner, `gap`, the distance from x, y to the house's middle, and `outline` as in
    housesInTile. */
export function housesNear(index, gx, gy, x, y, radius) {
  const { view, count, starts, cx, cy } = index, head = index.head ?? 10, houses = [];
  const ox = gx * GROUP_UNITS, oy = gy * GROUP_UNITS, reach = radius * radius;
  for (let i = 0; i < count; i++) {
    const dx = cx[i] + ox - x, dy = cy[i] + oy - y, gap = dx * dx + dy * dy;
    if (gap > reach) continue;
    const at = starts[i], n = view.getUint8(at), end = at + head + (n - 1) * 4, first = at + head - 8;
    let px = view.getInt32(first, true) + ox, py = view.getInt32(first + 4, true) + oy;
    const points = [px, py];
    let minX = px, minY = py, maxX = px, maxY = py;
    for (let k = at + head; k < end; k += 4) {
      px += view.getInt16(k, true); py += view.getInt16(k + 2, true);
      points.push(px, py);
      if (px < minX) minX = px; else if (px > maxX) maxX = px;
      if (py < minY) minY = py; else if (py > maxY) maxY = py;
    }
    const { style, estimated } = houseFlags(index, i);
    houses.push({ index: i, points, height: view.getUint8(at + 1), gap: Math.sqrt(gap), style, estimated, outline: outlineHash(minX, minY, maxX, maxY) });
  }
  return houses.sort((a, b) => a.gap - b.gap);
}
