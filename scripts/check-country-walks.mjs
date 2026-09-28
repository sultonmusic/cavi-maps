/* OpenStreetMap walkways: every file reads back into strips or closed outlines inside Tajikistan
 * with a known paving and a sensible width, filed by the tiles they reach, and the Dushanbe
 * flagpole park has its paved paths.
 *
 *   node scripts/check-country-walks.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root = new URL('../public/atlas-walks/', import.meta.url);
const meta = JSON.parse(readFileSync(new URL('index.json', root), 'utf8'));
assert.deepEqual([meta.tier, meta.licence], [10, 'ODbL']);

let strips = 0, outlines = 0, pavedInPark = 0, crossingLines = 0, crossingPoints = 0;
const n = 1024, column = lon => Math.floor((lon + 180) / 360 * n), row = lat => Math.floor((1 - Math.asinh(Math.tan(lat * Math.PI / 180)) / Math.PI) / 2 * n);
for (const name of meta.groups) {
  const [tx, ty] = name.split('-').map(Number);
  for (const [shape, surface, width, ...steps] of JSON.parse(readFileSync(new URL(`${name}.json`, root), 'utf8')).walks) {
    assert.ok([0, 1, 2, 3, 4].includes(shape), 'a strip, an outline, a crossing line, a track or a crossing point');
    assert.ok([0, 1, 2].includes(surface), 'plain, tiles or asphalt');
    if (shape === 4) {
      assert.deepEqual([surface, width, steps.length], [0, 0, 2], 'a crossing point is one point');
      const [lon, lat] = [steps[0] / 1e6, steps[1] / 1e6];
      assert.deepEqual([column(lon), row(lat)], [tx, ty], `crossing point filed in ${name}`);
      crossingPoints++;
      continue;
    }
    assert.ok(steps.length >= 4 && steps.length % 2 === 0, 'at least two points');
    if (shape === 2) crossingLines++;
    const points = [];
    let x = 0, y = 0;
    for (let i = 0; i < steps.length; i += 2) { x += steps[i]; y += steps[i + 1]; points.push([x / 1e6, y / 1e6]); }
    for (const [lon, lat] of points) assert.ok(lon > 66 && lon < 76.5 && lat > 35.5 && lat < 42, 'in or near Tajikistan');
    if (shape === 1) {
      outlines++;
      assert.equal(width, 0);
      assert.ok(points.length >= 4 && points[0][0] === points.at(-1)[0] && points[0][1] === points.at(-1)[1], 'an outline is closed');
    } else {
      strips++;
      assert.ok(width >= 5 && width <= 300, `strip width ${width} dm`);
    }
    const lons = points.map(p => p[0]), lats = points.map(p => p[1]);
    assert.ok(tx >= column(Math.min(...lons)) && tx <= column(Math.max(...lons)) && ty >= row(Math.max(...lats)) && ty <= row(Math.min(...lats)), `filed in ${name}`);
    if (surface === 1 && Math.abs(points[0][0] - 68.7801) < 0.004 && Math.abs(points[0][1] - 38.579) < 0.004) pavedInPark++;
  }
}
assert.ok(strips > 20000 && outlines > 0, 'walkways across the country');
assert.ok(pavedInPark > 50, 'paved paths in the Dushanbe flagpole park');
assert.ok(crossingPoints > 300 && crossingLines > 100, 'crossings to paint as zebras');
console.log(`PASS: ${strips + outlines + crossingPoints} walkway records in ${meta.groups.length} files (${strips} strips of which ${crossingLines} crossings, ${outlines} outlines, ${crossingPoints} crossing points), paving and widths in range, filed by tile; ${pavedInPark} paved paths in the flagpole park.`);
