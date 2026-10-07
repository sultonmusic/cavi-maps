/* Cavi Maps API v1 — the Cavi Maps map inside any web site.

   <div id="map" style="height:420px"></div>
   <script src="https://sultonmusic.github.io/cavi-maps/api/cavi-maps.js"></script>
   <script>
     const map = CaviMaps.create(document.getElementById('map'), { key: 'YOUR_KEY', lat: 38.5737, lon: 68.7738, zoom: 14 });
     map.route({ from: [38.5806, 68.7739], to: [38.5598, 68.7870], mode: 'car' })
        .then(r => console.log(r.meters, r.seconds));     // the route is drawn on the map
     map.on('click', p => console.log(p.lat, p.lon));     // a tap on the map
   </script>

   Methods: route({from, to, mode, fit, markers, fromLabel, toLabel}) -> Promise<{meters, seconds, path}>
            setView({lat, lon, zoom, pitch, bearing}), setMarkers([{lat, lon, label, color}]), clear(),
            on('ready' | 'click' | 'error', fn), destroy().
   Points are [lat, lon] or {lat, lon}. The key works only on the sites listed for it in the admin page. */
(function () {
  'use strict';
  var script = document.currentScript;
  var BASE = script ? new URL('..', script.src).href : 'https://sultonmusic.github.io/cavi-maps/';
  var ORIGIN = new URL(BASE).origin;

  function CaviMap(element, options) {
    options = options || {};
    if (!element) throw Error('CaviMaps.create: element is required');
    if (!options.key) throw Error('CaviMaps.create: options.key is required');
    var self = this, queue = [], ready = false, seq = 0, waiting = {}, handlers = {}, hello = 0;
    var lat = +options.lat, lon = +options.lon, zoom = +(options.zoom || 14);
    var start = isFinite(lat) && isFinite(lon) ? 'Tajikistan/' + lat.toFixed(5) + ',' + lon.toFixed(5) + ',' + zoom.toFixed(1) + 'z' : '';
    var frame = document.createElement('iframe');
    frame.src = BASE + start + '?embed=1';
    frame.title = 'Cavi Maps';
    frame.allow = 'geolocation';
    frame.style.cssText = 'border:0;width:100%;height:100%;display:block';
    element.appendChild(frame);

    var post = function (msg) { frame.contentWindow && frame.contentWindow.postMessage(Object.assign({ cavi: 1 }, msg), ORIGIN); };
    var emit = function (name, value) { (handlers[name] || []).forEach(function (fn) { try { fn(value); } catch (e) { setTimeout(function () { throw e; }); } }); };
    var command = function (msg) { ready ? post(msg) : queue.push(msg); };
    var greet = function () { if (!ready) post({ type: 'hello', key: options.key }); };
    frame.addEventListener('load', function () { greet(); clearInterval(hello); hello = setInterval(greet, 700); });

    function onMessage(event) {
      if (event.origin !== ORIGIN || event.source !== frame.contentWindow) return;
      var m = event.data;
      if (!m || m.cavi !== 1) return;
      if (m.type === 'ready') {
        if (ready) return;
        ready = true; clearInterval(hello);
        queue.splice(0).forEach(post);
        emit('ready', self);
      } else if (m.type === 'error') {
        clearInterval(hello);
        emit('error', m);
        Object.keys(waiting).forEach(function (id) { waiting[id].reject(Error(m.message)); delete waiting[id]; });
      } else if (m.type === 'click') {
        emit('click', { lat: m.lat, lon: m.lon });
      } else if (m.type === 'route' && waiting[m.id]) {
        var w = waiting[m.id]; delete waiting[m.id];
        m.ok ? w.resolve({ meters: m.meters, seconds: m.seconds, path: m.path }) : w.reject(Error(m.error || 'Route failed'));
      }
    }
    window.addEventListener('message', onMessage);

    this.route = function (opts) {
      opts = opts || {};
      return new Promise(function (resolve, reject) {
        var id = ++seq;
        waiting[id] = { resolve: resolve, reject: reject };
        command(Object.assign({}, opts, { type: 'route', id: id }));
      });
    };
    this.setView = function (v) { command(Object.assign({}, v, { type: 'view' })); return self; };
    this.setMarkers = function (list) { command({ type: 'markers', markers: list || [] }); return self; };
    this.clear = function () { command({ type: 'clear' }); return self; };
    this.on = function (name, fn) { (handlers[name] = handlers[name] || []).push(fn); if (name === 'ready' && ready) fn(self); return self; };
    this.destroy = function () { clearInterval(hello); window.removeEventListener('message', onMessage); frame.remove(); };
    this.iframe = frame;
  }

  window.CaviMaps = { version: 1, create: function (element, options) { return new CaviMap(element, options); } };
})();
