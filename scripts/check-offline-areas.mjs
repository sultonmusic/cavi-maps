// Checks lib/offline-areas.mjs on the real map files in public/: the files saved for a town exist,
// are all deletable map pieces, and cover every kind of map data.
//   node scripts/check-offline-areas.mjs
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { areaFiles, isSavedMapPath, sumBytes, formatBytes, cityArea, viewArea, TILE_TIERS, VIEW_RADIUS } from '../lib/offline-areas.mjs';
import { CITIES, cityByName } from '../lib/cities.mjs';

const pub = file => fileURLToPath(new URL(`../public/${file.replace(/^\//, '')}`, import.meta.url));
const json = file => JSON.parse(readFileSync(pub(file), 'utf8'));
let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++ };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ };

const meta = json('atlas-data/index.json');
eq([...meta.tiers], TILE_TIERS, 'the bundle tiers match atlas-data/index.json');
eq(meta.bundleSize ?? 4, 4, '4 × 4 tiles per bundle');
const groups = folder => existsSync(pub(`${folder}/index.json`)) ? new Set(json(`${folder}/index.json`).groups) : new Set();
const lists = { tiles: new Set(meta.tiles), houses: groups('atlas-houses'), roads: groups('atlas-roads'), things: groups('atlas-things'), walks: groups('atlas-walks') };
const sizeOf = url => statSync(pub(url)).size;

const dushanbe = areaFiles({ id: 'test', name: 'Душанбе', lat: 38.575, lon: 68.79, r: 0.12 }, lists);
ok(dushanbe.length >= 30 && dushanbe.length <= 200, `Dushanbe: ${dushanbe.length} files`);
ok(dushanbe.every(isSavedMapPath), 'every file is a savable map piece');
ok(dushanbe.every(url => existsSync(pub(url))), 'every file exists in public/');
eq(dushanbe, [...new Set(dushanbe)].sort(), 'sorted and unique');
for (const [kind, test] of [['houses', /^\/atlas-houses\/\d+-\d+\.bin$/], ['bundle 13', /^\/atlas-data\/bundle-13-/], ['bundle 10', /^\/atlas-data\/bundle-10-/], ['bundle 7', /^\/atlas-data\/bundle-7-/], ['roads', /^\/atlas-roads\//], ['walks', /^\/atlas-walks\//]]) {
  ok(dushanbe.some(url => test.test(url)), `Dushanbe has ${kind}`);
}
const dushanbeBytes = dushanbe.reduce((sum, url) => sum + sizeOf(url), 0);
const sizes = Object.fromEntries(dushanbe.map(url => [url, sizeOf(url)]));
eq(sumBytes(dushanbe, sizes), dushanbeBytes, 'sumBytes adds the sizes');
eq(sumBytes(dushanbe, null), null, 'sumBytes without sizes is unknown');
eq(sumBytes(['/atlas-data/bundle-1-2-3.json'], {}), 0, 'a file missing from the sizes counts as 0');

// Every town can be saved, and a town's files lie inside the area around it.
const perTown = CITIES.slice(1).map(city => {
  const files = areaFiles(cityArea(city), lists);
  ok(files.length > 0 && files.every(url => existsSync(pub(url))), `${city.name}: ${files.length} files, all present`);
  return [city.name, files.length, files.reduce((sum, url) => sum + sizeOf(url), 0)];
});
const shaydon = cityArea(cityByName('Шайдон'));
eq(shaydon, { id: 'city:Шайдон', name: 'Шайдон', lat: 40.6601966, lon: 70.3597068, r: 0.06 }, 'cityArea');
eq(cityArea(cityByName('Бустон')).r, 0.04, 'small towns get at least 0.04°');
eq(viewArea(69.6, 40.3), { id: 'view', name: 'Видимая часть карты', lat: 40.3, lon: 69.6, r: VIEW_RADIUS }, 'viewArea');
const inView = areaFiles(viewArea(68.79, 38.575), lists);
ok(inView.length > 0 && inView.length < dushanbe.length, `the visible map is smaller than the town: ${inView.length}`);
ok(inView.every(url => dushanbe.includes(url)), 'and lies inside it');
eq(areaFiles({ id: 'x', name: 'x', lat: 10, lon: 10, r: 0.05 }, lists), [], 'nothing outside the map');

eq(isSavedMapPath('/places.json'), false, 'places.json is part of the app');
eq(isSavedMapPath('/atlas-roads/index.json'), false, 'index.json lists are part of the app');
eq(isSavedMapPath('/atlas-data/index.json'), false, 'atlas-data/index.json too');
eq(isSavedMapPath('/road-graph.json'), false, 'the graph list too');
eq(isSavedMapPath('/graph-nodes-3.json'), true, 'graph pieces can be deleted');
eq(isSavedMapPath('/atlas-houses/2814-1557.bin'), true, 'house files');
eq(isSavedMapPath('/atlas-data/bundle-13-1420-773.json'), true, 'bundles');
eq(isSavedMapPath('/atlas-data/bundle-13-1420-773.json?x=1'), false, 'no query strings');

eq(formatBytes(23.6 * 1024 * 1024), '23,6 МБ', 'formatBytes 23.6 MiB');
eq(formatBytes(512 * 1024), '512 КБ', 'formatBytes 512 KiB');
eq(formatBytes(74.2 * 1024 * 1024), '74,2 МБ', 'formatBytes 74.2 MiB');
eq(formatBytes(140.4 * 1024 * 1024), '140 МБ', 'formatBytes 140.4 MiB');
eq(formatBytes(1.25 * 1024 ** 3), '1,3 ГБ', 'formatBytes 1.25 GiB');
eq(formatBytes(0), '0 КБ', 'formatBytes 0');
eq(formatBytes(1023.8 * 1024), '1,0 МБ', 'formatBytes never reads 1024 КБ');
eq(formatBytes(99.97 * 1024 * 1024), '100 МБ', 'formatBytes never reads 100,0 МБ');
eq(formatBytes(1023.7 * 1024 * 1024), '1,0 ГБ', 'formatBytes never reads 1024 МБ');

// The routing graph as the Profile saves it.
const graph = json('road-graph.json');
const graphFiles = ['/road-graph.json', ...graph.nodes_files, ...graph.edges_files];
ok(graphFiles.slice(1).every(url => isSavedMapPath(url) && existsSync(pub(url))), `graph: ${graphFiles.length} files, all present`);
const graphBytes = graphFiles.reduce((sum, url) => sum + sizeOf(url), 0);

const mb = n => (n / 1024 / 1024).toFixed(1);
console.log(`check-offline-areas: ${checks} checks passed. Dushanbe ${dushanbe.length} files ${mb(dushanbeBytes)} MB; routing graph ${graphFiles.length} files ${mb(graphBytes)} MB.`);
console.log(perTown.map(([name, n, bytes]) => `${name} ${n}/${mb(bytes)}`).join(', '));
