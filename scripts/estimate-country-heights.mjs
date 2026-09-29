/* Estimated wall heights and facade styles for the country's houses.
 *
 * Almost every footprint outside Shaydon comes without a height (Microsoft states none, and only
 * about 1.6 % of OpenStreetMap buildings do), so they would all stand 4 m tall and a Soviet
 * microdistrict would read as a field of sheds. This script rewrites the house files from AHB1
 * to AHB2 in place, one file at a time, and guesses a height only where none is stated, from the
 * footprint's tightest rectangle (long side L, short side W, how much of it the footprint fills f,
 * area A, all in metres):
 *
 *   A < 400 m²                                    no height (the map's 4 m), style 'house'
 *   9.5 ≤ W ≤ 15.5, L ≥ 36, f ≥ 0.85              16 m, 'block': a five-storey panel slab
 *   A ≥ 2500 m²                                   8 m, 'hall': a market, a factory, a gym
 *   anything else                                 7 m, 'block': two floors
 *
 * Every guessed height is flagged in the file (bit 3 of the house's flags), so the map never
 * presents it as a surveyed fact. Stated heights are kept and only get a style. Running the
 * script again gives the same files; after scripts/build-country-houses.py it must run again.
 *
 *   node scripts/estimate-country-heights.mjs [folder]      (default public/atlas-houses)
 */
import { readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ESTIMATED, HOUSE_STYLES, HOUSE_UNIT, MAGIC_AHB1, MAGIC_AHB2 } from '../lib/country-houses.mjs';
import { rectangleAround } from '../lib/mesh-kit.mjs';

const GROUP_UNITS = 65536;
/** MapLibre's Earth, so a metre here is a metre on the map. */
const CIRCUMFERENCE = 2 * Math.PI * 6371008.8;
const STYLE = Object.fromEntries(HOUSE_STYLES.map((style, bit) => [style ?? 'unknown', bit]));

/** Metres per world unit along the middle of file row `gy`. */
export function metresPerUnit(gy) {
  const y = (gy + 0.5) * GROUP_UNITS / HOUSE_UNIT;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * y)));
  return CIRCUMFERENCE * Math.cos(lat) / HOUSE_UNIT;
}

/** The style of a house whose height is stated: towers, halls, cottages and ordinary blocks. */
export function statedStyle(height, area) {
  const storeys = height < 2.5 ? 0 : Math.max(1, Math.floor((height - 1) / 3));
  if (storeys >= 10 || height >= 31) return 'office';
  if (area >= 2500 && storeys <= 3) return 'hall';
  if (storeys <= 2 && area < 220) return 'house';
  return 'block';
}

/** A footprint (corners in metres, any winding) and its stated height (0 for none) to the height
    to store, its style, and whether that height is a guess. */
export function estimateHouse(points, stated) {
  let twice = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) twice += points[j][0] * points[i][1] - points[i][0] * points[j][1];
  const area = Math.abs(twice / 2);
  if (stated > 0) return { height: stated, style: statedStyle(stated, area), estimated: false };
  if (area < 400) return { height: 0, style: 'house', estimated: false };
  const box = rectangleAround(points);
  if (box) {
    const long = box.half[0] * 2, short = box.half[1] * 2;
    if (short >= 9.5 && short <= 15.5 && long >= 36 && box.fill >= 0.85) return { height: 16, style: 'block', estimated: true };
  }
  if (area >= 2500) return { height: 8, style: 'hall', estimated: true };
  return { height: 7, style: 'block', estimated: true };
}

/** One file, AHB1 or AHB2, rewritten as AHB2. Heights that an earlier run estimated are guessed
    again, so the rules can change and the script still gives the same result on its own output. */
export function convertFile(bytes, gy) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = view.byteLength >= 8 ? view.getUint32(0, true) : 0;
  if (magic !== MAGIC_AHB1 && magic !== MAGIC_AHB2) throw new Error('not a house file');
  const head = magic === MAGIC_AHB2 ? 11 : 10, count = view.getUint32(4, true), metres = metresPerUnit(gy);
  const out = new Uint8Array(view.byteLength + (head === 10 ? count : 0)), write = new DataView(out.buffer);
  write.setUint32(0, MAGIC_AHB2, true); write.setUint32(4, count, true);
  const counts = { houses: count, estimated: 0, stated: 0, styles: { house: 0, block: 0, office: 0, hall: 0, shop: 0 } };
  let at = 8, to = 8;
  for (let i = 0; i < count; i++) {
    const n = view.getUint8(at), end = at + head + (n - 1) * 4;
    if (n < 3 || end > view.byteLength) throw new Error('damaged house file');
    const flags = head === 11 ? view.getUint8(at + 2) : 0;
    const stated = flags & ESTIMATED ? 0 : view.getUint8(at + 1);
    let x = view.getInt32(at + head - 8, true), y = view.getInt32(at + head - 4, true);
    const points = [[x * metres, -y * metres]];
    for (let k = at + head; k < end; k += 4) {
      x += view.getInt16(k, true); y += view.getInt16(k + 2, true);
      points.push([x * metres, -y * metres]);
    }
    const guess = estimateHouse(points, stated);
    if (guess.estimated) counts.estimated++;
    if (stated) counts.stated++;
    counts.styles[guess.style]++;
    write.setUint8(to, n);
    write.setUint8(to + 1, guess.height);
    write.setUint8(to + 2, STYLE[guess.style] | (guess.estimated ? ESTIMATED : 0));
    out.set(bytes.subarray(at + head - 8, end), to + 3);
    at = end;
    to += 11 + (n - 1) * 4;
  }
  if (at !== view.byteLength || to !== out.length) throw new Error('damaged house file');
  return { bytes: out, counts };
}

/** Every file listed in `folder`/index.json, one at a time, then the index itself. */
export function estimateFolder(folder, log = console.log) {
  const meta = JSON.parse(readFileSync(join(folder, 'index.json'), 'utf8'));
  const total = { houses: 0, estimated: 0, stated: 0, styles: { house: 0, block: 0, office: 0, hall: 0, shop: 0 } };
  const started = Date.now();
  meta.groups.forEach((name, i) => {
    const file = join(folder, `${name}.bin`), gy = Number(name.split('-')[1]);
    const { bytes, counts } = convertFile(readFileSync(file), gy);
    writeFileSync(file + '.tmp', bytes);
    renameSync(file + '.tmp', file);
    total.houses += counts.houses; total.estimated += counts.estimated; total.stated += counts.stated;
    for (const style in counts.styles) total.styles[style] += counts.styles[style];
    if ((i + 1) % 200 === 0) log(`  ${i + 1}/${meta.groups.length} files`);
  });
  meta.format = 'AHB2';
  meta.counts = { ...meta.counts, estimated: total.estimated, styles: total.styles };
  meta.estimates = 'scripts/estimate-country-heights.mjs: 16 m panel slabs, 8 m halls, 7 m other blocks over 400 m²; flagged per house';
  writeFileSync(join(folder, 'index.json'), JSON.stringify(meta));
  log(`${meta.groups.length} files, ${total.houses} houses: ${total.estimated} heights estimated, ${total.stated} stated kept; styles ${JSON.stringify(total.styles)} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  return total;
}

// Run as a script (not imported by a check): Windows paths may differ in case or come through a link.
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const real = path => { try { return realpathSync(path); } catch { return path; } };
if (process.argv[1] && same(real(resolve(process.argv[1])), real(fileURLToPath(import.meta.url)))) {
  const folder = resolve(process.argv[2] ?? fileURLToPath(new URL('../public/atlas-houses/', import.meta.url)));
  estimateFolder(folder);
}
