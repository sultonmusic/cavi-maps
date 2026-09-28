// Houses across Tajikistan: the binary files scripts/build-country-houses.py writes, cut into
// vector-tile outlines. Shared by the map and the verification script.
//
//   file    'AHB1', uint32 house count, then the houses
//   house   uint8 corners n, uint8 wall height in metres (0 when no source states one),
//           int32 x, int32 y of the first corner from the file's north-west corner,
//           then n - 1 int16 steps to the next corners
//   units   2^28 across the world in Web Mercator, about 11.5 cm in Tajikistan
export const HOUSE_UNIT = 2 ** 28;
/** Each file holds 2 × 2 tiles of zoom 13, named by column and row: `/atlas-houses/<x>-<y>.bin`. */
export const HOUSE_TIER = 13;
export const HOUSE_GROUP = 2;
const GROUP_UNITS = HOUSE_UNIT / 2 ** HOUSE_TIER * HOUSE_GROUP;
const MAGIC = 0x31424841;
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
  if (view.byteLength < 8 || view.getUint32(0, true) !== MAGIC) throw new Error('Некорректный файл домов');
  const count = view.getUint32(4, true);
  const starts = new Uint32Array(count), cx = new Float64Array(count), cy = new Float64Array(count);
  let at = 8;
  for (let i = 0; i < count; i++) {
    const n = at + 10 <= view.byteLength ? view.getUint8(at) : 0, end = at + 10 + (n - 1) * 4;
    if (n < 3 || end > view.byteLength) throw new Error('Файл домов повреждён');
    let x = view.getInt32(at + 2, true), y = view.getInt32(at + 6, true), sumX = x, sumY = y;
    for (let k = at + 10; k < end; k += 4) {
      x += view.getInt16(k, true); y += view.getInt16(k + 2, true);
      sumX += x; sumY += y;
    }
    starts[i] = at; cx[i] = sumX / n; cy[i] = sumY / n;
    at = end;
  }
  if (at !== view.byteLength) throw new Error('Файл домов повреждён');
  return { view, count, starts, cx, cy };
}

/** The houses of file gx/gy whose middle lies in tile z/x/y, so each is cut into exactly one tile
    per zoom: closed outlines on the tile's 0..4096 grid, with a wall height in metres or 0. */
export function housesInTile(index, gx, gy, z, x, y) {
  const size = HOUSE_UNIT / 2 ** z, scale = EXTENT / size;
  const left = x * size - gx * GROUP_UNITS, top = y * size - gy * GROUP_UNITS;
  const { view, count, starts, cx, cy } = index, houses = [];
  for (let i = 0; i < count; i++) {
    if (cx[i] < left || cx[i] >= left + size || cy[i] < top || cy[i] >= top + size) continue;
    const at = starts[i], end = at + 10 + (view.getUint8(at) - 1) * 4;
    let px = view.getInt32(at + 2, true), py = view.getInt32(at + 6, true);
    const ring = [[Math.round((px - left) * scale), Math.round((py - top) * scale)]];
    for (let k = at + 10; k < end; k += 4) {
      px += view.getInt16(k, true); py += view.getInt16(k + 2, true);
      const tx = Math.round((px - left) * scale), ty = Math.round((py - top) * scale), last = ring[ring.length - 1];
      // Far out, neighbouring corners land on one grid point.
      if (tx !== last[0] || ty !== last[1]) ring.push([tx, ty]);
    }
    const last = ring[ring.length - 1];
    if (ring.length > 1 && last[0] === ring[0][0] && last[1] === ring[0][1]) ring.pop();
    if (ring.length < 3) continue;
    ring.push(ring[0]);
    houses.push({ ring, height: view.getUint8(at + 1) });
  }
  return houses;
}
