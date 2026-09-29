// Checks public/route-worker.js with public/route-rules.js on small synthetic graphs; with --real
// also on the shipped national graph (about 30-60 s and 500 MB: node --max-old-space-size=2000).
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const code = await fs.readFile('public/route-worker.js', 'utf8');
const rulesCode = await fs.readFile('public/route-rules.js', 'utf8');
// The worker runs as a function of the globals a browser worker has. (A node:vm context would do,
// but there every Math call is a slow global lookup and the real graph takes minutes.) Node-only
// globals are hidden so the worker cannot come to rely on them.
const HIDDEN = ['process', 'require', 'module', 'exports', 'Buffer', 'global', 'globalThis'];
function worker(read) {
  const pending = new Map(), messages = []; let serial = 0, fetches = 0;
  const self = {
    location: { href: 'http://x/route-worker.js' },
    postMessage: message => { messages.push(message); pending.get(message.id)?.(message); pending.delete(message.id); },
  };
  const fetch = async url => { fetches++; return { ok: true, json: () => read(new URL(url).pathname) }; };
  // Like a worker, scripts load next to the worker file.
  const importScripts = (...urls) => { for (const url of urls) { assert.equal(url, 'route-rules.js'); new Function('self', ...HIDDEN, rulesCode)(self); } };
  new Function('self', 'importScripts', 'fetch', ...HIDDEN, code)(self, importScripts, fetch);
  return {
    request(start, end, maxRoutes = 3, extra = {}) {
      const id = ++serial;
      return new Promise(resolve => { pending.set(id, resolve); self.onmessage({ data: { id, start, end, maxRoutes, ...extra } }); });
    },
    send: data => self.onmessage({ data }), messages,
    get fetches() { return fetches; },
    rules: self.RouteRules,
  };
}
const plain = value => JSON.parse(JSON.stringify(value));
const KLAT = 6371008.8 * Math.PI / 180;
/** A point `north` and `east` metres from `base`. */
const at = (base, north, east) => [base[0] + north / KLAT, base[1] + east / (KLAT * Math.cos(base[0] * Math.PI / 180))];
const graph = (nodes, edges, modes = 1) => worker(async () => ({ nodes, edges, modes }));
const sameRoute = (a, b) => JSON.stringify(plain(a)) === JSON.stringify(plain(b));
const RES = 7 << 5, SECONDARY = 4 << 5, TRACK = 15 << 5, UNPAVED = 512;
let result;

// ---- Old behaviour: one-way streets, bad input, far points, no connection ----
const singleNodes = [[38.57,68.78],[38.57,68.79],[38.58,68.79],[38.59,68.79]];
const oneWay = graph(singleNodes, [[0,1,1],[1,2,1],[2,3,0]]);
result = await oneWay.request(singleNodes[0], singleNodes[3]);
assert.equal(result.path.length, 4); assert.equal(result.routes.length, 1);
assert(result.meters > 2000 && result.meters < 3500);
assert.equal(result.estimateSpeedKmh, 35);
assert.equal(result.routes[0].seconds, Math.round(result.meters / (35 / 3.6)), 'class-0 roads keep the flat 35 km/h');
assert.deepEqual(plain(result.startPoint), singleNodes[0]); assert.deepEqual(plain(result.endPoint), singleNodes[3]);
result = await oneWay.request(singleNodes[3], singleNodes[0]); assert(result.error, 'one-way reverse must fail');
result = await oneWay.request([40,70], singleNodes[0]); assert(result.error, 'far from road must fail');
result = await oneWay.request(singleNodes[0], singleNodes[0]); assert(result.error, 'same snapped point cannot become a zero-length route');
assert.match(result.error, /совпадают/);
const invalid = worker(async () => { throw Error('invalid coordinates must be rejected before loading'); });
for (const start of [[NaN,70],[Infinity,70],[91,70],[40,181],[],['40',70],null]) {
  result = await invalid.request(start, [40,70]); assert(result.error);
}
assert.equal(invalid.fetches, 0);
const disconnected = graph(singleNodes, [[0,1,0],[2,3,0]]);
result = await disconnected.request(singleNodes[0], singleNodes[3]); assert(result.error);
assert.doesNotMatch(result.error, /автомобильн/, 'the no-path message fits every way of travel');

// ---- Alternatives: three distinct corridors about 5 km long; a fourth is a 20 km detour ----
const nodes = [[40,70],[40,70.03],[40,70.06],[40.012,70.03],[39.985,70.03],[40.09,70.03]];
const edges = [[0,1,1],[1,2,1],[0,3,1],[3,2,1],[0,4,1],[4,2,1],[0,5,1],[5,2,1]];
const alternatives = graph(nodes, edges);
result = await alternatives.request(nodes[0], nodes[2]);
assert.equal(result.routes.length, 3, 'three reasonable distinct corridors must be returned');
assert.deepEqual(plain(result.routes[0].path), [nodes[0],nodes[1],nodes[2]], 'the cheapest route comes first');
assert.equal(new Set(result.routes.map(r => JSON.stringify(r.path))).size, 3);
for (let i = 0; i < result.routes.length; i++) {
  const route = result.routes[i];
  assert(route.meters <= result.routes[0].meters * 1.35, 'no alternative is more than 35% longer');
  assert(Number.isInteger(route.turns));
  if (i) assert(route.seconds >= result.routes[i-1].seconds, 'routes are sorted by time');
  for (let j = 1; j < route.path.length; j++) {
    const a = nodes.findIndex(p => JSON.stringify(p) === JSON.stringify(route.path[j-1]));
    const b = nodes.findIndex(p => JSON.stringify(p) === JSON.stringify(route.path[j]));
    assert(edges.some(e => e[0] === a && e[1] === b), 'every segment must be a directed graph edge');
  }
}
assert(!result.routes.some(r => r.path.some(p => p[0] > 40.05)), 'the 20 km corridor is never offered');
result = await alternatives.request(nodes[0], nodes[2], 20); assert.equal(result.routes.length, 3);
result = await alternatives.request(nodes[0], nodes[2], 1); assert.equal(result.routes.length, 1);
// Out of time for alternatives, the best route still comes back at once.
{
  const { ALT } = alternatives.rules, budget = ALT.budgetMs;
  ALT.budgetMs = -1;
  try { result = await alternatives.request(nodes[0], nodes[2]); } finally { ALT.budgetMs = budget; }
  assert.equal(result.routes.length, 1, 'no alternative search is started past the time budget');
  assert.deepEqual(plain(result.routes[0].path), [nodes[0],nodes[1],nodes[2]]);
}
result = await alternatives.request(nodes[2], nodes[0]); assert(result.error, 'alternatives cannot violate one-way restrictions');
const excessiveDetour = graph(nodes, [[0,1,1],[1,2,1],[0,5,1],[5,2,1]]);
result = await excessiveDetour.request(nodes[0], nodes[2]);
assert.equal(result.routes.length, 1, 'a long detour cannot be used to fill a second route card');
// A tiny bypass sharing most of the road is not an alternative, on a short trip or a long one.
const sharedNodes = [[40,70],[40,70.009],[40,70.01],[40.0001,70.0095],[40,70.02]];
const sharedEdges = [[0,1,0],[1,2,0],[2,4,0],[1,3,0],[3,2,0]];
result = await graph(sharedNodes, sharedEdges).request(sharedNodes[0], sharedNodes[4]);
assert.equal(result.routes.length, 1, 'weighted overlap rejects nearly identical routes');
const longShared = sharedNodes.map(([lat, lon]) => [40 + (lat - 40) * 3, 70 + (lon - 70) * 3]);
result = await graph(longShared, sharedEdges).request(longShared[0], longShared[4]);
assert.equal(result.routes.length, 1, 'a small bypass of a 5 km route is not an alternative');
// A lane one block away is the same way, not an alternative.
{
  // Two 3.5 km streets 100 m apart, joined every 500 m: long enough for alternatives in every mode.
  const A = [40, 70], ladder = [], rungs = [], steps = 7;
  for (let i = 0; i <= steps; i++) { ladder.push(at(A, 0, 500 * i), at(A, 100, 500 * i)); }
  for (let i = 0; i < steps; i++) rungs.push([2 * i, 2 * i + 2, 0], [2 * i + 1, 2 * i + 3, 0]);
  for (let i = 0; i <= steps; i++) rungs.push([2 * i, 2 * i + 1, 0]);
  for (const network of ['foot', 'bike', 'car']) {
    result = await graph(ladder, rungs).request(A, ladder[2 * steps], 3, { network, speed: 10 });
    assert.equal(result.routes.length, 1, `${network}: a parallel lane 100 m away is not offered as a second route`);
  }
}
// A walk shorter than 2 km gets one route.
{
  const small = [[40,70],[40,70.01],[40,70.02],[40.004,70.01],[39.995,70.01]];
  result = await graph(small, [[0,1,0],[1,2,0],[0,3,0],[3,2,0],[0,4,0],[4,2,0]]).request(small[0], small[2], 3, { network: 'foot', speed: 5 });
  assert.equal(result.routes.length, 1, 'short walks get no alternatives');
}

// ---- Stale requests ----
const stale = graph(nodes, edges);
const first = stale.send({ id: 11, start: nodes[0], end: nodes[2] });
await stale.send({ id: 12, start: nodes[0], end: nodes[2], maxRoutes: 1 });
await first;
// Loading progress carries no request id; only results do.
assert.deepEqual(stale.messages.filter(m => m.id !== undefined).map(m => m.id), [12], 'stale requests must not post a result');

// ---- One graph for every way of travel: flags close an edge to a mode or make it one-way for it ----
// 0→1 is a footway (closed to cars and bicycles); 1→2 a one-way street for cars and bicycles.
const modeNodes = [[40, 70], [40, 70.005], [40, 70.01]];
const modes = worker(async () => ({ nodes: modeNodes, edges: [[0, 1, 2 | 8], [1, 2, 1 | 16]], modes: 1 }));
result = await modes.request(modeNodes[0], modeNodes[2], 1, { network: 'foot', speed: 5 });
assert.equal(result.path.length, 3, 'a pedestrian takes the footway');
assert.equal(result.estimateSpeedKmh, 5);
assert.equal(result.routes[0].seconds, Math.round(result.meters / (5 / 3.6)));
result = await modes.request(modeNodes[2], modeNodes[1], 1, { network: 'foot', speed: 5 });
assert.equal(result.path.length, 2, 'a pedestrian may walk against a one-way street');
for (const network of ['car', 'bike']) {
  result = await modes.request(modeNodes[0], modeNodes[2], 1, { network, speed: 15 });
  assert.ok(result.startGap > 400 && plain(result.path[0]).join() === modeNodes[1].join(), `${network} starts where the street begins, never on the footway`);
  result = await modes.request(modeNodes[2], modeNodes[1], 1, { network, speed: 15 });
  assert.ok(result.error, `${network} keeps to the one-way street`);
}
// Buses drive the car network at their own pace.
result = await oneWay.request(singleNodes[0], singleNodes[3], 1, { network: 'car', speed: 22 });
assert.equal(result.routes[0].seconds, Math.round(result.meters / (35 / 3.6) * 35 / 22));

// ---- Road classes: a walk takes the paved secondary road 4% longer than an unpaved lane ----
{
  const A = [40, 70], B = at(A, 0, 1000), apex = at(A, 142.8, 500), mid = at(A, 0, 500);
  const g = graph([A, mid, B, apex], [[0, 1, RES | UNPAVED], [1, 2, RES | UNPAVED], [0, 3, SECONDARY], [3, 2, SECONDARY]], 2);
  result = await g.request(A, B, 1, { network: 'foot', speed: 5 });
  assert(result.path.some(p => p[0] > A[0] + 0.001), 'the walk keeps to the secondary road');
  assert(Math.abs(result.meters - 1040) < 3, `secondary road length ${result.meters}`);
  // The same graph without class bits routes by length alone.
  const old = graph([A, mid, B, apex], [[0, 1, 0], [1, 2, 0], [0, 3, 0], [3, 2, 0]]);
  result = await old.request(A, B, 1, { network: 'foot', speed: 5 });
  assert(Math.abs(result.meters - 1000) < 1, 'class 0: the straight lane');
}
// A car does not take a secondary road 65% longer to save 12 seconds on a 1 km residential street,
// and the time shown is the driving time alone (1 km at 25 km/h), without the metre charge.
{
  const A = [40, 70], B = at(A, 0, 1000), C = at(A, Math.sqrt(825 ** 2 - 500 ** 2), 500);
  const g = graph([A, B, C], [[0, 1, RES], [0, 2, SECONDARY], [2, 1, SECONDARY]], 2);
  result = await g.request(A, B, 1, { network: 'car', speed: 35 });
  assert(Math.abs(result.meters - 1000) < 1, `the direct street (${Math.round(result.meters)} m)`);
  assert(Math.abs(result.routes[0].seconds - 144) <= 1, `driving time ${result.routes[0].seconds} s`);
  result = await g.request(A, B, 1, { network: 'car', speed: 22 });
  assert(Math.abs(result.routes[0].seconds - 144 * 35 / 22) <= 1, 'buses scale the driving time');
}

// ---- Turn costs: a staircase through side streets 5% shorter than the L along two streets loses ----
{
  const A = [40, 70], pts = [A], links = [], stub = [];
  // The L: 400 m east, then 400 m north. Its corner is a junction.
  pts.push(at(A, 0, 400), at(A, 400, 400)); links.push([0, 1, RES], [1, 2, RES]);
  // The staircase: seven turns at junctions, 764 m in all.
  const stairs = [[10, 100], [100, 110], [110, 200], [200, 210], [210, 300], [300, 310], [310, 400]];
  let previous = 0;
  for (const [north, east] of stairs) { pts.push(at(A, north, east)); links.push([previous, pts.length - 1, RES]); previous = pts.length - 1; stub.push(previous); }
  links.push([previous, 2, RES]);
  // Short dead ends make every bend of the staircase, and the corner of the L, a junction.
  for (const node of [...stub, 1]) { pts.push(at(pts[node], -30, 30)); links.push([node, pts.length - 1, RES]); }
  for (const network of ['foot', 'bike', 'car']) {
    result = await graph(pts, links, 2).request(A, pts[2], 1, { network, speed: 10 });
    assert(result.routes[0].turns <= 2, `${network}: ${result.routes[0].turns} turns`);
    assert(Math.abs(result.meters - 800) < 1, `${network}: the L along the streets (${Math.round(result.meters)} m)`);
  }
  // Without class bits the turns still cost.
  result = await graph(pts, links.map(([a, b]) => [a, b, 0])).request(A, pts[2], 1, { network: 'foot', speed: 5 });
  assert(Math.abs(result.meters - 800) < 1, 'class 0 graphs get turn costs too');
}

// ---- Snapping to the nearest point on a road, not the nearest vertex ----
{
  const P0 = [40, 70], P1 = at(P0, 0, 400), P2 = at(P0, 0, 800), A = at(P0, 20, 200);
  const g = graph([P0, P1, P2], [[0, 1, RES], [1, 2, RES]], 2);
  result = await g.request(A, P2, 1, { network: 'foot', speed: 5 });
  assert(Math.abs(result.startGap - 20) <= 1, `start gap ${result.startGap}`);
  assert(Math.abs(result.path[0][1] - at(P0, 0, 200)[1]) < 1e-6 && Math.abs(result.path[0][0] - P0[0]) < 1e-6, 'the route starts beside A, mid-edge');
  assert(Math.abs(result.meters - 600) < 1);
  assert.deepEqual(plain(result.startPoint), plain(result.path[0]));
  assert.deepEqual(plain(result.endPoint), plain(result.path.at(-1)));
  // Both ends on one edge: the route is the piece between them.
  result = await g.request(at(P0, 10, 100), at(P0, -12, 350), 3, { network: 'foot', speed: 5 });
  assert.equal(result.path.length, 2); assert(Math.abs(result.meters - 250) < 1, `same-edge route ${result.meters}`);
  result = await g.request(at(P0, 10, 100), at(P0, -20, 110), 1, { network: 'foot', speed: 5 });
  assert.match(result.error, /одному участку/, 'two ends a few metres apart on one road');
}
// A track right beside the point loses to a street a little further away, but not to a street far off.
for (const [streetGap, expected] of [[25, 25], [80, 10]]) {
  const A = [40, 70.01];
  const pts = [at(A, 10, -300), at(A, 10, 300), at(A, -streetGap, -300), at(A, -streetGap, 300), at(A, -streetGap, 900)];
  const g = graph(pts, [[0, 1, TRACK | UNPAVED | 2], [2, 3, RES], [0, 2, 0], [1, 3, 0], [3, 4, RES]], 2);
  result = await g.request(A, pts[4], 1, { network: 'foot', speed: 5 });
  assert(Math.abs(result.startGap - expected) < 1, `street ${streetGap} m away: start gap ${result.startGap}, expected ${expected}`);
}
// Snapping looks as far as it must: a track 200 m away, then a path 260 m away, and a street 700 m
// away that still beats the path (it is within 3 x 260 m). Scanning in steps finds what one wide scan finds.
{
  const A = [40, 70.02];
  const pts = [at(A, 200, -400), at(A, 200, 400), at(A, -260, -400), at(A, -260, 400), at(A, -800, 700), at(A, 800, 700), at(A, 800, 1500)];
  const g = graph(pts, [[0, 1, TRACK | UNPAVED | 2], [2, 3, (13 << 5) | 2], [4, 5, RES], [5, 6, RES]], 2);
  result = await g.request(A, pts[6], 1, { network: 'foot', speed: 5 });
  assert(!result.error && Math.abs(result.startGap - 700) < 1, `the street 700 m away: ${result.error ?? result.startGap}`);
}
// A car on a one-way street drives on and comes round; a pedestrian walks straight back.
{
  const W = [40, 70], E = at(W, 0, 1000), NE = at(W, 300, 1000), NW = at(W, 300, 0);
  const g = graph([W, E, NE, NW], [[0, 1, 1], [1, 2, 0], [2, 3, 0], [3, 0, 0]]);
  const A = at(W, 10, 700), B = at(W, 10, 300);
  result = await g.request(A, B, 1, { network: 'car', speed: 35 });
  assert(Math.abs(result.meters - 2200) < 2, `car goes round the block: ${result.meters}`);
  result = await g.request(A, B, 1, { network: 'foot', speed: 5 });
  assert(Math.abs(result.meters - 400) < 1, `pedestrian walks back: ${result.meters}`);
}
// After leaving the route, the carriageway the driver is heading along is preferred.
{
  const A = [40, 70];
  const pts = [at(A, -500, 6), at(A, 500, 6), at(A, 500, -6), at(A, -500, -6), at(A, -900, 0)];
  const g = graph(pts, [[0, 1, 1], [2, 3, 1], [1, 2, 0], [3, 0, 0], [0, 4, 0]]);
  result = await g.request(A, pts[4], 1, { network: 'car', speed: 35, heading: 180 });
  assert(result.startPoint[1] < A[1], 'heading south: the southbound carriageway');
  result = await g.request(A, pts[4], 1, { network: 'car', speed: 35, heading: 0 });
  assert(result.startPoint[1] > A[1], 'heading north: the northbound carriageway');
}
// An end next to a scrap of path that connects to nothing moves to the street nearby.
{
  const A = [40, 70];
  const pts = [at(A, 5, -20), at(A, 5, 20), at(A, -60, -300), at(A, -60, 300), at(A, -60, 900)];
  const g = graph(pts, [[0, 1, 11 << 5], [2, 3, RES], [3, 4, RES]], 2);
  result = await g.request(A, pts[4], 1, { network: 'foot', speed: 5 });
  assert(!result.error && Math.abs(result.startGap - 60) < 1, `start moved to the connected street: ${result.error ?? result.startGap}`);
}

// ---- The turn count matches the planner's own step list ----
{
  const { countTurns } = alternatives.rules;
  let navigation = null;
  try { navigation = await import('../lib/navigation.ts'); } catch { console.log('note: lib/navigation.ts not importable here, turn count cross-check skipped'); }
  const A = [40, 70];
  const paths = [
    [A, at(A, 0, 300), at(A, 300, 300), at(A, 300, 600), at(A, 0, 600)],
    [A, at(A, 50, 10), at(A, 100, 0), at(A, 150, 12), at(A, 200, 0)],
    [A, at(A, 0, 200), at(A, 5, 205), at(A, 10, 210), at(A, 200, 210), at(A, 180, 20)],
  ];
  for (const path of paths) {
    const expected = navigation ? navigation.buildManeuvers(path).filter(m => m.kind !== 'straight' && m.kind !== 'arrive').length : null;
    if (expected !== null) assert.equal(countTurns(path), expected, 'countTurns is the planner\'s peak detection');
  }
  assert.equal(countTurns(paths[0]), 3);
}
console.log('PASS: cost ordering, three distinct corridors, detour/overlap/separation/lane filters, time estimate, invalid/disconnected/same points, stale cancellation, per-mode networks and speeds, road classes, turn costs, edge snapping, one-way starts, reroute heading, stray fragments');

if (process.argv.includes('--real')) {
  // One cached national graph, loaded directly from chunks (no duplicate in runner).
  const real = worker(async path => JSON.parse(await fs.readFile(`public${path}`, 'utf8')));
  const spec = JSON.parse(await fs.readFile('public/road-graph.json', 'utf8')), classes = (spec.modes ?? 0) >= 2;
  const trip = async (label, start, end, extra = {}) => {
    const before = performance.now(); const r = await real.request(start, end, extra.maxRoutes ?? 3, { debug: true, ...extra });
    assert(r.routes?.[0]?.path.length >= 2, `${label}: ${r.error}`);
    assert(r.routes.length <= 3);
    assert.equal(new Set(r.routes.map(x => JSON.stringify(x.path))).size, r.routes.length);
    for (let i = 1; i < r.routes.length; i++) {
      assert(r.routes[i].meters <= r.routes[0].meters * 1.35, `${label}: alternative ${i} is too long`);
      // Sorted by cost (for a car, time plus a charge per metre), so the first route is the one to recommend.
      assert(r.debug.costs[i] >= r.debug.costs[i - 1], `${label}: sorted by cost`);
    }
    console.log(`${label}: ${r.routes.length} route(s) ${r.routes.map(x => `${Math.round(x.meters)} m/${Math.round(x.seconds / 60)} min/${x.turns} turns`).join(', ')}; gaps ${Math.round(r.startGap)}/${Math.round(r.endGap)} m; snap ${r.debug.snapMs} ms; best route ${r.debug.firstMs} ms (${r.debug.settled} nodes); with alternatives ${r.debug.ms} ms; ${(performance.now() - before).toFixed(0)} ms in all`);
    return r;
  };
  // The Shaydon walk from М Вохидов 2 to R-303: straight to the main road and along it.
  const shaydon = await trip('Shaydon walk to R-303', [40.64715, 70.37422], [40.65643, 70.36662], { network: 'foot', speed: 5 });
  assert.equal(shaydon.routes.length, 1, 'a 1.5 km walk gets one route');
  assert(shaydon.routes[0].turns <= 3, `${shaydon.routes[0].turns} turn prompts`);
  assert(shaydon.startGap <= 25 && shaydon.endGap <= 50, 'both ends join the nearest road line');
  assert(Math.abs(shaydon.meters - 1530) < 80, `about 1.53 km (${Math.round(shaydon.meters)} m)`);
  // Metres of the walk along R-303 (way 391146809), whose line is in the z10 road tile.
  let onR303 = null;
  try {
    const tile = JSON.parse(await fs.readFile('public/atlas-roads/712-385.json', 'utf8'));
    const record = tile.roads.find(r => r[0] === 391146809);
    if (record) {
      const line = []; let x = 0, y = 0;
      for (let i = 3; i + 1 < record.length; i += 2) { x += record[i]; y += record[i + 1]; line.push([y / 1e6, x / 1e6]); }
      const { distance } = real.rules;
      const path = shaydon.routes[0].path; onR303 = 0;
      for (let i = 1; i < path.length; i++) {
        const mid = [(path[i - 1][0] + path[i][0]) / 2, (path[i - 1][1] + path[i][1]) / 2];
        const near = line.some((p, k) => k && (() => {
          const kx = KLAT * Math.cos(mid[0] * Math.PI / 180), ax = (line[k - 1][1] - mid[1]) * kx, ay = (line[k - 1][0] - mid[0]) * KLAT;
          const dx = (p[1] - line[k - 1][1]) * kx, dy = (p[0] - line[k - 1][0]) * KLAT, L = dx * dx + dy * dy;
          const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
          return Math.hypot(ax + t * dx, ay + t * dy) <= 15;
        })());
        if (near) onR303 += distance(path[i - 1], path[i]);
      }
    }
  } catch {}
  console.log(`  on R-303: ${onR303 === null ? 'line not found, skipped' : Math.round(onR303) + ' m'}; road classes ${classes ? JSON.stringify(shaydon.debug.classMetres[0]) : 'not in this graph (modes < 2)'}`);
  if (onR303 !== null) assert(onR303 > 800, 'the walk follows R-303 for most of the way');
  if (classes) {
    const metres = shaydon.debug.classMetres[0], main = metres[2] + metres[3] + metres[4] + metres[5];
    assert(main >= 0.45 * metres.reduce((a, b) => a + b, 0), 'at least 45% of the walk on trunk to tertiary roads');
  }
  await trip('Shaydon drive', [40.6602, 70.36], [40.6439, 70.3831]);
  await trip('Dushanbe drive', [38.575, 68.79], [38.59, 68.8]);
  await trip('Dushanbe walk', [38.568, 68.775], [38.585, 68.79], { network: 'foot', speed: 5 });
  await trip('Dushanbe drive, reroute heading east', [38.5735, 68.7865], [38.59, 68.8], { maxRoutes: 1, heading: 90 });
  await trip('Dushanbe to Khujand', [38.5598, 68.787], [40.2826, 69.6222]);
  console.log(`PASS: real graph (${classes ? 'with road classes' : 'class 0, before the rebuild'})`);
}
