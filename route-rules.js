/* Routing rules shared by the route worker and scripts/check-routing.mjs: what a metre of each kind
   of road costs, what a turn costs, which road a tapped point belongs to, and when a second route
   is a real alternative rather than a detour. Pure tables and functions only, no graph and no I/O.
   Loaded with importScripts('route-rules.js') next to the worker; sets self.RouteRules.

   Edge flags (graph-edges-N.json, third element):
     1 one-way for cars, 2 closed to cars, 4 closed to pedestrians, 8 closed to bicycles,
     16 one-way for bicycles, bits 5-8 road class (below), 512 unpaved, 1024 link road,
     2048 has a name or a number, 4096 crossing.
   Road classes: 0 unknown (graph built before classes), 1 motorway, 2 trunk, 3 primary, 4 secondary,
   5 tertiary, 6 unclassified, 7 residential, 8 living street, 9 service, 10 driveway or parking
   aisle, 11 footway or pedestrian street, 12 cycleway, 13 path, 14 steps, 15 track or bridleway. */
self.RouteRules = (() => {
  const RAD = Math.PI / 180, EARTH = 6371008.8;
  const roadClass = flags => (flags >> 5) & 15;
  const UNPAVED = 512, LINK = 1024, NAMED = 2048, CROSSING = 4096;

  /** Cost of a metre on foot and by bicycle, by class; 1 is a good paved street. */
  const FOOT_FACTOR = [1, 9, 1.15, 1, 1, 1, 1.1, 1.1, 1, 1.25, 1.4, 1, 1.05, 1.3, 1.3, 1.5];
  const BIKE_FACTOR = [1, 9, 1.3, 1.15, 1.05, 1, 1, 1, 1, 1.2, 1.4, 1.2, 0.9, 1.3, 9, 1.6];
  /** Typical car speed by class, km/h, without traffic. Class 0 keeps the old flat 35 km/h. */
  const CAR_KMH = [35, 90, 70, 55, 45, 40, 30, 25, 10, 15, 10, 10, 10, 10, 10, 10];
  /** Seconds a car route is charged for every metre on top of its driving time, so that a way much
      longer than the direct one is not chosen to save half a minute on faster roads. */
  const CAR_METRE_COST = 0.05;

  /** What travelling `metres` along an edge costs: metres of effort on foot and by bicycle; by car
      seconds of driving plus CAR_METRE_COST a metre (carSeconds takes that charge off again). */
  function edgeCost(mode, flags, metres) {
    const c = roadClass(flags), unpaved = flags & UNPAVED;
    if (mode === 'car') {
      let kmh = CAR_KMH[c];
      if (flags & LINK) kmh *= 0.8;
      if (unpaved) kmh = Math.max(8, kmh * 0.6);
      return metres / (kmh / 3.6) + CAR_METRE_COST * metres;
    }
    if (mode === 'bike') return metres * BIKE_FACTOR[c] * (unpaved && c >= 2 && c <= 13 ? 1.25 : 1);
    return metres * FOOT_FACTOR[c] * (unpaved && c >= 2 && c <= 12 ? 1.1 : 1);
  }
  /** Driving seconds of a car route that costs `cost` over `metres`: its cost without the metre charge. */
  const carSeconds = (cost, metres) => Math.max(0, cost - CAR_METRE_COST * metres);
  /** The least an edge can cost per metre of straight distance: the scale of the A* estimate (the
      worker uses the cheapest edge of its network and falls back on these). */
  const MIN_COST_PER_METRE = { foot: 1, bike: 0.9, car: 3.6 / 90 + CAR_METRE_COST };

  /** Cost of turning at a node by `signedDeg` (positive to the right). Only junctions cost anything:
      a bend in a single road is not a turn. Cars pay more for a left turn across the traffic. */
  function turnCost(mode, signedDeg, isJunction) {
    if (!isJunction) return 0;
    const a = Math.abs(signedDeg);
    if (a < 35) return 0;
    if (mode === 'car') return a < 120 ? (signedDeg > 0 ? 4 : 8) : a < 170 ? 15 : 45;
    if (mode === 'bike') return a < 120 ? 25 : 60;
    return a < 120 ? 20 : 50;
  }
  /** Compass bearing from a to b ([lat, lon]), degrees, on a local flat approximation. */
  const bearing = (a, b) => Math.atan2((b[1] - a[1]) * Math.cos(a[0] * RAD), b[0] - a[0]) / RAD;
  /** Signed turn from the heading `inDeg` to `outDeg`, in (-180, 180], positive to the right. */
  const turnAngle = (inDeg, outDeg) => ((outDeg - inDeg + 540) % 360) - 180;

  /** How readily a tapped point attaches to a road of each class: main roads a little more, paths,
      steps and tracks much less, footways never for a car. */
  const SNAP_FACTOR = {
    foot: [1, 9, 0.8, 0.8, 0.8, 0.8, 1, 1, 1, 1.2, 1.4, 1, 1, 1.5, 3, 2],
    bike: [1, 9, 0.8, 0.8, 0.8, 0.8, 1, 1, 1, 1.2, 1.4, 1.1, 1, 1.5, 9, 2],
    car: [1, 1.5, 0.8, 0.8, 0.8, 0.8, 1, 1, 1, 1.3, 1.6, 9, 9, 9, 9, 9],
  };
  const snapFactors = mode => SNAP_FACTOR[mode] ?? SNAP_FACTOR.car;
  function snapScore(mode, flags, gap) {
    return gap * snapFactors(mode)[roadClass(flags)] * (flags & NAMED ? 0.9 : 1) * (flags & CROSSING ? 3 : 1);
  }
  /** The smallest score a candidate `gap` metres away can have; lets the worker stop scanning early. */
  const minSnapFactor = mode => Math.min(...snapFactors(mode)) * 0.9;
  /** A path, steps, a track or a crossing is chosen only when no ordinary road is reasonably close. */
  const weakSnap = flags => roadClass(flags) >= 13 || !!(flags & CROSSING);
  /** How far an ordinary road may be and still win over a weak candidate `bestGap` metres away. */
  const snapReach = bestGap => Math.max(60, 3 * bestGap);
  /** Picks the snap among candidates {flags, gap, score}; score already includes any extra terms. */
  function chooseSnap(candidates) {
    let best = null;
    for (const c of candidates) if (!best || c.score < best.score) best = c;
    if (!best || !weakSnap(best.flags)) return best;
    const reach = snapReach(best.gap);
    let road = null;
    for (const c of candidates) if (!weakSnap(c.flags) && c.gap <= reach && (!road || c.score < road.score)) road = c;
    return road ?? best;
  }

  const ALT = {
    /** Shorter best routes get no alternatives at all, metres. */
    minBest: { foot: 2000, bike: 3000, car: 3000 },
    /** An alternative may cost at most this much more than the best route. */
    maxCost: { foot: 1.25, bike: 1.25, car: 1.30 },
    maxLength: 1.35,
    /** Share of an alternative's length it may have in common with any route already offered. */
    maxOverlap: 0.60,
    /** Somewhere it must run at least max(metres, share of the best length) away from each of them. */
    separation: { foot: [300, 0.20], bike: [300, 0.15], car: [400, 0.10] },
    /** No stretch of it may replace 100 m or more of the best route by a detour 1.4 times as long. */
    localStretch: 1.4, localMinPiece: 100,
    turnSlack: turns => 1.5 * turns + 3,
    penaltyStep: 1.5, rounds: 6, cutoff: 2.5,
    /** No alternative search is started that would, going by the searches so far, end after this
        many milliseconds from the first search: a phone answers a long trip with the best route. */
    budgetMs: 2000,
  };

  // ---- Geometry shared with lib/navigation.ts ----
  const longitudeDelta = d => ((d + 540) % 360) - 180;
  function distance(a, b) {
    const dLat = (b[0] - a[0]) * RAD, dLon = longitudeDelta(b[1] - a[1]) * RAD;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
  }
  function sphericalBearing(a, b) {
    const lon = longitudeDelta(b[1] - a[1]) * RAD;
    const y = Math.sin(lon) * Math.cos(b[0] * RAD);
    const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos(lon);
    return Math.atan2(y, x) / RAD;
  }
  function cumulative(path) {
    const cum = new Float64Array(path.length);
    for (let i = 1; i < path.length; i++) cum[i] = cum[i - 1] + distance(path[i - 1], path[i]);
    return cum;
  }
  function atDistance(path, cum, metres) {
    const target = Math.min(Math.max(metres, 0), cum[cum.length - 1]);
    let lo = 0, hi = path.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cum[mid] < target) lo = mid + 1; else hi = mid; }
    if (!lo) return path[0];
    const length = cum[lo] - cum[lo - 1], t = length ? (target - cum[lo - 1]) / length : 0, a = path[lo - 1], b = path[lo];
    return [a[0] + (b[0] - a[0]) * t, longitudeDelta(a[1] + longitudeDelta(b[1] - a[1]) * t)];
  }
  /** Number of turn prompts the planner will show: the peak detection of buildManeuvers in lib/navigation.ts. */
  function countTurns(path) {
    if (!path || path.length < 3) return 0;
    const cum = cumulative(path);
    if (cum[cum.length - 1] < 0.1) return 0;
    const peaks = [];
    for (let i = 1; i < path.length - 1; i++) {
      const metres = cum[i], before = atDistance(path, cum, metres - 20), after = atDistance(path, cum, metres + 20);
      if (distance(before, path[i]) < 3 || distance(path[i], after) < 3) continue;
      const angle = longitudeDelta(sphericalBearing(path[i], after) - sphericalBearing(before, path[i]));
      if (Math.abs(angle) < 38) continue;
      const previous = peaks[peaks.length - 1];
      if (previous && metres - previous.metres < 32 && Math.sign(previous.angle) === Math.sign(angle)) {
        if (Math.abs(angle) > Math.abs(previous.angle)) peaks[peaks.length - 1] = { metres, angle };
      } else peaks.push({ metres, angle });
    }
    return peaks.length;
  }

  /** How far path `a` gets from path `b` at most, metres, sampling `a` every 25 m. With `cap` the
      answer stops at cap: enough to know whether two routes ever part by that much. */
  function separation(a, b, cap = Infinity) {
    if (!a?.length || !b?.length) return 0;
    const lat0 = a[0][0], lon0 = a[0][1], ky = EARTH * RAD, kx = ky * Math.cos(lat0 * RAD);
    const X = p => (longitudeDelta(p[1] - lon0)) * kx, Y = p => (p[0] - lat0) * ky;
    const bx = b.map(X), by = b.map(Y);
    // A grid over the segments of b answers "nearest segment" without scanning all of them.
    let total = 0;
    for (let i = 1; i < b.length; i++) total += Math.hypot(bx[i] - bx[i - 1], by[i] - by[i - 1]);
    const size = Math.max(25, Math.min(2000, Number.isFinite(cap) ? cap / 2 : total / 64 || 25));
    const grid = new Map(), cellKey = (cx, cy) => cx * 1048576 + cy;
    const add = (cx, cy, s) => { const k = cellKey(cx, cy); let list = grid.get(k); if (!list) grid.set(k, list = []); list.push(s); };
    if (b.length === 1) add(Math.floor(bx[0] / size), Math.floor(by[0] / size), -1);
    for (let i = 1; i < b.length; i++) {
      const x0 = Math.floor(Math.min(bx[i - 1], bx[i]) / size), x1 = Math.floor(Math.max(bx[i - 1], bx[i]) / size);
      const y0 = Math.floor(Math.min(by[i - 1], by[i]) / size), y1 = Math.floor(Math.max(by[i - 1], by[i]) / size);
      for (let cx = x0; cx <= x1; cx++) for (let cy = y0; cy <= y1; cy++) add(cx, cy, i);
    }
    const segment = (px, py, i) => {
      if (i < 0) return Math.hypot(bx[0] - px, by[0] - py);
      const ax = bx[i - 1] - px, ay = by[i - 1] - py, dx = bx[i] - bx[i - 1], dy = by[i] - by[i - 1], L = dx * dx + dy * dy;
      const t = L ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L)) : 0;
      return Math.hypot(ax + t * dx, ay + t * dy);
    };
    // Nearest distance from (px, py) to b, but only as far as it matters: once it is known to be at
    // most `enough` the sample cannot raise the maximum, and past `cap` the exact value is not needed.
    const nearest = (px, py, enough) => {
      const cx = Math.floor(px / size), cy = Math.floor(py / size);
      let best = Infinity;
      for (let ring = 0; ring <= 4096; ring++) {
        for (let dx = -ring; dx <= ring; dx++) {
          const edge = Math.abs(dx) === ring;
          for (let dy = -ring; dy <= ring; dy += edge ? 1 : 2 * ring) {
            const list = grid.get(cellKey(cx + dx, cy + dy));
            if (list) for (const s of list) { const d = segment(px, py, s); if (d < best) best = d; }
          }
        }
        // Every segment not seen yet is at least ring * size away.
        const bound = ring * size;
        if (best <= enough || best <= bound) return best;
        if (bound >= cap) return cap;
      }
      return best;
    };
    let worst = 0;
    const visit = (px, py) => { const d = nearest(px, py, worst); if (d > worst) worst = d; return worst >= cap; };
    const ax = a.map(X), ay = a.map(Y);
    if (visit(ax[0], ay[0])) return cap;
    for (let i = 1; i < a.length; i++) {
      const length = Math.hypot(ax[i] - ax[i - 1], ay[i] - ay[i - 1]), steps = Math.ceil(length / 25);
      for (let k = 1; k <= steps; k++) {
        const t = k / steps;
        if (visit(ax[i - 1] + (ax[i] - ax[i - 1]) * t, ay[i - 1] + (ay[i] - ay[i - 1]) * t)) return cap;
      }
    }
    return Math.min(worst, cap);
  }

  /** Worst ratio between a stretch of the candidate that leaves the best route and the part of the
      best route it replaces. Stretches replacing less than ALT.localMinPiece metres are measured
      against that minimum, so a short bypass is fine but a long loop around a corner is not.
      candIds: node ids along the candidate (the start and end points share ids with the best route);
      candCum: metres from the start at each of them; bestIdToCum: Map of the best route's ids to its metres. */
  function localStretch(candIds, candCum, bestIdToCum) {
    let worst = 0, last = -1;
    for (let i = 0; i < candIds.length; i++) {
      if (!bestIdToCum.has(candIds[i])) continue;
      if (last >= 0 && i - last > 1) {
        const replaced = Math.abs(bestIdToCum.get(candIds[i]) - bestIdToCum.get(candIds[last]));
        const detour = candCum[i] - candCum[last];
        worst = Math.max(worst, detour / Math.max(replaced, ALT.localMinPiece));
      }
      last = i;
    }
    return worst;
  }

  /** Metres of `a` that run along edges also used by `b` (both carry edges: Map of edge key -> metres). */
  function shared(a, b) {
    let sum = 0;
    for (const [key, metres] of a.edges) if (b.edges.has(key)) sum += metres;
    return sum;
  }

  /** Whether `cand` is worth offering next to `best` and the routes already accepted (best included).
      Routes carry {cost, meters, path, edges, ids, cum, turns?}. */
  function acceptAlternative(mode, cand, best, accepted) {
    const reasons = [], m = ALT.maxCost[mode] ? mode : 'car';
    const costRatio = cand.cost / best.cost, lengthRatio = cand.meters / best.meters;
    if (!(costRatio <= ALT.maxCost[m])) reasons.push(`cost x${costRatio.toFixed(2)}`);
    if (!(lengthRatio <= ALT.maxLength)) reasons.push(`length x${lengthRatio.toFixed(2)}`);
    if (new Set(cand.ids).size !== cand.ids.length) reasons.push('loop');
    if (!reasons.length) {
      const bestTurns = best.turns ?? countTurns(best.path), turns = cand.turns ?? countTurns(cand.path);
      if (turns > ALT.turnSlack(bestTurns)) reasons.push(`turns ${turns} vs ${bestTurns}`);
    }
    if (!reasons.length) {
      const bestAt = new Map();
      for (let i = 0; i < best.ids.length; i++) bestAt.set(best.ids[i], best.cum[i]);
      const stretch = localStretch(cand.ids, cand.cum, bestAt);
      if (stretch > ALT.localStretch) reasons.push(`local detour x${stretch.toFixed(2)}`);
    }
    if (!reasons.length) {
      const [least, share] = ALT.separation[m], need = Math.max(least, share * best.meters);
      for (const route of accepted) {
        const overlap = shared(cand, route) / Math.max(1, cand.meters);
        if (overlap > ALT.maxOverlap) { reasons.push(`overlap ${overlap.toFixed(2)}`); break; }
        const apart = separation(cand.path, route.path, need);
        if (apart < need) { reasons.push(`separation ${Math.round(apart)} < ${Math.round(need)} m`); break; }
      }
    }
    return { ok: !reasons.length, reasons };
  }

  return {
    UNPAVED, LINK, NAMED, CROSSING, roadClass,
    FOOT_FACTOR, BIKE_FACTOR, CAR_KMH, CAR_METRE_COST, SNAP_FACTOR, MIN_COST_PER_METRE, ALT,
    edgeCost, carSeconds, turnCost, bearing, turnAngle, snapScore, minSnapFactor, weakSnap, snapReach, chooseSnap,
    distance, countTurns, separation, localStretch, shared, acceptAlternative,
  };
})();
