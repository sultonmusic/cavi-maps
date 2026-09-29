// Which files make up a piece of the map, so the Profile can save a town for use without internet.
// Pure: the tile maths is the map's own (lib/atlas-gl.ts bundles and nearbyFiles, lib/country-houses.mjs
// houseGroupOf), and the lists come from the folders' index.json files. lib/offline-maps.ts does the
// fetching and talks to the service worker; scripts/check-offline-areas.mjs checks this on public/.

/** Zoom tiers of the vector bundles in public/atlas-data (index.json "tiers"), 4 × 4 tiles per file. */
export const TILE_TIERS = [7, 10, 13];
const BUNDLE = 4;
/** Houses: 2 × 2 tiles of zoom 13 per file. Roads, street furniture and footpaths: one zoom-10 tile per file. */
const HOUSE_TIER = 13, HOUSE_GROUP = 2, ROAD_TIER = 10;
/** Half the side of the box saved for «Видимая часть карты», in degrees of latitude (about 5 km). */
export const VIEW_RADIUS = 0.045;
/** The smallest box saved for a town, so a village still gets its surroundings. */
export const MIN_CITY_RADIUS = 0.04;

const RAD = Math.PI / 180;
const column = (lon, z) => Math.floor((lon + 180) / 360 * 2 ** z);
const row = (lat, z) => Math.floor((1 - Math.asinh(Math.tan(lat * RAD)) / Math.PI) / 2 * 2 ** z);

/** The area saved for a town from lib/cities.mjs. */
export function cityArea(city) {
  return { id: 'city:' + city.name, name: city.name, lat: city.lat, lon: city.lon, r: Math.max(city.r ?? 0, MIN_CITY_RADIUS) };
}
/** The area around the middle of the map. */
export function viewArea(lon, lat) {
  return { id: 'view', name: 'Видимая часть карты', lat, lon, r: VIEW_RADIUS };
}

/** Site paths ('/atlas-data/bundle-13-1420-773.json', '/atlas-houses/2840-1547.bin', …) of every file
    the map reads inside the area at any zoom, sorted. Only files the lists say exist are included. */
export function areaFiles(area, lists) {
  const cos = Math.max(0.01, Math.cos(area.lat * RAD));
  const west = area.lon - area.r / cos, east = area.lon + area.r / cos;
  const north = Math.min(85, area.lat + area.r), south = Math.max(-85, area.lat - area.r);
  const out = new Set();
  for (const z of TILE_TIERS) {
    const x0 = column(west, z), x1 = column(east, z), y0 = row(north, z), y1 = row(south, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (lists.tiles.has(`${z}-${x}-${y}.json`)) out.add(`/atlas-data/bundle-${z}-${Math.floor(x / BUNDLE)}-${Math.floor(y / BUNDLE)}.json`);
        if (z === HOUSE_TIER) {
          const group = `${Math.floor(x / HOUSE_GROUP)}-${Math.floor(y / HOUSE_GROUP)}`;
          if (lists.houses.has(group)) out.add(`/atlas-houses/${group}.bin`);
        }
        if (z === ROAD_TIER) {
          const name = `${x}-${y}`;
          if (lists.roads.has(name)) out.add(`/atlas-roads/${name}.json`);
          if (lists.things.has(name)) out.add(`/atlas-things/${name}.json`);
          if (lists.walks.has(name)) out.add(`/atlas-walks/${name}.json`);
        }
      }
    }
  }
  return [...out].sort();
}

const SAVED_MAP_PATH = /^\/atlas-data\/bundle-\d+-\d+-\d+\.json$|^\/atlas-houses\/\d+-\d+\.bin$|^\/atlas-(roads|things|walks)\/\d+-\d+\.json$|^\/graph-(nodes|edges)-\d+\.json$/;
/** Whether a site path is a piece of map or routing graph that can be saved and deleted again.
    The app itself, the lists (index.json), places and streets are never among them. */
export function isSavedMapPath(path) {
  return SAVED_MAP_PATH.test(path);
}

/** Total size of the files from offline-sizes.json, or null when the sizes are unknown (a dev server). */
export function sumBytes(urls, sizes) {
  if (!sizes) return null;
  let total = 0;
  for (const url of urls) total += sizes[url] ?? 0;
  return total;
}

const KB = 1024, MB = KB * 1024, GB = MB * 1024;
const comma = value => value.toFixed(1).replace('.', ',');
/** '512 КБ', '23,6 МБ', '140 МБ', '1,2 ГБ'. */
export function formatBytes(n) {
  const bytes = Math.max(0, Number(n) || 0);
  // Each step is chosen after rounding, so 1 023,8 KiB reads '1,0 МБ', not '1024 КБ'.
  const kb = Math.round(bytes / KB);
  if (kb < 1024) return `${kb} КБ`;
  const tenths = Math.round(bytes / MB * 10) / 10;
  if (tenths < 100) return `${comma(tenths)} МБ`;
  const mb = Math.round(bytes / MB);
  if (mb < 1024) return `${mb} МБ`;
  return `${comma(bytes / GB)} ГБ`;
}
