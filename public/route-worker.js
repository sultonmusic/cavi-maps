/* Local routing for driving, cycling and walking over one shared graph, each on the ways open to it.
   Times are estimates at the planner's speed for the mode, without traffic data. */
let graphPromise, generation = 0;
const DEFAULT_SPEED_KMH = 35, MAX_DETOUR_RATIO = 1.65, MAX_SHARED_RATIO = 0.85;
/* Edge flags: 1 one-way for motor vehicles, 2 closed to them, 4 closed to pedestrians, 8 closed to
   bicycles, 16 one-way for bicycles too. The older car-only graph used just 0 and 1. */
const NETWORKS = { car: { closed: 2, oneway: 1 }, bike: { closed: 8, oneway: 16 }, foot: { closed: 4, oneway: 0 } };
const CANCELLED = Symbol('cancelled');
const pause = () => new Promise(resolve => setTimeout(resolve, 0));
const distance = (a, b) => {
  const r = Math.PI / 180, dy = (b[0] - a[0]) * r, dx = (b[1] - a[1]) * r;
  const h = Math.min(1, Math.sin(dy / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dx / 2) ** 2);
  return 6371000 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
};
const validPoint = p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
const edgeKey = (a, b) => a < b ? `${a}:${b}` : `${b}:${a}`;
class Heap {
  a = [];
  push(p) {
    const a = this.a; let i = a.length; a.push(p);
    while (i) { const j = (i - 1) >> 1; if (a[j][0] <= p[0]) break; a[i] = a[j]; i = j; } a[i] = p;
  }
  pop() {
    const a = this.a, root = a[0], p = a.pop();
    if (a.length) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let j = i * 2 + 1; if (j + 1 < a.length && a[j + 1][0] < a[j][0]) j++;
        if (a[j][0] >= p[0]) break; a[i] = a[j]; i = j;
      } a[i] = p;
    } return root;
  }
}
async function load() {
  if (!graphPromise) graphPromise = (async () => {
    const read = async url => {
      // Site paths such as '/road-graph.json' are read next to this worker, wherever the site is served from.
      const response = await fetch(new URL(url.replace(/^\//, ''), self.location.href));
      if (!response.ok) throw Error('Не удалось загрузить данные дорог. Повторите попытку.');
      return response.json();
    };
    let g = await read('/road-graph.json');
    if (g.nodes_files) {
      const spec = g, files = [...spec.nodes_files, ...spec.edges_files], parts = new Array(files.length);
      let next = 0, done = 0;
      self.postMessage({ progress: 0 });
      // A few downloads at a time: far quicker than one by one on a phone connection,
      // without holding the text of every file in memory at once.
      await Promise.all(Array.from({ length: 4 }, async () => {
        while (next < files.length) {
          const index = next++;
          parts[index] = await read(files[index]);
          self.postMessage({ progress: 0.9 * ++done / files.length });
        }
      }));
      g = { nodes: parts.slice(0, spec.nodes_files.length).flat(), edges: parts.slice(spec.nodes_files.length).flat() };
    }
    // The edges stay as compact arrays; each way of travel builds its own adjacency from them.
    const n = g.nodes.length, m = g.edges.length;
    g.edgeFrom = new Uint32Array(m); g.edgeTo = new Uint32Array(m); g.edgeFlags = new Uint8Array(m); g.edgeLength = new Float32Array(m);
    g.edges.forEach(([a, b, flags], i) => { g.edgeFrom[i] = a; g.edgeTo[i] = b; g.edgeFlags[i] = flags; g.edgeLength[i] = distance(g.nodes[a], g.nodes[b]); });
    delete g.edges;
    g.networks = {};
    // A small geographic index makes GPS rerouting avoid scanning a million nodes.
    g.spatial = new Map();
    for (let i = 0; i < n; i++) {
      const p = g.nodes[i], key = `${Math.floor(p[0] / 0.02)}:${Math.floor(p[1] / 0.02)}`;
      let cell = g.spatial.get(key);
      if (!cell) { cell = []; g.spatial.set(key, cell); }
      cell.push(i);
    }
    self.postMessage({ progress: 1 });
    return g;
  })().catch(error => { graphPromise = null; throw error; });
  return graphPromise;
}
/** The part of the graph one way of travel may use, built the first time it is asked for. */
function network(g, name) {
  if (g.networks[name]) return g.networks[name];
  const rule = NETWORKS[name] ?? NETWORKS.car, n = g.nodes.length, m = g.edgeFrom.length;
  const degree = new Uint32Array(n), usable = new Uint8Array(n);
  for (let i = 0; i < m; i++) {
    const flags = g.edgeFlags[i];
    if (flags & rule.closed) continue;
    degree[g.edgeFrom[i]]++; usable[g.edgeFrom[i]] = 1; usable[g.edgeTo[i]] = 1;
    if (!(flags & rule.oneway)) degree[g.edgeTo[i]]++;
  }
  const offset = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) offset[i + 1] = offset[i] + degree[i];
  const to = new Uint32Array(offset[n]), weight = new Float32Array(offset[n]), cursor = offset.slice(0, n);
  for (let i = 0; i < m; i++) {
    const flags = g.edgeFlags[i];
    if (flags & rule.closed) continue;
    const a = g.edgeFrom[i], b = g.edgeTo[i], d = g.edgeLength[i];
    let j = cursor[a]++; to[j] = b; weight[j] = d;
    if (!(flags & rule.oneway)) { j = cursor[b]++; to[j] = a; weight[j] = d; }
  }
  // A phone keeps two networks at most.
  const built = Object.keys(g.networks);
  if (built.length >= 2) delete g.networks[built[0]];
  return g.networks[name] = { offset, to, weight, usable };
}
async function snap(g, net, p, check) {
  let best = -1, meters = Infinity;
  const dy = 1501 / 110500, dx = dy / Math.max(0.001, Math.abs(Math.cos(p[0] * Math.PI / 180)));
  for (let y = Math.floor((p[0] - dy) / 0.02); y <= Math.floor((p[0] + dy) / 0.02); y++) {
    for (let x = Math.floor((p[1] - dx) / 0.02); x <= Math.floor((p[1] + dx) / 0.02); x++) {
      const cell = g.spatial.get(`${y}:${x}`);
      if (cell) for (const i of cell) {
        if (!net.usable[i]) continue;
        const d = distance(g.nodes[i], p); if (d < meters) { best = i; meters = d; }
      }
    }
  }
  check(); return [best, meters];
}
function routeEdges(g, route) {
  const edges = new Map();
  for (let i = 1; i < route.ids.length; i++) {
    const a = route.ids[i - 1], b = route.ids[i]; edges.set(edgeKey(a, b), distance(g.nodes[a], g.nodes[b]));
  } return edges;
}
async function search(g, net, start, target, scratch, check, penalties = null, multiplier = 1, cutoff = Infinity) {
  const { scores, previous, closed } = scratch;
  scores.fill(Infinity); previous.fill(-1); closed.fill(0); scores[start] = 0;
  const heap = new Heap(); heap.push([distance(g.nodes[start], g.nodes[target]) * 0.999999, start]);
  let count = 0, reached = false;
  while (heap.a.length) {
    const [priority, a] = heap.pop(); if (priority > cutoff) break;
    if (closed[a]) continue; closed[a] = 1;
    if (a === target) { reached = true; break; }
    for (let j = net.offset[a]; j < net.offset[a + 1]; j++) {
      const b = net.to[j]; if (closed[b]) continue;
      const penalized = penalties && penalties.has(edgeKey(a, b));
      const score = scores[a] + net.weight[j] * (penalized ? multiplier : 1);
      if (score < scores[b] && score <= cutoff) {
        scores[b] = score; previous[b] = a;
        heap.push([score + distance(g.nodes[b], g.nodes[target]) * 0.999999, b]);
      }
    }
    if (++count % 8192 === 0) { await pause(); check(); }
  }
  check(); if (!reached) return null;
  const ids = []; let a = target;
  while (a !== -1) { ids.push(a); if (a === start) break; a = previous[a]; } ids.reverse();
  let meters = 0;
  for (let i = 1; i < ids.length; i++) meters += distance(g.nodes[ids[i - 1]], g.nodes[ids[i]]);
  const route = { ids, meters }; route.edges = routeEdges(g, route); return route;
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
    const net = network(g, data.network), speed = Number.isFinite(data.speed) && data.speed > 0 ? data.speed : DEFAULT_SPEED_KMH;
    const [start, startGap] = await snap(g, net, data.start, check), [target, endGap] = await snap(g, net, data.end, check);
    if (start < 0 || target < 0 || startGap > 1500 || endGap > 1500) throw Error(data.network === 'foot' ? 'Рядом не найдена дорога или дорожка. Выберите другую точку.' : 'Рядом не найдена подходящая дорога. Выберите другую точку на дороге.');
    if (start === target) throw Error(distance(data.start, data.end) <= 25
      ? 'Начало и конец маршрута совпадают. Выберите другую точку.'
      : 'Обе точки привязались к одному участку дороги. Уточните начало или конец маршрута.');
    const scratch = { scores: new Float64Array(g.nodes.length), previous: new Int32Array(g.nodes.length), closed: new Uint8Array(g.nodes.length) };
    const best = await search(g, net, start, target, scratch, check);
    if (!best) throw Error('Между точками не найден связный автомобильный путь. Выберите другое начало маршрута.');
    const found = [best], penalties = new Set(best.edges.keys());
    // Bounded searches; only actual graph paths with >=15% different road length survive.
    for (const multiplier of [2.5, 4, 6, 10, 16, 24]) {
      if (found.length >= maxRoutes) break;
      await pause(); check();
      const candidate = await search(g, net, start, target, scratch, check, penalties, multiplier, best.meters * multiplier * MAX_DETOUR_RATIO);
      if (!candidate) continue;
      for (const key of candidate.edges.keys()) penalties.add(key);
      if (candidate.meters > best.meters * MAX_DETOUR_RATIO) continue;
      const distinct = found.every(existing => {
        let shared = 0;
        for (const [key, meters] of candidate.edges) if (existing.edges.has(key)) shared += meters;
        return shared / Math.min(existing.meters, candidate.meters) < MAX_SHARED_RATIO;
      });
      if (distinct) found.push(candidate);
    }
    found.sort((a, b) => a.meters - b.meters);
    const routes = found.map(route => ({ path: route.ids.map(id => g.nodes[id]), meters: route.meters, seconds: Math.round(route.meters / (speed / 3.6)) }));
    check();
    self.postMessage({ id: data.id, routes, startGap, endGap, estimateSpeedKmh: speed, path: routes[0].path, meters: routes[0].meters });
  } catch (error) {
    if (error === CANCELLED || request !== generation) return;
    self.postMessage({ id: data?.id, error: error.message || 'Не удалось построить маршрут.' });
  }
};
