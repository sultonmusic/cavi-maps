/* Local routing for driving, cycling and walking over one shared graph, each on the ways open to it.
   Costs, turns, snapping and the alternatives filter live in route-rules.js next to this file.
   Times are estimates at the planner's speed for the mode, without traffic data. */
importScripts('route-rules.js');
const R = self.RouteRules;
let graphPromise, generation = 0;
const DEFAULT_SPEED_KMH = 35, MAX_GAP = 1500, NEAR_SCAN = 250;
/* Edge flags: 1 one-way for motor vehicles, 2 closed to them, 4 closed to pedestrians, 8 closed to
   bicycles, 16 one-way for bicycles too; bits 5 and up describe the road (see route-rules.js).
   The older car-only graph used just 0 and 1, the older graph for every mode no class bits. */
const NETWORKS = { car: { closed: 2, oneway: 1 }, bike: { closed: 8, oneway: 16 }, foot: { closed: 4, oneway: 0 } };
const CANCELLED = Symbol('cancelled');
const RAD = Math.PI / 180, KLAT = 6371008.8 * RAD; // metres in a degree of latitude
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;

/** A binary heap of (priority, node) in typed arrays: no allocation per push. */
class Heap {
  constructor(capacity = 1 << 16) { this.prio = new Float64Array(capacity); this.node = new Int32Array(capacity); this.size = 0; }
  push(p, v) {
    if (this.size === this.prio.length) {
      const prio = new Float64Array(this.size * 2), node = new Int32Array(this.size * 2);
      prio.set(this.prio); node.set(this.node); this.prio = prio; this.node = node;
    }
    const prio = this.prio, node = this.node; let i = this.size++;
    while (i > 0) { const j = (i - 1) >> 1; if (prio[j] <= p) break; prio[i] = prio[j]; node[i] = node[j]; i = j; }
    prio[i] = p; node[i] = v;
  }
  pop() {
    const prio = this.prio, node = this.node, top = node[0], last = --this.size;
    if (last > 0) {
      const p = prio[last], v = node[last]; let i = 0;
      for (;;) {
        let j = 2 * i + 1; if (j >= last) break;
        if (j + 1 < last && prio[j + 1] < prio[j]) j++;
        if (prio[j] >= p) break; prio[i] = prio[j]; node[i] = node[j]; i = j;
      }
      prio[i] = p; node[i] = v;
    }
    return top;
  }
}

const packNodes = rows => {
  const lat = new Float64Array(rows.length), lon = new Float64Array(rows.length);
  for (let i = 0; i < rows.length; i++) { lat[i] = rows[i][0]; lon[i] = rows[i][1]; }
  return { lat, lon };
};
const packEdges = rows => {
  const from = new Uint32Array(rows.length), to = new Uint32Array(rows.length), flags = new Uint16Array(rows.length);
  for (let i = 0; i < rows.length; i++) { const e = rows[i]; from[i] = e[0]; to[i] = e[1]; flags[i] = e[2] || 0; }
  return { from, to, flags };
};
function concat(parts, key, Type) {
  const out = new Type(parts.reduce((sum, part) => sum + part[key].length, 0));
  let at = 0; for (const part of parts) { out.set(part[key], at); at += part[key].length; }
  return out;
}
/** Every edge filed under each grid cell its bounding box touches, so snapping reads a few cells. */
function buildGrid(g) {
  const { lat, lon, edgeFrom, edgeTo } = g, m = edgeFrom.length;
  let south = Infinity, west = Infinity, north = -Infinity, east = -Infinity;
  for (let i = 0; i < lat.length; i++) {
    if (lat[i] < south) south = lat[i]; if (lat[i] > north) north = lat[i];
    if (lon[i] < west) west = lon[i]; if (lon[i] > east) east = lon[i];
  }
  if (!(north >= south)) { south = north = west = east = 0; }
  let cell = 0.01, cols, rows;
  for (;;) {
    cols = Math.floor(east / cell) - Math.floor(west / cell) + 1; rows = Math.floor(north / cell) - Math.floor(south / cell) + 1;
    if (cols * rows <= 2_000_000) break; cell *= 2;
  }
  const x0 = Math.floor(west / cell), y0 = Math.floor(south / cell), cells = cols * rows;
  const start = new Uint32Array(cells + 1);
  let edges = null, cursor = null;
  // Two passes over the same cells: count, then fill.
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 0; i < m; i++) {
      const a = edgeFrom[i], b = edgeTo[i];
      const ya = Math.floor(Math.min(lat[a], lat[b]) / cell) - y0, yb = Math.floor(Math.max(lat[a], lat[b]) / cell) - y0;
      const xa = Math.floor(Math.min(lon[a], lon[b]) / cell) - x0, xb = Math.floor(Math.max(lon[a], lon[b]) / cell) - x0;
      for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
        const c = y * cols + x;
        if (pass) edges[cursor[c]++] = i; else start[c + 1]++;
      }
    }
    if (!pass) {
      for (let c = 0; c < cells; c++) start[c + 1] += start[c];
      edges = new Uint32Array(start[cells]); cursor = start.slice(0, cells);
    }
  }
  g.grid = { cell, cols, rows, x0, y0, start, edges };
}
async function load() {
  if (!graphPromise) graphPromise = (async () => {
    const read = async url => {
      // Site paths such as '/road-graph.json' are read next to this worker, wherever the site is served from.
      const response = await fetch(new URL(url.replace(/^\//, ''), self.location.href));
      if (!response.ok) throw Error('Не удалось загрузить данные дорог. Повторите попытку.');
      return response.json();
    };
    const spec = await read('/road-graph.json');
    let nodeParts, edgeParts;
    if (spec.nodes_files) {
      const files = [...spec.nodes_files, ...spec.edges_files], nodeFiles = spec.nodes_files.length, parts = new Array(files.length);
      let next = 0, done = 0;
      self.postMessage({ progress: 0 });
      // A few downloads at a time: far quicker than one by one on a phone connection. Each file is
      // packed into typed arrays as soon as it arrives, so its JSON never waits for the others.
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < files.length) {
          const index = next++, rows = await read(files[index]);
          parts[index] = index < nodeFiles ? packNodes(rows) : packEdges(rows);
          self.postMessage({ progress: 0.9 * ++done / files.length });
        }
      }));
      nodeParts = parts.slice(0, nodeFiles); edgeParts = parts.slice(nodeFiles);
    } else { nodeParts = [packNodes(spec.nodes)]; edgeParts = [packEdges(spec.edges)]; }
    const g = { lat: concat(nodeParts, 'lat', Float64Array), lon: concat(nodeParts, 'lon', Float64Array) };
    g.edgeFrom = concat(edgeParts, 'from', Uint32Array); g.edgeTo = concat(edgeParts, 'to', Uint32Array); g.edgeFlags = concat(edgeParts, 'flags', Uint16Array);
    nodeParts = edgeParts = null;
    const { lat, lon, edgeFrom, edgeTo } = g, m = edgeFrom.length, length = g.edgeLength = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      // Great-circle metres, as R.distance, without an array per edge.
      const a = edgeFrom[i], b = edgeTo[i], dLat = (lat[b] - lat[a]) * RAD, dLon = (lon[b] - lon[a]) * RAD;
      const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat[a] * RAD) * Math.cos(lat[b] * RAD) * Math.sin(dLon / 2) ** 2;
      length[i] = 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, h)));
    }
    g.hasClasses = (spec.modes ?? 0) >= 2;
    g.networks = {};
    buildGrid(g);
    self.postMessage({ progress: 1 });
    return g;
  })().catch(error => { graphPromise = null; throw error; });
  return graphPromise;
}

/** The part of the graph one way of travel may use, built the first time it is asked for: arcs with
    their costs, how many usable edges meet at each node, and which pieces of the network connect. */
function network(g, name) {
  const mode = NETWORKS[name] ? name : 'car';
  if (g.networks[mode]) return g.networks[mode];
  const rule = NETWORKS[mode], n = g.lat.length, m = g.edgeFrom.length;
  const degree = new Uint32Array(n), links = new Uint8Array(n), comp = new Int32Array(n).fill(-1);
  // Union-find: a root holds minus the size of its piece, every other node a node closer to the root.
  const find = x => { let r = x; while (comp[r] >= 0) r = comp[r]; while (comp[x] >= 0 && comp[x] !== r) { const up = comp[x]; comp[x] = r; x = up; } return r; };
  for (let i = 0; i < m; i++) {
    const flags = g.edgeFlags[i];
    if (flags & rule.closed) continue;
    const a = g.edgeFrom[i], b = g.edgeTo[i];
    degree[a]++; if (!(flags & rule.oneway)) degree[b]++;
    if (links[a] < 255) links[a]++; if (links[b] < 255) links[b]++;
    let ra = find(a), rb = find(b);
    if (ra !== rb) { if (comp[ra] > comp[rb]) { const t = ra; ra = rb; rb = t; } comp[ra] += comp[rb]; comp[rb] = ra; }
  }
  let main = 0;
  for (let i = 0; i < n; i++) { if (comp[i] >= 0) comp[i] = find(i); else if (comp[i] < comp[main] || comp[main] >= 0) main = i; }
  const offset = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + degree[i];
  const to = new Uint32Array(offset[n]), weight = new Float32Array(offset[n]), cursor = offset.slice(0, n);
  let minRate = Infinity;
  for (let i = 0; i < m; i++) {
    const flags = g.edgeFlags[i];
    if (flags & rule.closed) continue;
    const a = g.edgeFrom[i], b = g.edgeTo[i], d = g.edgeLength[i], w = R.edgeCost(mode, flags, d);
    if (d > 0 && w / d < minRate) minRate = w / d;
    let j = cursor[a]++; to[j] = b; weight[j] = w;
    if (!(flags & rule.oneway)) { j = cursor[b]++; to[j] = a; weight[j] = w; }
  }
  if (!Number.isFinite(minRate)) minRate = R.MIN_COST_PER_METRE[mode];
  // A phone keeps two networks at most.
  const built = Object.keys(g.networks);
  if (built.length >= 2) delete g.networks[built[0]];
  return g.networks[mode] = { mode, rule, offset, to, weight, links, comp, main, minRate };
}
const pieceOf = (net, i) => net.comp[i] < 0 ? i : net.comp[i];
const pieceSize = (net, root) => -net.comp[root];

/** Where a point joins the network: the nearest point on an edge the mode may use, ranked by the
    snapping rules (main roads a little preferred, paths and tracks only when nothing better is
    close). `piece` limits it to one connected piece of the network. Null beyond MAX_GAP. */
function snapEdge(g, net, p, heading = null, piece = -1) {
  const { lat, lon, edgeFrom, edgeTo, edgeFlags, edgeLength } = g, { cell, cols, rows, x0, y0, start, edges } = g.grid;
  const mode = net.mode, rule = net.rule, kx = KLAT * Math.max(0.01, Math.cos(p[0] * RAD));
  const scan = radius => {
    const dLat = radius / KLAT, dLon = radius / kx, candidates = [];
    const ya = Math.max(0, Math.floor((p[0] - dLat) / cell) - y0), yb = Math.min(rows - 1, Math.floor((p[0] + dLat) / cell) - y0);
    const xa = Math.max(0, Math.floor((p[1] - dLon) / cell) - x0), xb = Math.min(cols - 1, Math.floor((p[1] + dLon) / cell) - x0);
    let best = null;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) {
      const c = y * cols + x;
      for (let k = start[c]; k < start[c + 1]; k++) {
        const e = edges[k], flags = edgeFlags[e];
        if (flags & rule.closed) continue;
        const u = edgeFrom[e], v = edgeTo[e];
        if (piece >= 0 && pieceOf(net, u) !== piece) continue;
        const ax = (lon[u] - p[1]) * kx, ay = (lat[u] - p[0]) * KLAT, dx = (lon[v] - lon[u]) * kx, dy = (lat[v] - lat[u]) * KLAT;
        const L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
        const gap = Math.hypot(ax + t * dx, ay + t * dy);
        if (gap > radius) continue;
        let score = R.snapScore(mode, flags, gap);
        // After leaving the route, prefer the road the traveller is heading along.
        if (heading !== null && gap <= 30 && L) {
          const cos = Math.cos((heading - Math.atan2(dx, dy) / RAD) * RAD);
          score += 20 * (1 - (flags & rule.oneway ? cos : Math.abs(cos)));
        }
        const candidate = { e, flags, gap, score, t, u, v };
        candidates.push(candidate);
        if (!best || score < best.score) best = candidate;
      }
    }
    const chosen = R.chooseSnap(candidates);
    // Anything not scanned is further than `radius`, so it cannot beat what was found here once
    // `radius` reaches `enough`: past it every score is worse, and every road that could replace a
    // path, steps or a track was seen.
    const enough = best ? Math.max(best.score / R.minSnapFactor(mode), R.weakSnap(best.flags) ? R.snapReach(best.gap) : 0) : Infinity;
    return { chosen, sure: enough <= radius, enough };
  };
  // Wider only as far as needed: a scan of the full 1.5 km reads thousands of city edges.
  let radius = NEAR_SCAN, found = scan(radius);
  while (!found.sure && radius < MAX_GAP) found = scan(radius = Math.min(MAX_GAP, Math.max(found.enough, 2 * radius)));
  const c = found.chosen;
  if (!c) return null;
  const length = edgeLength[c.e], point = c.t <= 0 ? [lat[c.u], lon[c.u]] : c.t >= 1 ? [lat[c.v], lon[c.v]]
    : [lat[c.u] + (lat[c.v] - lat[c.u]) * c.t, lon[c.u] + (lon[c.v] - lon[c.u]) * c.t];
  return {
    edge: c.e, u: c.u, v: c.v, t: c.t, point, gap: c.gap, flags: c.flags, length,
    oneway: !!(c.flags & rule.oneway), cost: R.edgeCost(mode, c.flags, length),
    // Within a metre of an end the point is that node: it may start or finish there in any direction.
    atU: c.t * length < 1, atV: (1 - c.t) * length < 1,
  };
}

function scratch(g) {
  const n = g.lat.length;
  if (!g.scratch || g.scratch.scores.length !== n) g.scratch = { scores: new Float64Array(n), previous: new Int32Array(n), closed: new Uint8Array(n), heap: new Heap() };
  return g.scratch;
}
/** Signed turn at node a coming from `from` and leaving for b, degrees, positive to the right. */
function turnAt(g, from, a, b) {
  const { lat, lon } = g, cos = Math.cos(lat[a] * RAD);
  const ix = (lon[a] - lon[from]) * cos, iy = lat[a] - lat[from], ox = (lon[b] - lon[a]) * cos, oy = lat[b] - lat[a];
  return -Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy) / RAD;
}
/** What a turn costs at `a`: nothing along a road, the rules' price at a junction, and a
    reversal only where the road ends. */
function turnCost(g, net, from, a, b) {
  if (from < 0 || b < 0) return 0;
  if (b === from) return R.turnCost(net.mode, 180, true);
  return net.links[a] >= 3 ? R.turnCost(net.mode, turnAt(g, from, a, b), true) : 0;
}
/** The node the start point lies beyond when a route leaves it through `node`, or -1 at a node. */
const startFrom = (S, node) => node === S.v ? (S.atV ? -1 : S.u) : (S.atU ? -1 : S.v);
/** The node the route heads for after reaching the target's edge at `node`, or -1 at a node. */
const endTowards = (T, node) => node === T.u ? (T.atU ? -1 : T.v) : (T.atV ? -1 : T.u);
const endPart = (T, node) => (node === T.u ? T.t : 1 - T.t) * T.cost;
const arcKey = (n, a, b) => a < b ? a * n + b : b * n + a;

/** A* from the start point to the target point, both lying on edges. Costs are the rules' edge
    costs (times penalties, for alternatives) plus turn costs. Returns {ids, cost} or null. */
async function search(g, net, S, T, check, penalties = null, cutoff = Infinity) {
  const { scores, previous, closed, heap } = scratch(g), n = g.lat.length;
  scores.fill(Infinity); previous.fill(-1); closed.fill(0); heap.size = 0;
  const { lat, lon } = g, { offset, to, weight, links } = net;
  const tLat = T.point[0], tLon = T.point[1];
  // Straight distance times the cheapest cost of a metre never overestimates; long trips accept
  // a route at most a fifth dearer to settle far fewer nodes.
  const rate = net.minRate * 0.999 * (R.distance(S.point, T.point) > 50000 ? 1.2 : 1);
  const h = i => {
    const dy = (lat[i] - tLat) * KLAT, dx = (lon[i] - tLon) * KLAT * Math.cos((lat[i] + tLat) * 0.5 * RAD);
    return Math.sqrt(dx * dx + dy * dy) * rate;
  };
  const seeds = new Map();
  const seed = (node, cost) => { if (cost < scores[node]) { scores[node] = cost; seeds.set(node, startFrom(S, node)); heap.push(cost + h(node), node); } };
  seed(S.v, (1 - S.t) * S.cost);
  if (!S.oneway || S.atU) seed(S.u, S.t * S.cost);
  let bestT = Infinity, end = -1, count = 0;
  if (S.edge === T.edge && (!S.oneway || T.t >= S.t)) { bestT = Math.abs(T.t - S.t) * S.cost; end = -2; }
  const intoV = !T.oneway || T.atV;
  while (heap.size) {
    const priority = heap.prio[0], a = heap.pop();
    if (priority >= bestT || priority > cutoff) break;
    if (closed[a]) continue;
    closed[a] = 1;
    const from = previous[a] >= 0 ? previous[a] : seeds.get(a) ?? -1;
    if (a === T.u) { const c = scores[a] + turnCost(g, net, from, a, endTowards(T, a)) + endPart(T, a); if (c < bestT) { bestT = c; end = a; } }
    if (a === T.v && intoV) { const c = scores[a] + turnCost(g, net, from, a, endTowards(T, a)) + endPart(T, a); if (c < bestT) { bestT = c; end = a; } }
    const junction = from >= 0 && links[a] >= 3;
    for (let j = offset[a], last = offset[a + 1]; j < last; j++) {
      const b = to[j];
      if (closed[b]) continue;
      let w = weight[j];
      if (penalties !== null) { const f = penalties.get(arcKey(n, a, b)); if (f !== undefined) w *= f; }
      // Turning back is only for the end of a road.
      if (b === from) { if (links[a] > 1) continue; w += R.turnCost(net.mode, 180, true); }
      else if (junction) w += R.turnCost(net.mode, turnAt(g, from, a, b), true);
      const score = scores[a] + w;
      if (score < scores[b]) {
        const p = score + h(b);
        if (p >= bestT || p > cutoff) continue;
        scores[b] = score; previous[b] = a; heap.push(p, b);
      }
    }
    if (++count % 8192 === 0) { await pause(); check(); }
  }
  check();
  if (end === -1 || bestT > cutoff) return null;
  const ids = [];
  if (end >= 0) { for (let a = end; a !== -1; a = previous[a]) ids.push(a); ids.reverse(); }
  return { ids, cost: bestT, settled: count };
}
/** The cheapest arc a -> b in the network. */
function arcWeight(net, a, b) {
  let w = Infinity;
  for (let j = net.offset[a]; j < net.offset[a + 1]; j++) if (net.to[j] === b && net.weight[j] < w) w = net.weight[j];
  return w;
}
/** What a route really costs, without the penalties used to find alternatives. */
function trueCost(g, net, S, T, ids) {
  if (!ids.length) return Math.abs(T.t - S.t) * S.cost;
  let cost = (ids[0] === S.u ? S.t : 1 - S.t) * S.cost;
  for (let i = 0; i < ids.length; i++) {
    const a = ids[i], from = i ? ids[i - 1] : startFrom(S, a), next = i < ids.length - 1 ? ids[i + 1] : endTowards(T, a);
    cost += turnCost(g, net, from, a, next);
    if (i < ids.length - 1) cost += arcWeight(net, a, next);
  }
  return cost + endPart(T, ids[ids.length - 1]);
}
/** A found route as the planner draws it: from the start point along the roads to the target point. */
function finish(g, net, S, T, found) {
  const { ids } = found, n = g.lat.length;
  const points = [S.point, ...Array.from(ids, i => [g.lat[i], g.lon[i]]), T.point];
  const cum = new Float64Array(points.length);
  for (let i = 1; i < points.length; i++) cum[i] = cum[i - 1] + R.distance(points[i - 1], points[i]);
  // The start and end points are shared by every route; -1 and -2 name them for comparisons.
  const nodes = [-1, ...ids, -2];
  const path = [points[0]];
  for (let i = 1; i < points.length; i++) {
    if (R.distance(path[path.length - 1], points[i]) >= 0.5) path.push(points[i]);
    else if (i === points.length - 1 && path.length > 1) path[path.length - 1] = points[i];
  }
  let meters = 0;
  for (let i = 1; i < path.length; i++) meters += R.distance(path[i - 1], path[i]);
  // Metres by edge, to measure what two routes have in common. The pieces of the start and end
  // edges get keys of their own below zero.
  const edges = new Map();
  for (let i = 1; i < ids.length; i++) edges.set(arcKey(n, ids[i - 1], ids[i]), cum[i + 1] - cum[i]);
  if (ids.length) {
    edges.set(ids[0] === S.u ? -1 : -2, cum[1]);
    edges.set(ids[ids.length - 1] === T.u ? -3 : -4, cum[cum.length - 1] - cum[cum.length - 2]);
  } else edges.set(-5, cum[cum.length - 1]);
  const cost = trueCost(g, net, S, T, ids);
  return { ids: nodes, nodeIds: ids, cum, path, meters, edges, cost, turns: R.countTurns(path), settled: found.settled };
}
/** Metres of each road class along a route, for checks (request with debug: true). */
function classMetres(g, route, S, T) {
  const n = g.lat.length, wanted = new Map([...route.edges].filter(([key]) => key >= 0)), metres = new Array(16).fill(0);
  for (const [key, length] of route.edges) if (key < 0) metres[R.roadClass(key > -3 ? S.flags : T.flags)] += length;
  for (let i = 0; i < g.edgeFrom.length && wanted.size; i++) {
    const key = arcKey(n, g.edgeFrom[i], g.edgeTo[i]);
    if (wanted.has(key)) { metres[R.roadClass(g.edgeFlags[i])] += wanted.get(key); wanted.delete(key); }
  }
  return metres.map(Math.round);
}

self.onmessage = async ({ data }) => {
  // Warming only starts the download: it must not cancel a route already being built.
  if (data?.warm) { load().then(() => self.postMessage({ progress: 1 }), () => {}); return; }
  const request = ++generation;
  const check = () => { if (request !== generation) throw CANCELLED; };
  if (data?.cancel) return;
  try {
    if (!validPoint(data?.start) || !validPoint(data?.end)) throw Error('Укажите корректные координаты точек А и Б.');
    const requested = Number.isFinite(data.maxRoutes) ? Math.floor(data.maxRoutes) : 3;
    const maxRoutes = Math.min(3, Math.max(1, requested));
    const g = await load(); check();
    const net = network(g, data.network), mode = net.mode;
    const speed = Number.isFinite(data.speed) && data.speed > 0 ? data.speed : DEFAULT_SPEED_KMH;
    const heading = Number.isFinite(data.heading) ? data.heading : null;
    const farText = mode === 'foot' ? 'Рядом не найдена дорога или дорожка. Выберите другую точку.' : 'Рядом не найдена подходящая дорога. Выберите другую точку на дороге.';
    const snapStarted = Date.now();
    let S = snapEdge(g, net, data.start, heading), T = snapEdge(g, net, data.end);
    if (!S || !T) throw Error(farText);
    // An end on a small piece of road that leads nowhere (a yard, a park path) moves to the
    // network the other end is on, when that is close enough.
    if (pieceOf(net, S.u) !== pieceOf(net, T.u)) {
      const move = (P, point, h, piece) => { const Q = snapEdge(g, net, point, h, piece); return Q && Q.gap <= Math.max(300, 2 * P.gap) ? Q : null; };
      const pS = pieceOf(net, S.u), pT = pieceOf(net, T.u);
      let S2 = null, T2 = null;
      if (pieceSize(net, pS) >= pieceSize(net, pT)) T2 = move(T, data.end, null, pS); else S2 = move(S, data.start, heading, pT);
      if (!S2 && !T2) {
        if (pieceSize(net, pS) >= pieceSize(net, pT)) S2 = move(S, data.start, heading, pT); else T2 = move(T, data.end, null, pS);
      }
      if (!S2 && !T2 && pS !== net.main && pT !== net.main) {
        const S3 = move(S, data.start, heading, net.main), T3 = move(T, data.end, null, net.main);
        if (S3 && T3) { S2 = S3; T2 = T3; }
      }
      if (S2) S = S2; if (T2) T = T2;
    }
    const sameText = () => R.distance(data.start, data.end) <= 25
      ? 'Начало и конец маршрута совпадают. Выберите другую точку.'
      : 'Обе точки привязались к одному участку дороги. Уточните начало или конец маршрута.';
    if (S.edge === T.edge && Math.abs(T.t - S.t) * S.length < 25) throw Error(sameText());
    const noPath = 'Между точками не найден связный путь для выбранного способа передвижения.';
    if (pieceOf(net, S.u) !== pieceOf(net, T.u)) throw Error(noPath);
    const started = Date.now(), snapMs = started - snapStarted;
    const first = await search(g, net, S, T, check);
    if (!first) throw Error(noPath);
    const firstMs = Date.now() - started;
    const best = finish(g, net, S, T, first);
    if (best.path.length < 2) throw Error(sameText());
    const found = [best];
    // Alternatives: search again with the edges already offered made dearer, and keep only
    // routes that are really different and not much worse (route-rules.js ALT).
    if (maxRoutes > 1 && best.meters >= R.ALT.minBest[mode]) {
      const penalties = new Map();
      const dearer = route => { for (const key of route.edges.keys()) if (key >= 0) penalties.set(key, (penalties.get(key) ?? 1) * R.ALT.penaltyStep); };
      dearer(best);
      const seen = new Set([best.nodeIds.join()]);
      // How long the next search may take: the longest so far, and at first twice the first search,
      // since a search with penalties settles about twice as many nodes (1.7x Dushanbe to Khujand).
      let roundMs = 2 * firstMs;
      for (let round = 0; round < R.ALT.rounds && found.length < maxRoutes; round++) {
        // Start another search only if it should end in time, so a long trip on a slow phone
        // answers with the best route instead of waiting for alternatives it will not get.
        if (Date.now() - started + roundMs > R.ALT.budgetMs) break;
        await pause(); check();
        const roundStarted = Date.now();
        const raw = await search(g, net, S, T, check, penalties, best.cost * R.ALT.cutoff);
        roundMs = Math.max(roundMs, Date.now() - roundStarted);
        if (!raw) break;
        const candidate = finish(g, net, S, T, raw);
        dearer(candidate); dearer(best);
        const signature = raw.ids.join();
        if (seen.has(signature)) continue;
        seen.add(signature);
        if (candidate.path.length > 1 && R.acceptAlternative(mode, candidate, best, found).ok) found.push(candidate);
      }
    }
    found.sort((a, b) => a.cost - b.cost);
    const routes = found.map(route => ({
      path: route.path, meters: route.meters, turns: route.turns,
      // Driving time follows the roads' speeds and turns; buses and taxis scale it to their own pace.
      seconds: Math.round(mode === 'car' ? R.carSeconds(route.cost, route.meters) * DEFAULT_SPEED_KMH / speed : route.meters / (speed / 3.6)),
    }));
    check();
    const response = {
      id: data.id, routes, startGap: S.gap, endGap: T.gap, startPoint: S.point, endPoint: T.point,
      estimateSpeedKmh: speed, path: routes[0].path, meters: routes[0].meters,
    };
    if (data.debug) response.debug = { classes: g.hasClasses, settled: best.settled, snapMs, firstMs, ms: Date.now() - started, costs: found.map(route => route.cost), classMetres: found.map(route => classMetres(g, route, S, T)) };
    self.postMessage(response);
  } catch (error) {
    if (error === CANCELLED || request !== generation) return;
    self.postMessage({ id: data?.id, error: error.message || 'Не удалось построить маршрут.' });
  }
};
