// Node-only lifecycle checks: actual TSX handlers, with GPS/Worker and React hooks
// mocked at their boundaries. This does not open or inspect a browser or DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';

const compile = filename => ts.transpileModule(fs.readFileSync(new URL(filename, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
  fileName: filename,
}).outputText;
const navigationCode = compile('../lib/navigation.ts');
const componentCode = compile('../components/route-planner.tsx');
const sameDeps = (a, b) => a && b && a.length === b.length && a.every((v, i) => Object.is(v, b[i]));
const point = (lat, lon, name = 'Точка Б') => ({ id: `test:${lat},${lon}`, lat, lon, tags: { name } });
const A = [40.65, 70.38], ROAD_END = [40.651, 70.38];
const normalRoute = { path: [A, ROAD_END], meters: 111.195, seconds: 20 };

function evaluate(code, dependencies, globals = {}) {
  const module = { exports: {} };
  const context = vm.createContext({ module, exports: module.exports, require: name => {
    if (!(name in dependencies)) throw Error(`Unexpected dependency: ${name}`);
    return dependencies[name];
  }, ...globals });
  new vm.Script(code).runInContext(context);
  return module.exports;
}

function harness(destination = point(...ROAD_END), options = {}) {
  const slots = [];
  let cursor = 0, dirty = true, tree = null, effects = [];
  const watches = [], oneShots = [], clearedWatches = [], workers = [], timers = new Map();
  const mapMoves = [], navigationStates = [];
  let timerId = 0;
  const hooks = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { value: typeof initial === 'function' ? initial() : initial };
      return [slots[index].value, value => {
        const next = typeof value === 'function' ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(value) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: value };
      return slots[index];
    },
    useMemo(fn, dependencies) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].dependencies, dependencies)) slots[index] = { value: fn(), dependencies };
      return slots[index].value;
    },
    useCallback(fn, dependencies) { return hooks.useMemo(() => fn, dependencies); },
    useEffect(fn, dependencies) {
      const index = cursor++;
      if (!slots[index] || !sameDeps(slots[index].dependencies, dependencies)) {
        const oldCleanup = slots[index]?.cleanup;
        const slot = { dependencies, cleanup: undefined, effect: true };
        slots[index] = slot;
        effects.push(() => { oldCleanup?.(); slot.cleanup = fn(); });
      }
    },
  };
  const jsx = (type, props) => ({ type, props: props || {} });
  const layer = () => {
    const item = {
      addTo: () => item, remove: () => item, on: () => item,
      setLatLng: () => item, setLatLngs: () => item, setRadius: () => item,
      getBounds: () => ({}), getElement: () => ({ querySelector: () => ({ style: {} }) }),
    };
    return item;
  };
  const map = {
    on() {}, off() {}, fitBounds() {}, getSize: () => ({ y: 900 }), getZoom: () => 17,
    setView: (...args) => mapMoves.push(args),
  };
  const navigator = { geolocation: options.geolocation === false ? undefined : {
    watchPosition(success, error) { watches.push({ success, error }); return watches.length; },
    clearWatch(id) { clearedWatches.push(id); },
    getCurrentPosition(success, error) { oneShots.push({ success, error }); },
  } };
  class FakeWorker {
    constructor() { this.messages = []; workers.push(this); }
    postMessage(message) { this.messages.push(message); }
    terminate() { this.terminated = true; }
  }
  const nav = evaluate(navigationCode, {});
  const Component = evaluate(componentCode, {
    react: hooks,
    'react/jsx-runtime': { jsx, jsxs: jsx, Fragment: Symbol('Fragment') },
    'lucide-react': new Proxy({}, { get: (_, name) => `icon:${String(name)}` }),
    '@/lib/navigation': nav,
  }, {
    navigator, Worker: FakeWorker,
    window: { isSecureContext: options.secure !== false, L: { marker: layer, circle: layer, polyline: layer, divIcon: options => options } },
    setInterval: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id),
  }).default;
  const props = {
    mapRef: { current: map }, ready: true, places: [], saved: [], destination, open: true,
    pickRef: { current: null },
    onClose() { props.open = false; dirty = true; },
    onDestinationChange(value) { props.destination = value; dirty = true; },
    onNavigationChange(value) { navigationStates.push(value); },
  };
  function flush() {
    for (let i = 0; dirty; i++) {
      if (i > 50) throw Error('Hook harness did not settle');
      dirty = false; cursor = 0; effects = [];
      tree = Component(props);
      const pending = effects; effects = [];
      pending.forEach(run => run());
    }
    return tree;
  }
  function all(node = tree, result = []) {
    if (Array.isArray(node)) node.forEach(n => all(n ?? null, result));
    else if (node && typeof node === 'object') { result.push(node); all(node.props?.children ?? null, result); }
    return result;
  }
  function text(node = tree) {
    if (Array.isArray(node)) return node.map(n => text(n ?? null)).join('');
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node !== 'object') return String(node);
    return text(node.props?.children ?? null);
  }
  function button(label) {
    const found = all().find(n => n.type === 'button' && text(n) === label);
    assert.ok(found, `Expected button: ${label}; rendered: ${text()}`);
    return found;
  }
  function click(label) {
    const b = button(label); assert.notEqual(b.props.disabled, true, `${label} must be enabled`);
    b.props.onClick(); flush();
  }
  function clickAria(label) {
    const found = all().find(n => n.type === 'button' && n.props['aria-label'] === label);
    assert.ok(found, `Expected accessible button: ${label}`);
    assert.notEqual(found.props.disabled, true, `${label} must be enabled`);
    found.props.onClick(); flush();
  }
  const originInput = () => all().find(n => n.type === 'input' && n.props['aria-label'] === 'Откуда поедем');
  function chooseOrigin(coordinates = A) {
    originInput().props.onChange({ target: { value: coordinates.join(', ') } }); flush();
    originInput().props.onKeyDown({ key: 'Enter' }); flush();
  }
  function latestRequest() { return workers.at(-1)?.messages.filter(m => m.id !== undefined).at(-1); }
  function respond(id, route = normalRoute, endGap = 0) {
    workers.at(-1).onmessage({ data: { id, routes: [route], startGap: 0, endGap } }); flush();
  }
  function build(route = normalRoute, endGap = 0) {
    chooseOrigin(); click('Построить маршрут'); respond(latestRequest().id, route, endGap);
  }
  function gps(coordinates, callback = watches.at(-1)) {
    callback.success({ coords: { latitude: coordinates[0], longitude: coordinates[1], accuracy: 5, speed: 8, heading: 0 }, timestamp: Date.now() }); flush();
  }
  flush();
  return { flush, text, all, click, clickAria, button, originInput, chooseOrigin, latestRequest, respond, build, gps,
    watches, oneShots, clearedWatches, workers, mapMoves, navigationStates,
    tickTimers() { [...timers.values()].forEach(fn => fn()); flush(); },
    get timerCount() { return timers.size; },
    setProps(values) { Object.assign(props, values); dirty = true; flush(); },
    destroy() { slots.filter(s => s.effect).forEach(s => s.cleanup?.()); },
  };
}

// A queued location success/error must not revive navigation after explicit Stop.
{
  const h = harness(); h.build(); h.click('В путь');
  const queuedWatch = h.watches.at(-1);
  // Deliver the queued fix before the next render, while current.current still
  // contains the prior navigation state. The epoch guard must act synchronously.
  h.button('Остановить').props.onClick();
  const moveCount = h.mapMoves.length;
  h.gps(A, queuedWatch);
  queuedWatch.error({ code: 1 }); h.flush();
  assert.equal(h.mapMoves.length, moveCount, 'Stopped GPS must not move the map');
  assert.equal(h.navigationStates.at(-1), false);
  assert.ok(h.button('В путь'));
  assert.doesNotMatch(h.text(), /Доступ к GPS запрещён|Ждём точный сигнал/);
  h.destroy();
}

// A one-shot location request cannot fill A or move the map after Close/reopen.
{
  const h = harness(); h.click('Моё местоположение');
  const lateLocation = h.oneShots.at(-1);
  h.click('Отмена');
  const moveCount = h.mapMoves.length;
  lateLocation.success({ coords: { latitude: A[0], longitude: A[1] } });
  lateLocation.error({ code: 1 }); h.flush();
  h.setProps({ open: true });
  assert.equal(h.originInput().props.value, '');
  assert.equal(h.mapMoves.length, moveCount);
  assert.doesNotMatch(h.text(), /Разрешите доступ к местоположению/);
  h.destroy();
}

// A stopped reroute response must not replace A or keep the preview busy.
{
  const h = harness(); h.build();
  const initialRequest = h.latestRequest().id;
  h.click('В путь'); h.gps([40.65, 70.382]); h.gps([40.65, 70.382]);
  const pendingReroute = h.latestRequest();
  assert.notEqual(pendingReroute.id, initialRequest, 'Two off-route fixes should request rerouting');
  h.click('Остановить');
  h.respond(pendingReroute.id, { path: [[40.65, 70.382], ROAD_END], meters: 9000, seconds: 1000 });
  assert.ok(h.text().includes(A.join(', ')), 'Original A remains visible in compact route summary');
  assert.notEqual(h.button('В путь').props.disabled, true);
  assert.doesNotMatch(h.text(), /9\.0 км|Текущее местоположение/);
  h.destroy();
}

// Ending the drivable path away from B must not claim arrival at the destination.
{
  const h = harness(point(40.652, 70.38)); h.build(normalRoute, 111.195);
  assert.match(h.text(), /Подъезд не найден/);
  h.click('В путь'); h.gps(ROAD_END);
  assert.match(h.text(), /Конец автомобильного маршрута/);
  assert.match(h.text(), /До точки Б ещё 110 м/);
  assert.doesNotMatch(h.text(), /Вы на месте|Вы прибыли к точке Б/);
  assert.ok(h.clearedWatches.length > 0);
  h.destroy();
}

// Denied GPS still opens the route, with stable totals and explicitly manual steps.
{
  const end = [40.651, 70.381];
  const route = { path: [A, ROAD_END, end], meters: 195.5, seconds: 60 };
  const h = harness(point(...end)); h.build(route); h.click('В путь');
  const denied = h.watches.at(-1);
  denied.error({ code: 1 }); h.flush();
  assert.equal(h.navigationStates.at(-1), true, 'Manual viewing keeps the map in focused navigation layout');
  assert.match(h.text(), /Просмотр маршрута · без GPS/);
  assert.match(h.text(), /200 мдлина маршрута/);
  assert.doesNotMatch(h.text(), /км\/ч|прибытие|осталось|Вы прибыли|Вы на месте/);
  assert.equal(h.timerCount, 0, 'Manual viewing must not animate simulated progress');
  const beforeTick = h.text(); h.tickTimers(); assert.equal(h.text(), beforeTick);
  h.clickAria('Следующий шаг');
  assert.match(h.text(), /Шаг 2 из 3Поверните направо/);
  assert.match(h.text(), /200 мдлина маршрута/, 'Browsing a turn does not reduce route distance');
  h.clickAria('Следующий шаг');
  assert.match(h.text(), /Конец автомобильного маршрута/);
  assert.doesNotMatch(h.text(), /Вы прибыли|Вы на месте/);
  const moves = h.mapMoves.length; h.gps(A, denied);
  assert.equal(h.mapMoves.length, moves, 'Cancelled GPS callbacks cannot revive live tracking');
  h.click('Включить GPS'); assert.equal(h.watches.length, 2);
  h.gps(A);
  assert.match(h.text(), /GPS активен/); assert.match(h.text(), /км\/ч/);
  h.click('Остановить'); assert.ok(h.button('В путь')); h.destroy();
}

// The route is usable on insecure mobile HTTP and without a geolocation API.
for (const options of [{ secure: false }, { geolocation: false }]) {
  const h = harness(point(...ROAD_END), options); h.build(); h.click('В путь');
  assert.equal(h.watches.length, 0);
  assert.equal(h.navigationStates.at(-1), true);
  assert.match(h.text(), /Просмотр маршрута · без GPS/);
  assert.match(h.text(), /110 мдлина маршрута/);
  assert.doesNotMatch(h.text(), /км\/ч|прибытие|осталось/);
  assert.equal(h.timerCount, 0);
  h.click('Шаг за шагом'); assert.match(h.text(), /Конец автомобильного маршрута/);
  h.click('Остановить'); assert.ok(h.button('В путь')); h.destroy();
}

// Users may skip acquisition immediately, without waiting for a browser timeout.
{
  const h = harness(); h.build(); h.click('В путь');
  const acquiring = h.watches.at(-1);
  assert.match(h.text(), /маршрут уже доступен/);
  h.click('Без GPS');
  assert.match(h.text(), /Просмотр маршрута · без GPS/);
  assert.equal(h.timerCount, 0);
  const before = h.text(); h.gps(A, acquiring);
  acquiring.error({ code: 1 }); h.flush();
  assert.equal(h.text(), before, 'Queued acquisition events cannot override manual mode');
  h.destroy();
}

console.log('Planner checks passed: optional GPS, manual steps and stable totals, retry/live tracking, stale GPS, late location, stopped reroute, off-road destination.');
