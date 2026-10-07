/* Cavi Maps extras, loaded next to the app bundle:
   1. Coordinates in the address: <base>/Tajikistan/<City>/<lat>,<lon>,<zoom>z opens the map there,
      and the address follows the map as it moves (replaceState, no history spam).
   2. Embed mode (<base>?embed=1): the bare map for other sites, driven by the Cavi Maps API
      (api/cavi-maps.js) over postMessage. A site may use it only with an active key whose list
      of allowed origins contains the site's origin (api/keys.json, managed in api/admin.html). */
(function () {
  'use strict';
  var script = document.currentScript;
  var BASE = script ? new URL('.', script.src).pathname : '/cavi-maps/';
  var params = new URLSearchParams(location.search);
  var EMBED = params.has('embed');
  var CITIES = [
    ['Dushanbe', 38.575, 68.79, 18], ['Khujand', 40.283, 69.62, 14], ['Bokhtar', 37.836, 68.78, 10],
    ['Kulob', 37.914, 69.784, 10], ['Khorog', 37.49, 71.55, 8], ['Panjakent', 39.495, 67.609, 8],
    ['Shaydon', 40.66, 70.36, 8], ['Vahdat', 38.561, 69.017, 8], ['Hisor', 38.53, 68.558, 8],
    ['Istaravshan', 39.91, 69.0, 8], ['Tursunzoda', 38.51, 68.23, 8], ['Isfara', 40.126, 70.625, 8],
    ['Konibodom', 40.29, 70.43, 8], ['Danghara', 38.1, 69.33, 6], ['Norak', 38.39, 69.32, 6],
  ];
  var km = function (a, b, c, d) { var k = Math.cos(a * Math.PI / 180); return Math.hypot((d - b) * k, c - a) * 111.32; };
  var cityAt = function (lat, lon) {
    var best = null;
    CITIES.forEach(function (c) { var d = km(lat, lon, c[1], c[2]); if (d <= c[3] && (!best || d < best.d)) best = { name: c[0], d: d }; });
    return best && best.name;
  };

  /* ------------------------------------------------------------------ address <-> map view */
  var COORD = /^(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)(?:,(\d{1,2}(?:\.\d+)?)z)?$/;
  function viewFromAddress() {
    var rest = decodeURIComponent(location.pathname.indexOf(BASE) === 0 ? location.pathname.slice(BASE.length) : '');
    var parts = rest.split('/').filter(Boolean), last = parts[parts.length - 1] || '';
    var m = COORD.exec(last) || (params.get('ll') && COORD.exec(params.get('ll') + (params.get('z') ? ',' + params.get('z') + 'z' : '')));
    if (!m) return null;
    var lat = +m[1], lon = +m[2], zoom = m[3] ? +m[3] : 17;
    if (!(Math.abs(lat) <= 90 && Math.abs(lon) <= 180)) return null;
    return { center: [lon, lat], zoom: Math.min(20, Math.max(3, zoom)) };
  }
  function addressFor(map) {
    var c = map.getCenter(), city = cityAt(c.lat, c.lng);
    return BASE + 'Tajikistan/' + (city ? city + '/' : '') + c.lat.toFixed(5) + ',' + c.lng.toFixed(5) + ',' + map.getZoom().toFixed(1) + 'z' + location.search + location.hash;
  }
  var onAdmin = location.pathname.replace(/\/$/, '') === BASE + 'admin';

  function whenMap(cb) {
    var tries = 0;
    (function poll() {
      var core = window.CaviMapsCore;
      if (core && core.map) {
        var map = core.map;
        if (map.isStyleLoaded()) cb(map, core); else map.once('load', function () { cb(map, core); });
        return;
      }
      if (++tries < 600) setTimeout(poll, 100);
    })();
  }

  whenMap(function (map) {
    var target = viewFromAddress(), userMoved = false;
    if (target) {
      map.jumpTo(target);
      /* the app may still restore its own last view right after start: keep the address view
         for a few seconds unless the user moves the map */
      var until = Date.now() + 4000;
      map.on('movestart', function (e) { if (e.originalEvent) userMoved = true; });
      map.on('moveend', function () {
        if (userMoved || Date.now() > until) return;
        var c = map.getCenter();
        if (km(c.lat, c.lng, target.center[1], target.center[0]) > 0.05) map.jumpTo(target);
      });
    }
    if (EMBED || onAdmin) return;
    var t = 0;
    map.on('moveend', function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var next = addressFor(map);
        if (next !== location.pathname + location.search + location.hash) history.replaceState(history.state, '', next);
      }, 400);
    });
  });

  if (!EMBED) return;

  /* ------------------------------------------------------------------ embed mode */
  document.documentElement.classList.add('cavi-embed');
  var css = document.createElement('style');
  css.textContent =
    'html.cavi-embed #root *{visibility:hidden!important}' +
    'html.cavi-embed .maplibregl-map,html.cavi-embed .maplibregl-map *{visibility:visible!important}' +
    'html.cavi-embed .maplibregl-ctrl-top-left,html.cavi-embed .maplibregl-ctrl-top-right{display:none!important}' +
    '.cavi-api-pin{position:absolute;left:0;top:0;transform:translate(-50%,-100%);pointer-events:none;z-index:4;' +
    'font:600 12px/1.2 Arial,sans-serif;color:#fff;padding:5px 9px;border-radius:14px;white-space:nowrap;box-shadow:0 2px 6px #0004}' +
    '.cavi-api-pin:after{content:"";position:absolute;left:50%;bottom:-6px;margin-left:-6px;border:6px solid transparent;border-bottom:0;border-top-color:inherit}' +
    '.cavi-api-msg{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;background:#f7f5edee;z-index:10;' +
    'font:500 15px/1.4 Arial,sans-serif;color:#3d4250;text-align:center;padding:24px;visibility:visible!important}';
  document.head.appendChild(css);

  var parentOrigin = null, authorised = false, keysPromise = null, worker = null, pending = new Map(), pins = [], seq = 0;
  var send = function (msg) { if (parentOrigin) parent.postMessage(Object.assign({ cavi: 1 }, msg), parentOrigin); };
  var notice = function (text) {
    var el = document.querySelector('.cavi-api-msg');
    if (!el) { el = document.createElement('div'); el.className = 'cavi-api-msg'; document.body.appendChild(el); }
    el.textContent = text;
  };
  function keys() {
    keysPromise = keysPromise || fetch(BASE + 'api/keys.json', { cache: 'no-cache' }).then(function (r) { return r.json(); }).catch(function () { return { keys: {} }; });
    return keysPromise;
  }
  function allowed(entry, origin) {
    if (!entry || entry.active === false) return false;
    return (entry.origins || []).some(function (o) {
      if (o === '*') return true;
      if (o.indexOf('*.') >= 0) { var host = new URL(origin).hostname, tail = o.split('*.')[1].replace(/^https?:\/\//, ''); return host === tail || host.slice(-tail.length - 1) === '.' + tail; }
      return o.replace(/\/$/, '') === origin;
    });
  }

  function routeWorker() {
    if (worker) return worker;
    worker = new Worker(BASE + 'route-worker.js');
    worker.onmessage = function (e) {
      var d = e.data;
      if (!d || d.id === undefined || !pending.has(d.id)) return;
      var job = pending.get(d.id); pending.delete(d.id);
      job(d);
    };
    return worker;
  }
  var pt = function (p) {
    if (Array.isArray(p) && p.length === 2) return [+p[0], +p[1]];
    if (p && typeof p === 'object') return [+(p.lat), +(p.lon !== undefined ? p.lon : p.lng)];
    return null;
  };
  var okPt = function (p) { return p && isFinite(p[0]) && isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180; };

  function drawRoute(map, path) {
    var line = { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: path.map(function (p) { return [p[1], p[0]]; }) } };
    var data = { type: 'FeatureCollection', features: path.length > 1 ? [line] : [] };
    var src = map.getSource('cavi-api-route');
    if (src) { src.setData(data); return; }
    map.addSource('cavi-api-route', { type: 'geojson', data: data });
    map.addLayer({ id: 'cavi-api-route-outline', type: 'line', source: 'cavi-api-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#ffffff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 6, 18, 14] } });
    map.addLayer({ id: 'cavi-api-route-line', type: 'line', source: 'cavi-api-route', layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#1a73e8', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 18, 9] } });
  }
  function setPins(map, list) {
    pins.forEach(function (p) { p.el.remove(); });
    pins = (list || []).map(function (m) {
      var p = pt(m); if (!okPt(p)) return null;
      var el = document.createElement('div');
      el.className = 'cavi-api-pin';
      el.textContent = String(m.label || '').slice(0, 40) || '•';
      el.style.background = el.style.borderTopColor = /^#[0-9a-f]{3,8}$/i.test(m.color || '') ? m.color : '#1a73e8';
      map.getContainer().appendChild(el);
      return { el: el, ll: [p[1], p[0]] };
    }).filter(Boolean);
    placePins(map);
  }
  function placePins(map) { pins.forEach(function (p) { var q = map.project(p.ll); p.el.style.transform = 'translate(' + q.x + 'px,' + q.y + 'px) translate(-50%,-100%) translateY(-6px)'; }); }

  whenMap(function (map) {
    map.on('render', function () { placePins(map); });
    map.on('click', function (e) { if (authorised) send({ type: 'click', lat: e.lngLat.lat, lon: e.lngLat.lng }); });
    window.addEventListener('message', function (event) {
      var m = event.data;
      if (!m || m.cavi !== 1 || event.source !== parent) return;
      if (m.type === 'hello') {
        parentOrigin = event.origin;
        keys().then(function (k) {
          authorised = allowed(k.keys && k.keys[m.key], event.origin);
          if (authorised) { var el = document.querySelector('.cavi-api-msg'); if (el) el.remove(); send({ type: 'ready', version: 1 }); }
          else { notice('Cavi Maps: API-ключ не подходит для этого сайта (' + event.origin + ').'); send({ type: 'error', code: 'key', message: 'API key is not valid for ' + event.origin }); }
        });
        return;
      }
      if (!authorised || event.origin !== parentOrigin) return;
      if (m.type === 'view') {
        var v = pt(m);
        if (okPt(v)) map.jumpTo({ center: [v[1], v[0]], zoom: isFinite(m.zoom) ? +m.zoom : map.getZoom(), pitch: isFinite(m.pitch) ? +m.pitch : map.getPitch(), bearing: isFinite(m.bearing) ? +m.bearing : map.getBearing() });
      } else if (m.type === 'markers') {
        setPins(map, m.markers);
      } else if (m.type === 'clear') {
        drawRoute(map, []); setPins(map, []);
      } else if (m.type === 'route') {
        var from = pt(m.from), to = pt(m.to), id = ++seq;
        if (!okPt(from) || !okPt(to)) { send({ type: 'route', id: m.id, ok: false, error: 'Bad coordinates' }); return; }
        var mode = ['car', 'foot', 'bike'].indexOf(m.mode) >= 0 ? m.mode : 'car';
        pending.set(id, function (d) {
          if (d.error) { send({ type: 'route', id: m.id, ok: false, error: d.error }); return; }
          drawRoute(map, d.path);
          if (m.markers !== false) setPins(map, [{ lat: from[0], lon: from[1], label: m.fromLabel || 'A', color: '#12ad50' }, { lat: to[0], lon: to[1], label: m.toLabel || 'B', color: '#e2463b' }]);
          if (m.fit !== false) {
            var xs = d.path.map(function (p) { return p[1]; }), ys = d.path.map(function (p) { return p[0]; });
            map.fitBounds([[Math.min.apply(null, xs), Math.min.apply(null, ys)], [Math.max.apply(null, xs), Math.max.apply(null, ys)]], { padding: 48, duration: 600, pitch: 0 });
          }
          send({ type: 'route', id: m.id, ok: true, meters: d.meters, seconds: d.routes && d.routes[0] ? d.routes[0].seconds : null, path: d.path });
        });
        routeWorker().postMessage({ id: id, start: from, end: to, network: mode, maxRoutes: 1 });
      }
    });
    if (parent === window) notice('Cavi Maps: режим встраивания открывается только внутри сайта через API (api/cavi-maps.js).');
  });
})();
