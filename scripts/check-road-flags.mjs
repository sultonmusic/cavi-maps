/* The road lines of the map tiles agree with the asphalt streets (scripts/flag-asphalt-roads.py):
 * every road line in every bundle carries its OpenStreetMap way id, and it is marked asphalt exactly
 * when public/atlas-roads draws that way, so no street is drawn both as a plain line and as asphalt.
 * Every asphalt street has its line in the zoom-13 tiles, and every tile with roads is listed.
 *
 * Also checks how lib/road-style.ts draws them: no yellow, filters that split the lines into plain
 * and asphalt and hide the admin's own streets, and asphalt lines never thinner than the plain lines
 * of main roads were; and that lib/atlas-gl.ts uses it (skip with --skip-source).
 *
 * It prints how many metres of plain main-road line in central Dushanbe lie under or beside the
 * to-scale asphalt: 35 km before the fix, none that share a way with the asphalt after it.
 *
 *   node scripts/check-road-flags.mjs [--data public/atlas-data] [--roads public/atlas-roads]
 *        [--expect 391146809,22884100,23358407,23344926] [--gl lib/atlas-gl.ts] [--skip-source]
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values: options } = parseArgs({
  options: {
    data: { type: 'string', default: path.join(project, 'public', 'atlas-data') },
    roads: { type: 'string', default: path.join(project, 'public', 'atlas-roads') },
    // R-303 in Shaydon; Ismoili Somoni Avenue in Khujand; two carriageways near Rudaki Avenue in Dushanbe.
    expect: { type: 'string', default: '391146809,22884100,23358407,23344926' },
    gl: { type: 'string', default: path.join(project, 'lib', 'atlas-gl.ts') },
    'skip-source': { type: 'boolean', default: false },
  },
});
const ROAD_KINDS = new Set(['road-local', 'road-secondary', 'road-main']);
const TIER_KINDS = { 7: ['road-main'], 10: ['road-main', 'road-secondary'], 13: [...ROAD_KINDS] };
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
// Problems by kind, with a few examples of each.
const problems = new Map();
const problem = (message, kind = message) => {
  if (!problems.has(kind)) problems.set(kind, { count: 0, examples: [] });
  const entry = problems.get(kind);
  if (entry.count++ < 3) entry.examples.push(message);
};

// --- the asphalt streets -------------------------------------------------------------------
const roadsMeta = readJson(path.join(options.roads, 'index.json'));
const asphalt = new Set();
const ribbons = [], drawn = new Set(); // central Dushanbe, for the metric
const METRIC_GROUPS = new Set(['706-391', '706-392', '706-393', '707-391', '707-392', '707-393', '708-391', '708-392', '708-393']);
for (const name of roadsMeta.groups) {
  for (const [way, lanes, oneway, ...steps] of readJson(path.join(options.roads, `${name}.json`)).roads) {
    asphalt.add(way);
    if (!METRIC_GROUPS.has(name) || drawn.has(way)) continue;
    drawn.add(way);
    const line = [];
    for (let i = 0, x = 0, y = 0; i + 1 < steps.length; i += 2) { x += steps[i]; y += steps[i + 1]; line.push([x / 1e6, y / 1e6]); }
    ribbons.push({ way, line, half: ((oneway ? lanes : lanes * 2) * 3.4 || 4.6) / 2 });
  }
}

// --- the tiles -----------------------------------------------------------------------------
const meta = readJson(path.join(options.data, 'index.json'));
const size = meta.bundleSize ?? 4;
const listed = new Set(meta.tiles);
const found = new Set();
const flagged = new Set(); // asphalt ways with a zoom-13 line
const counts = {};
const count = key => { counts[key] = (counts[key] ?? 0) + 1; };
const bundles = readdirSync(options.data).filter(name => /^bundle-\d+-\d+-\d+\.json$/.test(name)).sort();
assert.ok(bundles.length > 0, `no bundles in ${options.data}`);
const METRIC_TILES = [];
for (let x = 5660; x <= 5663; x++) for (let y = 3140; y <= 3143; y++) METRIC_TILES.push(`13-${x}-${y}.json`);
const metricTiles = new Map();

for (const bundleName of bundles) {
  const bundle = readJson(path.join(options.data, bundleName));
  for (const [name, features] of Object.entries(bundle)) {
    const [z, x, y] = name.slice(0, -5).split('-').map(Number);
    if (`bundle-${z}-${Math.floor(x / size)}-${Math.floor(y / size)}.json` !== bundleName) problem(`${name} is filed in ${bundleName}`, 'tile filed in the wrong bundle');
    found.add(name);
    let roads = 0;
    for (const feature of features) {
      const [kind, polygon, rings, props] = feature;
      if (!ROAD_KINDS.has(kind)) continue;
      roads++;
      const where = `${kind} in ${name}`;
      if (!TIER_KINDS[z]?.includes(kind)) problem(`${where}: tier ${z} carries no ${kind}`, 'road kind in the wrong tier');
      if (polygon !== 0 || !Array.isArray(rings) || !rings.length || rings.some(ring => ring.length < 2)) problem(`${where}: not a line`, 'road that is not a line');
      if (!props || typeof props !== 'object' || !Number.isInteger(props.way) || props.way <= 0) {
        problem(`${where}: no way id`, 'road line without a way id');
        count(`${z}:${kind}:no-way`);
        continue;
      }
      const extra = Object.keys(props).filter(key => key !== 'way' && key !== 'style');
      if (extra.length) problem(`${where}: stale fields ${extra.join(', ')} on way/${props.way}`, 'road line with stale fields');
      const paved = props.style === 'asphalt';
      if (props.style !== undefined && !paved) problem(`${where}: unknown style ${props.style}`, 'road line with an unknown style');
      if (paved !== asphalt.has(props.way)) {
        const why = paved ? 'marked asphalt but public/atlas-roads does not draw it' : 'plain but public/atlas-roads draws it as asphalt';
        problem(`${where}: way/${props.way} is ${why}`, `road line ${why}`);
      }
      if (paved && z === 13) flagged.add(props.way);
      count(`${z}:${kind}`);
      if (paved) count(`${z}:${kind}:asphalt`);
    }
    if (roads && !listed.has(name)) problem(`${name} has roads but index.json does not list it, so the map never loads it`, 'tile with roads missing from index.json');
    if (METRIC_TILES.includes(name)) metricTiles.set(name, features);
  }
}
const unbundled = meta.tiles.filter(name => !found.has(name));
if (unbundled.length) problem(`index.json lists ${unbundled.length} tiles no bundle holds, e.g. ${unbundled.slice(0, 3).join(', ')}`);
const missing = [...asphalt].filter(way => !flagged.has(way));
if (missing.length) problem(`${missing.length} asphalt streets have no marked zoom-13 line, e.g. way/${missing.slice(0, 5).join(', way/')}`);
for (const way of options.expect.split(',').filter(Boolean).map(Number)) {
  if (!flagged.has(way)) problem(`way/${way} is not marked asphalt in the zoom-13 tiles`);
}
const reportFile = path.join(options.data, 'road-flags.json');
if (!existsSync(reportFile)) problem('road-flags.json is missing: run python scripts/flag-asphalt-roads.py');
else {
  const report = readJson(reportFile);
  if (report.asphalt_ways !== asphalt.size) problem(`road-flags.json counts ${report.asphalt_ways} asphalt streets, public/atlas-roads has ${asphalt.size}: rerun flag-asphalt-roads.py`);
  if (report.missing_count) problem(`road-flags.json reports ${report.missing_count} missing asphalt streets`);
  const differ = Object.keys({ ...counts, ...report.features }).filter(key => (counts[key] ?? 0) !== (report.features?.[key] ?? 0));
  if (differ.length) problem(`road-flags.json does not describe these tiles (${differ.slice(0, 4).map(key => `${key}: ${report.features?.[key] ?? 0} reported, ${counts[key] ?? 0} found`).join('; ')}): rerun flag-asphalt-roads.py`);
}

// --- central Dushanbe: plain line under or beside the asphalt, seen at zoom 19 ---------------
function dushanbeMetric() {
  if (!metricTiles.size || !ribbons.length) return null;
  const unproject = (nx, ny) => [nx * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * ny))) * 180 / Math.PI];
  const cos = Math.cos(38.58 * Math.PI / 180), M = 111_320, CELL = 0.0004, grid = new Map();
  for (const { way, line, half } of ribbons) {
    for (let i = 1; i < line.length; i++) {
      const s = { a: line[i - 1], b: line[i], half, way };
      const i0 = Math.floor(Math.min(s.a[0], s.b[0]) / CELL) - 1, i1 = Math.floor(Math.max(s.a[0], s.b[0]) / CELL) + 1;
      const j0 = Math.floor(Math.min(s.a[1], s.b[1]) / CELL) - 1, j1 = Math.floor(Math.max(s.a[1], s.b[1]) / CELL) + 1;
      for (let gi = i0; gi <= i1; gi++) for (let gj = j0; gj <= j1; gj++) {
        const key = gi + ',' + gj;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(s);
      }
    }
  }
  // How far inside the asphalt's kerb (0.3 m) a point lies, in metres; negative outside.
  const cover = p => {
    let best = -Infinity;
    for (const s of grid.get(Math.floor(p[0] / CELL) + ',' + Math.floor(p[1] / CELL)) ?? []) {
      const ax = (s.a[0] - p[0]) * cos * M, ay = (s.a[1] - p[1]) * M, bx = (s.b[0] - p[0]) * cos * M, by = (s.b[1] - p[1]) * M;
      const dx = bx - ax, dy = by - ay, l = dx * dx + dy * dy;
      const t = l ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l)) : 0;
      best = Math.max(best, s.half + 0.3 - Math.hypot(ax + t * dx, ay + t * dy));
    }
    return best;
  };
  // Half the plain line with its casing at zoom 19 (2.2 x kind width + 1.5 px, 0.2335 m a pixel).
  const HALF = { 'road-main': (13.2 + 1.5) * 0.2335 / 2, 'road-secondary': (11 + 1.5) * 0.2335 / 2, 'road-local': (6.6 + 1.5) * 0.2335 / 2 };
  const out = {};
  for (const [name, features] of metricTiles) {
    const [, tx, ty] = name.slice(0, -5).split('-').map(Number);
    for (const [kind, , rings, props] of features) {
      if (!ROAD_KINDS.has(kind)) continue;
      const o = out[kind] ??= { plain: 0, hidden: 0, beside: 0, asphalt: 0 };
      for (const ring of rings) for (let i = 1; i < ring.length; i++) {
        const a = unproject((tx + ring[i - 1][0] / 4096) / 8192, (ty + ring[i - 1][1] / 4096) / 8192);
        const b = unproject((tx + ring[i][0] / 4096) / 8192, (ty + ring[i][1] / 4096) / 8192);
        const length = Math.hypot((b[0] - a[0]) * cos * M, (b[1] - a[1]) * M), steps = Math.max(1, Math.round(length));
        if (props?.style === 'asphalt') { o.asphalt += length; continue; }
        for (let k = 0; k < steps; k++) {
          const v = cover([a[0] + (b[0] - a[0]) * (k + 0.5) / steps, a[1] + (b[1] - a[1]) * (k + 0.5) / steps]);
          o.plain += length / steps;
          if (v >= HALF[kind]) o.hidden += length / steps;
          else if (v > -HALF[kind]) o.beside += length / steps;
        }
      }
    }
  }
  return out;
}
const metric = dushanbeMetric();
const km = metres => (metres / 1000).toFixed(1);
if (metric) {
  for (const kind of ['road-main', 'road-secondary', 'road-local']) {
    const o = metric[kind];
    if (o) console.log(`Central Dushanbe ${kind}: ${km(o.asphalt)} km asphalt; plain ${km(o.plain)} km, of it ${km(o.hidden)} km under the to-scale asphalt and ${km(o.beside)} km beside it`);
  }
} else console.log('Central Dushanbe metric skipped: its tiles or asphalt streets are not in this data');

// --- lib/road-style.ts ---------------------------------------------------------------------
let styleChecked = false;
try {
  const style = await import('../lib/road-style.ts');
  const { createPropertyExpression, featureFilter, latest } = await import('@maplibre/maplibre-gl-style-spec');
  const parse = (expression, spec) => {
    const parsed = createPropertyExpression(expression, spec);
    assert.equal(parsed.result, 'success', JSON.stringify(parsed.value));
    return (zoom, properties) => parsed.value.evaluate({ zoom }, { type: 'LineString', properties });
  };
  const width = expression => parse(expression, latest.paint_line['line-width']);
  const colour = expression => parse(expression, latest.paint_line['line-color']);
  // A warm grey at most: the old '#ffe1a1' and '#d8bb85' spread 94 and 83 of 255 between channels.
  for (const expression of [style.PLAIN_CASING, style.PLAIN_SURFACE]) {
    for (const kind of ROAD_KINDS) {
      const { r, g, b } = colour(expression)(12, { kind });
      assert.ok(Math.max(r, g, b) - Math.min(r, g, b) < 32 / 255, `plain ${kind} is not yellow`);
    }
  }
  for (const casing of [false, true]) {
    const plain = width(style.plainRoadWidth(casing)), paved = width(style.asphaltLineWidth(casing));
    for (let zoom = 4; zoom <= 16; zoom += 0.25) {
      for (const kind of ['road-main', 'road-secondary']) {
        // Exact at whole zooms; between them MapLibre blends the two whole-zoom values.
        const slack = Number.isInteger(zoom) ? 1e-3 : 0.1;
        assert.ok(paved(zoom, { kind }) >= plain(zoom, { kind }) - slack, `asphalt ${kind} at zoom ${zoom} is not thinner than its plain line`);
      }
      assert.ok(Math.abs(paved(zoom, {}) - style.asphaltPixels(zoom, casing)) < 0.05, `a live street keeps the asphalt width at zoom ${zoom}`);
      assert.ok(paved(zoom, { kind: 'road-local' }) >= paved(zoom, {}) - 1e-9);
    }
  }
  const plainFilter = featureFilter(style.plainRoadFilter([5])), pavedFilter = featureFilter(style.asphaltRoadFilter([5]));
  const plainAll = featureFilter(style.plainRoadFilter()), pavedAll = featureFilter(style.asphaltRoadFilter());
  const test = (filter, properties) => filter.filter({ zoom: 14 }, { type: 2, properties });
  for (const kind of ROAD_KINDS) {
    for (const properties of [{ kind, way: 1 }, { kind, way: 1, asphalt: 1 }, { kind }]) {
      assert.equal(test(plainAll, properties) + test(pavedAll, properties), 1, `a ${kind} line is drawn exactly one way`);
    }
    assert.ok(test(plainFilter, { kind, way: 1 }) && !test(plainFilter, { kind, way: 5 }), 'an admin street hides its plain line');
    assert.ok(test(pavedFilter, { kind, way: 1, asphalt: 1 }) && !test(pavedFilter, { kind, way: 5, asphalt: 1 }), 'an admin street hides its tile asphalt');
  }
  for (const kind of ['path', 'river', 'border']) assert.ok(!test(plainAll, { kind }) && !test(pavedAll, { kind, asphalt: 1 }), `${kind} is no road`);
  assert.equal(style.roadKind('trunk'), 'road-main');
  assert.equal(style.roadKind('tertiary_link'), 'road-secondary');
  assert.equal(style.roadKind('residential'), 'road-local');
  styleChecked = true;
} catch (error) {
  if (error?.code !== 'ERR_UNKNOWN_FILE_EXTENSION') throw error;
  console.log('lib/road-style.ts skipped: this Node cannot import TypeScript (use Node 22.18+ or --experimental-strip-types)');
}

// --- lib/atlas-gl.ts uses it -----------------------------------------------------------------
if (!options['skip-source']) {
  const source = readFileSync(options.gl, 'utf8');
  for (const yellow of ['#ffe1a1', '#d8bb85', '#fffaf0']) if (source.toLowerCase().includes(yellow)) problem(`lib/atlas-gl.ts still draws roads in ${yellow}`);
  for (const name of ['plainRoadFilter', 'asphaltRoadFilter', 'asphaltLineWidth', 'plainRoadWidth', 'PLAIN_CASING', 'PLAIN_SURFACE']) {
    if (!source.includes(name)) problem(`lib/atlas-gl.ts does not use ${name} from lib/road-style.ts`);
  }
  // The tiles draw asphalt from zoom 0, so an admin street must not vanish below zoom 10.
  if (/id: 'asphalt-(?:casing|surface)-live'[^\n]*minzoom/.test(source)) problem('lib/atlas-gl.ts still hides the live asphalt below a minzoom');
}

const summary = Object.entries(counts).sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([key, value]) => `${key} ${value}`).join(', ');
console.log(`Road lines: ${summary}`);
if (problems.size) {
  let total = 0;
  for (const [kind, { count: times, examples }] of problems) {
    total += times;
    console.error(`${times} x ${kind}\n    ${examples.join('\n    ')}`);
  }
  assert.fail(`${total} problems with the road lines`);
}
console.log(`PASS: ${bundles.length} bundles; every road line carries its way id and is asphalt exactly when public/atlas-roads draws it; `
  + `all ${asphalt.size} asphalt streets marked at zoom 13${styleChecked ? '; road style has no yellow and keeps main roads as wide as before' : ''}.`);
