import vm from 'node:vm';
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
const code = await fs.readFile('public/route-worker.js', 'utf8');
function worker(read) {
  const pending = new Map(), messages = []; let serial = 0, fetches = 0;
  const ctx = vm.createContext({
    fetch: async url => { fetches++; return { ok: true, json: () => read(url) }; },
    self: { postMessage: message => { messages.push(message); pending.get(message.id)?.(message); pending.delete(message.id); } },
    console, setTimeout, clearTimeout,
  });
  vm.runInContext(code, ctx);
  return {
    request(start, end, maxRoutes = 3, extra = {}) {
      const id = ++serial;
      return new Promise(resolve => { pending.set(id, resolve); ctx.self.onmessage({ data: { id, start, end, maxRoutes, ...extra } }); });
    },
    send: data => ctx.self.onmessage({ data }), messages,
    get fetches() { return fetches; },
  };
}
const plain = value => JSON.parse(JSON.stringify(value));
const singleNodes = [[38.57,68.78],[38.57,68.79],[38.58,68.79],[38.59,68.79]];
const oneWay = worker(async () => ({ nodes: singleNodes, edges: [[0,1,1],[1,2,1],[2,3,0]] }));
let result = await oneWay.request(singleNodes[0], singleNodes[3]);
assert.equal(result.path.length, 4); assert.equal(result.routes.length, 1);
assert(result.meters > 2000 && result.meters < 3500);
assert.equal(result.estimateSpeedKmh, 35);
assert.equal(result.routes[0].seconds, Math.round(result.meters / (35 / 3.6)));
result = await oneWay.request(singleNodes[3], singleNodes[0]); assert(result.error, 'one-way reverse must fail');
result = await oneWay.request([40,70], singleNodes[0]); assert(result.error, 'far from road must fail');
result = await oneWay.request(singleNodes[0], singleNodes[0]); assert(result.error, 'same snapped point cannot become a zero-length route');
const invalid = worker(async () => { throw Error('invalid coordinates must be rejected before loading'); });
for (const start of [[NaN,70],[Infinity,70],[91,70],[40,181],[],['40',70],null]) {
  result = await invalid.request(start, [40,70]); assert(result.error);
}
assert.equal(invalid.fetches, 0);
const disconnected = worker(async () => ({ nodes: singleNodes, edges: [[0,1,0],[2,3,0]] }));
result = await disconnected.request(singleNodes[0], singleNodes[3]); assert(result.error);
// Three independent corridors; a fourth corridor exceeds the detour limit.
const nodes = [[40,70],[40,70.01],[40,70.02],[40.004,70.01],[39.995,70.01],[40.03,70.01]];
const edges = [[0,1,1],[1,2,1],[0,3,1],[3,2,1],[0,4,1],[4,2,1],[0,5,1],[5,2,1]];
const alternatives = worker(async () => ({ nodes, edges }));
result = await alternatives.request(nodes[0], nodes[2]);
assert.equal(result.routes.length, 3, 'three reasonable distinct corridors must be returned');
assert.deepEqual(plain(result.routes[0].path), [nodes[0],nodes[1],nodes[2]], 'shortest actual road distance selected first');
assert.equal(new Set(result.routes.map(r => JSON.stringify(r.path))).size, 3);
for (let i = 0; i < result.routes.length; i++) {
  const route = result.routes[i];
  assert(route.meters <= result.routes[0].meters * 1.65);
  if (i) assert(route.meters >= result.routes[i-1].meters);
  for (let j = 1; j < route.path.length; j++) {
    const a = nodes.findIndex(p => JSON.stringify(p) === JSON.stringify(route.path[j-1]));
    const b = nodes.findIndex(p => JSON.stringify(p) === JSON.stringify(route.path[j]));
    assert(edges.some(e => e[0] === a && e[1] === b), 'every segment must be a directed graph edge');
  }
}
result = await alternatives.request(nodes[0], nodes[2], 20); assert.equal(result.routes.length, 3);
result = await alternatives.request(nodes[0], nodes[2], 1); assert.equal(result.routes.length, 1);
result = await alternatives.request(nodes[2], nodes[0]); assert(result.error, 'alternatives cannot violate one-way restrictions');
const excessiveDetour = worker(async () => ({ nodes, edges: [[0,1,1],[1,2,1],[0,5,1],[5,2,1]] }));
result = await excessiveDetour.request(nodes[0], nodes[2]);
assert.equal(result.routes.length, 1, 'a long detour cannot be used to fill a second route card');
// A tiny bypass sharing most of the road must not count as an alternative.
const sharedNodes = [[40,70],[40,70.009],[40,70.01],[40.0001,70.0095],[40,70.02]];
const shared = worker(async () => ({ nodes: sharedNodes, edges: [[0,1,0],[1,2,0],[2,4,0],[1,3,0],[3,2,0]] }));
result = await shared.request(sharedNodes[0], sharedNodes[4]); assert.equal(result.routes.length, 1, 'weighted overlap rejects nearly identical routes');
const stale = worker(async () => ({ nodes, edges }));
const first = stale.send({ id: 11, start: nodes[0], end: nodes[2] });
await stale.send({ id: 12, start: nodes[0], end: nodes[2], maxRoutes: 1 });
await first;
// Loading progress carries no request id; only results do.
assert.deepEqual(stale.messages.filter(m => m.id !== undefined).map(m => m.id), [12], 'stale requests must not post a result');
// One graph for every way of travel: flags close an edge to a mode or make it one-way for it.
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
console.log('PASS: shortest ordering, max-three distinct directed routes, detour/overlap limits, time estimate, invalid/disconnected/same points, stale cancellation, per-mode networks and speeds');
if (process.argv.includes('--real')) {
  // One cached national graph, loaded directly from chunks (no duplicate in runner).
  const real = worker(async url => JSON.parse(await fs.readFile(`public${url}`, 'utf8')));
  for (const [city, start, end] of [
    ['Shaydon', [40.6602,70.36], [40.6439,70.3831]],
    ['Dushanbe', [38.575,68.79], [38.59,68.8]],
  ]) {
    const before = performance.now(); result = await real.request(start, end);
    assert(result.routes?.[0]?.path.length > 2, `${city}: ${result.error}`);
    assert(result.routes.length <= 3);
    assert.equal(new Set(result.routes.map(r => JSON.stringify(r.path))).size, result.routes.length);
    for (let i = 1; i < result.routes.length; i++) {
      assert(result.routes[i].meters >= result.routes[i-1].meters);
      assert(result.routes[i].meters <= result.routes[0].meters * 1.65);
    }
    console.log(`PASS: real ${city}, ${result.routes.length} route(s), ${result.routes.map(r => Math.round(r.meters) + ' m').join(', ')}, ${(performance.now()-before).toFixed(0)} ms`);
  }
}
