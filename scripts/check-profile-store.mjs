// Checks the device-local profile (lib/profile-store.ts) with a stubbed window and localStorage.
//   node scripts/check-profile-store.mjs
import assert from 'node:assert/strict';

const data = new Map();
globalThis.window = new EventTarget();
globalThis.localStorage = {
  getItem: key => (data.has(key) ? data.get(key) : null),
  setItem: (key, value) => { data.set(key, String(value)) },
  removeItem: key => { data.delete(key) },
  clear: () => data.clear(),
  key: i => [...data.keys()][i] ?? null,
  get length() { return data.size },
};

const store = await import('../lib/profile-store.ts');
const { readPrefs, writePrefs, readVoice, writeVoice, readMode, writeMode, recentPlaces, rememberPlace, recentRoutes, rememberRoute, clearHistory, homePlace, setHomePlace, onProfileChange, storedPlace, PROFILE_KEYS, DEFAULT_PREFS } = store;

let checks = 0;
const ok = (value, message) => { assert.ok(value, message); checks++ };
const eq = (actual, expected, message) => { assert.deepEqual(actual, expected, message); checks++ };

let events = 0;
const stop = onProfileChange(() => { events++ });
const place = (n, extra = {}) => ({ id: `node/${n}`, lat: 38.5 + n / 1000, lon: 68.7, tags: { name: `Место ${n}`, amenity: 'cafe', phone: '+992 000', ...extra } });

// Defaults on an empty device.
eq(readPrefs(), { ...DEFAULT_PREFS }, 'default prefs');
eq(readVoice(), true, 'voice is on by default');
eq(readMode(), 'car', 'car by default');
eq(recentPlaces(), [], 'no history yet');
eq(homePlace('home'), null, 'no home yet');

// Recent places: at most 12, newest first, a repeat moves to the front.
for (let n = 1; n <= 14; n++) rememberPlace(place(n));
let recent = recentPlaces();
eq(recent.length, 12, '12 places kept');
eq(recent.map(p => p.id).slice(0, 3), ['node/14', 'node/13', 'node/12'], 'newest first');
ok(!recent.some(p => p.id === 'node/1' || p.id === 'node/2'), 'the oldest two dropped');
rememberPlace(place(5));
recent = recentPlaces();
eq(recent[0].id, 'node/5', 'a repeated place moves to the front');
eq(recent.filter(p => p.id === 'node/5').length, 1, 'and is listed once');
eq(recent.length, 12, 'still 12');
ok(!('phone' in recent[0].tags) && recent[0].tags.name === 'Место 5' && recent[0].tags.amenity === 'cafe', 'tags outside the list (phone) are dropped');
ok(typeof recent[0].at === 'number' && recent[0].at > 0, 'each has the time it was opened');
rememberPlace({ id: 'point:40.1,69.2', lat: 40.1, lon: 69.2, tags: { name: 'Точка на карте' } });
ok(!recentPlaces().some(p => p.id.startsWith('point:')), 'a bare map tap is not remembered');
rememberPlace({ id: 'node/x', lat: 'north', lon: 68, tags: {} });
ok(!recentPlaces().some(p => p.id === 'node/x'), 'a place without a position is not remembered');
eq(storedPlace({ id: 'a', lat: 1, lon: 2, tags: { name: 'A', 'name:ru': 'А', note: 'x', 'atlas:type': 'label' } }), { id: 'a', lat: 1, lon: 2, tags: { name: 'A', 'name:ru': 'А', 'atlas:type': 'label' } }, 'storedPlace whitelists tags');
eq(storedPlace({ id: 'way/1', lat: 1, lon: 2, tags: { name: 'P', leisure: 'park', phone: '1' } })?.tags, { name: 'P', leisure: 'park' }, 'the kind tags stay, so the Profile row still reads «Парк»');

// Recent routes: one per destination and mode, at most 8.
for (let n = 1; n <= 10; n++) rememberRoute({ to: place(n), mode: 'car', meters: 1000 * n, seconds: 60 * n, at: Date.now() });
rememberRoute({ to: place(10), mode: 'foot', fromName: '  Дом  ', meters: 900, seconds: 700, at: Date.now() });
rememberRoute({ to: place(10), mode: 'car', meters: 10500, seconds: 610, at: Date.now() });
const routes = recentRoutes();
eq(routes.length, 8, '8 routes kept');
eq([routes[0].to.id, routes[0].mode, routes[0].meters], ['node/10', 'car', 10500], 'the same destination and mode replaces the old route');
eq([routes[1].to.id, routes[1].mode, routes[1].fromName], ['node/10', 'foot', 'Дом'], 'another mode is its own route');
eq(routes.filter(r => r.to.id === 'node/10').length, 2, 'two modes to one place');
ok(!('phone' in routes[0].to.tags), 'route destinations keep only listed tags');
rememberRoute({ to: place(20), mode: 'plane', meters: 1, seconds: 1, at: 1 });
ok(!recentRoutes().some(r => r.to.id === 'node/20'), 'an unknown mode is refused');

// Voice, mode and prefs.
writeVoice(false);
eq(data.get(PROFILE_KEYS.voice), 'off', "writeVoice(false) stores 'off'");
eq(readVoice(), false, 'voice off');
writeVoice(true);
eq(readVoice(), true, 'voice back on');
writeMode('foot');
eq([readMode(), data.get(PROFILE_KEYS.mode)], ['foot', 'foot'], 'mode stored');
writeMode('rocket');
eq(readMode(), 'foot', 'an unknown mode is ignored');
data.set(PROFILE_KEYS.mode, 'teleport');
eq(readMode(), 'car', 'a broken stored mode reads as car');
writePrefs({ homeCity: 'Худжанд' });
writePrefs({ start3d: true });
eq(readPrefs(), { homeCity: 'Худжанд', openInHomeCity: false, start3d: true }, 'writePrefs merges fields');
writePrefs({ openInHomeCity: true });
eq(readPrefs().openInHomeCity, true, 'openInHomeCity stored');
writePrefs({ homeCity: 'Атлантида' });
eq(readPrefs().homeCity, null, 'an unknown town is not kept');
writePrefs({ homeCity: 'Таджикистан' });
eq(readPrefs().homeCity, null, 'the whole country is not a home town');
data.set(PROFILE_KEYS.prefs, '{broken');
eq(readPrefs(), { ...DEFAULT_PREFS }, 'broken prefs read as defaults');

// Home and work.
setHomePlace('home', place(7, { 'addr:street': 'Рудаки', 'addr:housenumber': '12' }));
eq(homePlace('home'), { id: 'node/7', lat: 38.507, lon: 68.7, tags: { name: 'Место 7', amenity: 'cafe', 'addr:street': 'Рудаки', 'addr:housenumber': '12' } }, 'home round-trips');
eq(homePlace('work'), null, 'work is separate');
setHomePlace('work', place(8));
eq(homePlace('work')?.id, 'node/8', 'work set');
setHomePlace('home', null);
eq(homePlace('home'), null, 'home forgotten');
ok(!data.has(PROFILE_KEYS.home), 'and its key removed');

// History clearing leaves home and settings.
clearHistory();
eq([recentPlaces().length, recentRoutes().length], [0, 0], 'clearHistory empties both lists');
eq(homePlace('work')?.id, 'node/8', 'clearHistory keeps work');

// Events.
const before = events;
writeVoice(false); writeMode('bus'); writePrefs({ start3d: false }); rememberPlace(place(3)); setHomePlace('home', place(4)); clearHistory();
eq(events - before, 6, 'every write tells the listeners');
window.dispatchEvent(Object.assign(new Event('storage'), { key: 'atlas-home' }));
eq(events - before, 7, 'a change in another tab is heard');
window.dispatchEvent(Object.assign(new Event('storage'), { key: 'firebase:auth' }));
eq(events - before, 7, 'other keys are ignored');
stop();
writeVoice(true);
eq(events - before, 7, 'no events after stopping');

// A refusing storage (private mode, quota) behaves like an empty profile and never throws.
globalThis.localStorage = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } };
eq([readVoice(), readMode(), recentPlaces().length, homePlace('home')], [true, 'car', 0, null], 'refused storage reads as empty');
rememberPlace(place(1)); writePrefs({ start3d: true }); clearHistory(); setHomePlace('work', place(2));
ok(true, 'refused storage writes do not throw');

console.log(`check-profile-store: ${checks} checks passed`);
