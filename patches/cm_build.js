/* ---- Cavi Maps road geometry (Yandex-style junctions and lane arrows) ---- */
var CmLane = 3.4;
function CmKey(p) { return p[0].toFixed(6) + ',' + p[1].toFixed(6); }
function CmToM(o, p) { return [(p[0] - o[0]) * 111320 * Math.cos(o[1] * Math.PI / 180), (p[1] - o[1]) * 111320]; }
function CmFromM(o, v) { return [o[0] + v[0] / (111320 * Math.cos(o[1] * Math.PI / 180)), o[1] + v[1] / 111320]; }
function CmUnit(v) { var l = Math.hypot(v[0], v[1]); return l ? [v[0] / l, v[1] / l] : [0, 0]; }
/* Unit direction leaving the given end (0 = start, 1 = end) into the line, sampled ~d metres in. */
function CmLeave(c, end, d) {
  d = d || 12;
  var pts = end ? c.slice().reverse() : c, o = pts[0], acc = 0;
  for (var i = 1; i < pts.length; i++) {
    var s = CmToM(pts[i - 1], pts[i]), l = Math.hypot(s[0], s[1]);
    if (acc + l >= d || i === pts.length - 1) return CmUnit(CmToM(o, pts[i]));
    acc += l;
  }
  return [0, 0];
}
function CmLen(c) { var t = 0; for (var i = 1; i < c.length; i++) { var s = CmToM(c[i - 1], c[i]); t += Math.hypot(s[0], s[1]); } return t; }
/* Part of a line between a and b metres from its start. */
function CmSub(c, a, b) {
  var out = [], acc = 0;
  for (var i = 1; i < c.length; i++) {
    var s = CmToM(c[i - 1], c[i]), l = Math.hypot(s[0], s[1]);
    if (!l) continue;
    var at = function (m) { var f = (m - acc) / l; return [c[i - 1][0] + (c[i][0] - c[i - 1][0]) * f, c[i - 1][1] + (c[i][1] - c[i - 1][1]) * f]; };
    if (!out.length && acc + l >= a) out.push(at(Math.max(a, acc)));
    if (out.length && acc + l >= b) { out.push(at(b)); return out; }
    if (out.length) out.push(c[i]);
    acc += l;
  }
  return out;
}
/* Line shifted sideways by off metres (positive = right of travel direction). */
function CmOff(c, off) {
  if (!off) return c.map(function (p) { return [p[0], p[1]]; });
  var n = [];
  for (var i = 1; i < c.length; i++) { var d = CmUnit(CmToM(c[i - 1], c[i])); n.push([d[1], -d[0]]); }
  return c.map(function (p, i) {
    var a = n[Math.max(0, i - 1)], b = n[Math.min(n.length - 1, i)], m = [a[0] + b[0], a[1] + b[1]], k = a[0] * m[0] + a[1] * m[1];
    var s = k > 1e-6 ? Math.min(2, 1 / k) : 1;
    return CmFromM(p, [m[0] * s * off, m[1] * s * off]);
  });
}
function CmDisc(o, r) {
  var ring = [];
  for (var i = 0; i < 16; i++) { var a = i / 16 * Math.PI * 2; ring.push(CmFromM(o, [Math.cos(a) * r, Math.sin(a) * r])); }
  ring.push(ring[0]);
  return ring;
}
/* Arrow code for every lane (index 0 = leftmost) from the manoeuvres possible at the end of a road. */
function CmLaneCodes(n, S) {
  var s = S.has('s'), r = S.has('r'), l = S.has('l'), out = [];
  for (var i = 0; i < n; i++) out.push('s');
  if (!s && !r && !l) return out;
  if (n === 1) return [(s ? 's' : '') + (l ? 'l' : '') + (r ? 'r' : '')];
  if (s) { if (l) out[0] = n >= 3 ? 'l' : 'sl'; if (r) out[n - 1] = n >= 3 ? 'r' : 'sr'; return out; }
  if (l && r) { for (var j = 0; j < n; j++) out[j] = j < (n - 1) / 2 ? 'l' : j > (n - 1) / 2 ? 'r' : 'lr'; return out; }
  return out.map(function () { return l ? 'l' : 'r'; });
}
function CmBuild(roads, dashes) {
  var F = function (kind, props, g) { return { type: 'Feature', properties: props, geometry: { type: kind, coordinates: g } }; };
  /* 1. stitch consecutive ways of one road into long lines, so bends are line joins, not caps */
  var ch = [];
  roads.forEach(function (r) {
    var c = (r.coordinates || []).filter(function (p, i, a) { return i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]; });
    if (c.length > 1) ch.push({ id: r.id, asphalt: r.asphalt, ow: !!r.oneway, w: Ef(r.asphalt, !!r.oneway), c: c.map(function (p) { return [p[0], p[1]]; }) });
  });
  var inner = new Map(), E = new Map();
  ch.forEach(function (x) {
    for (var i = 1; i < x.c.length - 1; i++) { var k = CmKey(x.c[i]); inner.set(k, (inner.get(k) || 0) + 1); }
    x.k0 = CmKey(x.c[0]); x.k1 = CmKey(x.c[x.c.length - 1]);
    [x.k0, x.k1].forEach(function (k) { var a = E.get(k); a ? a.push(x) : E.set(k, [x]); });
  });
  var rev = function (x) { x.c.reverse(); var t = x.k0; x.k0 = x.k1; x.k1 = t; };
  Array.from(E.entries()).forEach(function (en) {
    var k = en[0], a = en[1];
    if (a.length !== 2 || inner.has(k)) return;
    var A = a[0], B = a[1];
    if (A === B || A.dead || B.dead || A.w !== B.w || A.ow !== B.ow) return;
    if (A.ow) { if (A.k1 !== k) { var t = A; A = B; B = t; } if (A.k1 !== k || B.k0 !== k) return; }
    else { if (A.k1 !== k) rev(A); if (B.k0 !== k) rev(B); if (A.k1 !== k || B.k0 !== k) return; }
    var da = CmLeave(A.c, 1), db = CmLeave(B.c, 0);
    if (da[0] * db[0] + da[1] * db[1] > 0.5) return; /* hairpin: keep apart */
    var N = { id: A.id, asphalt: A.asphalt, ow: A.ow, w: A.w, c: A.c.concat(B.c.slice(1)), k0: A.k0, k1: B.k1 };
    A.dead = B.dead = true; E.delete(k);
    [[N.k0, A], [N.k1, B]].forEach(function (q) { var arr = E.get(q[0]); if (arr) for (var i = 0; i < arr.length; i++) if (arr[i] === q[1]) arr[i] = N; });
    ch.push(N);
  });
  ch = ch.filter(function (x) { return !x.dead; });
  /* 2. topology of the stitched network */
  var ends = new Map(), inn = new Map(), node = new Map();
  ch.forEach(function (x) {
    x.k0 = CmKey(x.c[0]); x.k1 = CmKey(x.c[x.c.length - 1]); x.lanes = Math.max(1, x.asphalt | 0);
    [[0, x.k0, x.c[0]], [1, x.k1, x.c[x.c.length - 1]]].forEach(function (q) { var a = ends.get(q[1]); a ? a.push([x, q[0]]) : ends.set(q[1], [[x, q[0]]]); node.set(q[1], q[2]); });
    for (var i = 1; i < x.c.length - 1; i++) { var k = CmKey(x.c[i]), a = inn.get(k); a ? a.push([x, i]) : inn.set(k, [[x, i]]); node.set(k, x.c[i]); }
  });
  var halves = function (k, self) {
    var h = [];
    (ends.get(k) || []).forEach(function (q) { if (q[0] !== self) h.push(q[0].w / 2); });
    (inn.get(k) || []).forEach(function (q) { if (q[0] !== self) h.push(q[0].w / 2); });
    return h;
  };
  /* forks: every road at the node leaves into one narrow cone (ramps splitting off a street) */
  var cone = Math.cos(40 * Math.PI / 180), fork = new Set();
  ends.forEach(function (a, k) {
    if (a.length < 2 || inn.has(k)) return;
    var ds = a.map(function (q) { return CmLeave(q[0].c, q[1], 15); });
    var m = CmUnit(ds.reduce(function (s, d) { return [s[0] + d[0], s[1] + d[1]]; }, [0, 0]));
    if ((m[0] || m[1]) && ds.every(function (d) { return d[0] * m[0] + d[1] * m[1] >= cone; })) fork.add(k);
  });
  /* 3. which manoeuvres are possible at the end of each road, per travel direction
     (at a fork the only way on is the street the ramps join, so the arrows stay straight) */
  var turnsAt = function (x, e) {
    var k = e ? x.k1 : x.k0, h = CmLeave(x.c, e), S = new Set();
    if (fork.has(k)) return S;
    h = [-h[0], -h[1]];
    var add = function (d) {
      if (!d[0] && !d[1]) return;
      var t = -Math.atan2(h[0] * d[1] - h[1] * d[0], h[0] * d[0] + h[1] * d[1]) * 180 / Math.PI;
      if (Math.abs(t) < 35) S.add('s'); else if (t >= 35 && t <= 130) S.add('r'); else if (t <= -35 && t >= -130) S.add('l');
    };
    (ends.get(k) || []).forEach(function (q) { if ((q[0] === x && q[1] === e) || (q[0].ow && q[1] !== 0)) return; add(CmLeave(q[0].c, q[1])); });
    (inn.get(k) || []).forEach(function (q) { add(CmLeave(q[0].c.slice(q[1]), 0)); if (!q[0].ow) add(CmLeave(q[0].c.slice(0, q[1] + 1), 1)); });
    return S;
  };
  ch.forEach(function (x) { x.fw = CmLaneCodes(x.lanes, turnsAt(x, 1)); if (!x.ow) x.bw = CmLaneCodes(x.lanes, turnsAt(x, 0)); });
  var surf = [];
  /* 4a. forks: roads leaving one node side by side start next to each other across the road width */
  var fanned = new Set();
  ends.forEach(function (a, k) {
    if (!fork.has(k)) return;
    var o = node.get(k), ds = a.map(function (q) { return CmLeave(q[0].c, q[1], 15); });
    var m = CmUnit(ds.reduce(function (s, d) { return [s[0] + d[0], s[1] + d[1]]; }, [0, 0]));
    var nr = [m[1], -m[0]];
    var items = a.map(function (q, i) { return { x: q[0], e: q[1], s: ds[i][0] * nr[0] + ds[i][1] * nr[1] }; }).sort(function (p, q) { return p.s - q.s; });
    var tot = items.reduce(function (s, p) { return s + p.x.w; }, 0);
    /* branches emerge from within the width of the road they leave (about two lanes), then spread */
    var span = Math.max(Math.max.apply(null, items.map(function (p) { return p.x.w; })), Math.min(tot, 8.5)), sc = span / tot, cum = -span / 2;
    items.forEach(function (p) {
      var off = cum + p.x.w * sc / 2; cum += p.x.w * sc;
      p.x.c[p.e ? p.x.c.length - 1 : 0] = CmFromM(o, [nr[0] * off, nr[1] * off]);
    });
    fanned.add(k);
  });
  /* 4b. slip roads branching off (or merging into) a wider road start at its edge, not its middle */
  inn.forEach(function (thr, k) {
    var here = ends.get(k);
    if (!here) return;
    var o = node.get(k);
    here.forEach(function (q) {
      var x = q[0], e = q[1], d = CmLeave(x.c, e, 15), best = null;
      thr.forEach(function (t) {
        var y = t[0];
        if (y === x || y.w <= x.w + 0.5) return;
        var f = CmLeave(y.c.slice(t[1]), 0), c = Math.abs(d[0] * f[0] + d[1] * f[1]);
        if (c > Math.cos(40 * Math.PI / 180) && (!best || y.w > best.y.w)) best = { y: y, f: f };
      });
      if (!best) return;
      var nr = [best.f[1], -best.f[0]], side = d[0] * nr[0] + d[1] * nr[1] >= 0 ? 1 : -1, off = side * (best.y.w - x.w) / 2;
      x.c[e ? x.c.length - 1 : 0] = CmFromM(o, [nr[0] * off, nr[1] * off]);
      fanned.add(k + '#' + x.id);
    });
  });
  /* 4c. junction fill: flat (butt) road ends need the corner between them filled, sized so nothing sticks out */
  ends.forEach(function (a, k) {
    if (fanned.has(k)) return;
    var o = node.get(k);
    var hs = a.map(function (q) { return q[0].w / 2; }).concat((inn.get(k) || []).map(function (q) { return q[0].w / 2; })).sort(function (p, q) { return q - p; });
    if (hs.length >= 2) surf.push(F('Polygon', { kind: 'surface' }, [CmDisc(o, hs[1])]));
    /* width change where a road simply continues as a narrower one (other roads may meet there too): taper over ~25 m */
    for (var i = 0; i < a.length; i++) for (var j = i + 1; j < a.length; j++) {
      var A = a[i], B = a[j];
      if (A[0] === B[0] || A[0].w === B[0].w || A[0].ow !== B[0].ow || (A[0].ow && A[1] === B[1])) continue;
      var dA = CmLeave(A[0].c, A[1]), dB = CmLeave(B[0].c, B[1]);
      if (dA[0] * dB[0] + dA[1] * dB[1] > -0.85) continue;
      var W = A[0].w > B[0].w ? A : B, Nq = W === A ? B : A, n = Nq[0];
      var L = Math.min(25, CmLen(n.c) * 0.5), line = Nq[1] ? n.c.slice().reverse() : n.c, seg = CmSub(line, 0, L);
      if (seg.length < 2) continue;
      var P = seg[seg.length - 1], d = CmUnit(CmToM(o, P)), nr = [d[1], -d[0]], wa = W[0].w / 2, wb = n.w / 2;
      surf.push(F('Polygon', { kind: 'surface' }, [[CmFromM(o, [nr[0] * wa, nr[1] * wa]), CmFromM(P, [nr[0] * wb, nr[1] * wb]), CmFromM(P, [-nr[0] * wb, -nr[1] * wb]), CmFromM(o, [-nr[0] * wa, -nr[1] * wa]), CmFromM(o, [nr[0] * wa, nr[1] * wa])]]));
    }
  });
  /* 5. smooth, then emit surfaces, lane dashes and one arrow per lane */
  var fixed = function (p) { var k = CmKey(p); return (ends.get(k) || []).length + (inn.get(k) || []).length > 1; };
  var live = [], marks = [];
  ch.forEach(function (x) {
    var sc = CmS(x.c, fixed);
    live.push(F('LineString', { id: x.id, w: x.w, wc: Math.round(x.w * 10), ow: x.ow ? 1 : 0 }, sc));
    dashes({ asphalt: x.asphalt, oneway: x.ow, coordinates: sc }, function (p) { return Math.max.apply(null, [0].concat(halves(CmKey(p), x))); }).forEach(function (d) { marks.push(F('LineString', { kind: d.kind }, d.coordinates)); });
    [[sc, x.fw], [x.ow ? null : sc.slice().reverse(), x.bw]].forEach(function (dir) {
      var line = dir[0], codes = dir[1];
      if (!line || !codes) return;
      var total = CmLen(line), n = codes.length;
      if (total < 25) return;
      for (var i = 0; i < n; i++) {
        var off = x.ow ? (i + 0.5 - n / 2) * CmLane : (i + 0.5) * CmLane;
        var t = CmSub(line, Math.max(0, total - 40), total - 14);
        if (t.length > 1) marks.push(F('LineString', { kind: 'lane-turn', t: codes[i] }, CmOff(t, off)));
        if (total > 120) { var r = CmSub(line, 20, total - 60); if (r.length > 1) marks.push(F('LineString', { kind: 'lane-run', t: 's' }, CmOff(r, off))); }
      }
    });
  });
  return { live: live, asphalt: marks.concat(surf) };
}
/* Lane arrow icon: straight / left / right branches, pointing along +x (travel direction). */
function CmLaneIcon(code) {
  var W = 72, H = 52, cy = H / 2, cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  var g = cv.getContext('2d');
  if (!g) return null;
  g.strokeStyle = g.fillStyle = '#6f7589'; g.lineWidth = 4.5; g.lineCap = 'round'; g.lineJoin = 'round';
  var head = function (x, y, ang) {
    g.beginPath(); g.moveTo(x + Math.cos(ang) * 11, y + Math.sin(ang) * 11);
    g.lineTo(x + Math.cos(ang + 2.3) * 9, y + Math.sin(ang + 2.3) * 9);
    g.lineTo(x + Math.cos(ang - 2.3) * 9, y + Math.sin(ang - 2.3) * 9); g.closePath(); g.fill();
  };
  var s = code.indexOf('s') >= 0, l = code.indexOf('l') >= 0, r = code.indexOf('r') >= 0;
  var fork = s ? 30 : 38;
  g.beginPath(); g.moveTo(4, cy); g.lineTo(s ? W - 16 : fork, cy); g.stroke();
  if (s) head(W - 16, cy, 0);
  [[l, -1], [r, 1]].forEach(function (b) {
    if (!b[0]) return;
    var y1 = cy + b[1] * 15;
    g.beginPath(); g.moveTo(fork - 4, cy); g.quadraticCurveTo(fork + 8, cy, fork + 8, y1); g.stroke();
    head(fork + 8, y1, b[1] * Math.PI / 2);
  });
  return g.getImageData(0, 0, W, H);
}
/* Navigator: which lane to take before a turn. */
function CmLaneTip(kind, lanes, mode, metres) {
  if (!(lanes >= 2) || !(metres <= 700) || (Xf[mode] || 'car') !== 'car') return '';
  if (kind === 'right') return 'Займите правый ряд';
  if (kind === 'left' || kind === 'uturn') return 'Займите левый ряд';
  return '';
}

/* Road widths as zoom-only expressions, one layer per width class. A width that depends on both
   the feature and the zoom is baked per tile for the tile's own zoom and the next one only, so in
   a pitched (3D) view the lower-zoom tiles far away drew roads up to ~1.5x too narrow and the road
   seemed to jump in width at the tile edge. With the class in the filter, every tile draws the
   same width. */
var CmClasses = [34, 46, 68, 102, 136, 170, 204, 272, 340, 408];
function CmWz(m, casing) {
  var px = function (z) { return (m + (casing ? 1.4 : 0)) * Math.pow(2, z) / 61170; }, st = [];
  wf.forEach(function (q) { if (q[0] < 16) st.push(q[0], (casing ? Math.min(2.2, Math.max(0.5, q[1] * 0.3)) : 0) + q[1]); });
  st.push(16, Math.max(casing ? 9 : 7.3, px(16)), 17, Math.max(casing ? 11.5 : 9, px(17)), 18, Math.max(casing ? 14 : 11, px(18)), 22, px(22));
  return ['interpolate', ['exponential', 2], ['zoom']].concat(st);
}
function CmLiveLayers(casing) {
  var cap = ['step', ['zoom'], 'round', 16.5, 'butt'];
  var one = function (id, filter, m) {
    return { id: (casing ? 'asphalt-casing-live-' : 'asphalt-surface-live-') + id, type: 'line', source: 'live', minzoom: 10, filter: filter,
      layout: { 'line-cap': cap, 'line-join': 'round' }, paint: { 'line-color': casing ? zB : RB, 'line-width': CmWz(m, casing) } };
  };
  return CmClasses.map(function (c) { return one(c, ['==', ['get', 'wc'], c], c / 10); })
    .concat([one('other', ['!', ['in', ['get', 'wc'], ['literal', CmClasses]]], 4.6)]);
}
/* Plain (atlas) streets, one layer per kind: yellow main roads at city zoom; close up main and
   secondary streets become grey asphalt with white edges and local streets stay white. */
function CmAtlasLayers(casing) {
  var kinds = [['road-main', 6, 11, '#d8bb85', '#ffe1a1', '#ffffff', '#c4c9d6'], ['road-secondary', 5, 8, '#d9d3c8', '#fffaf0', '#ffffff', '#c4c9d6'], ['road-local', 3, 4, '#d9d3c8', '#ffffff', '#dfe1e8', '#ffffff']];
  return kinds.map(function (k) {
    var px = function (z) { return (k[2] + (casing ? 1.2 : 0)) * Math.pow(2, z) / 61170; }, add = casing ? 1.5 : 0;
    var w = ['interpolate', ['exponential', 2], ['zoom'], 10, 0.5 * k[1] + add, 13, k[1] + add, 16, Math.max(k[1] + add, px(16)), 18, Math.max(1.6 * k[1] + add, px(18)), 22, px(22)];
    return { id: (casing ? 'road-casing-' : 'road-surface-') + k[0], type: 'line', source: 'atlas', 'source-layer': 'lines',
      filter: ['all', ['==', ['get', 'kind'], k[0]], ['!', ['has', 'asphalt']], ['!', ['has', 'dup']]],
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['interpolate', ['linear'], ['zoom'], 15, casing ? k[3] : k[4], 16.5, casing ? k[5] : k[6]], 'line-width': w } };
  });
}
