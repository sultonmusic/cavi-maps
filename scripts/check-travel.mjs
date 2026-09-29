/* Travel modes and spoken prompts: each mode routes on its network at its speed and keeps to its
 * part of the street, and turn prompts count down in correct Russian.
 *
 *   node scripts/check-travel.mjs
 */
import assert from 'node:assert/strict';
import { MODES, MODE_LABELS, MODE_NETWORK, MODE_SPEEDS, arrivalPhrase, isMode, keepRight, spokenDistance, turnPrompt } from '../lib/travel.mjs';

assert.deepEqual(MODES, ['foot', 'bike', 'scooter', 'car', 'bus', 'taxi']);
for (const mode of MODES) assert.ok(MODE_LABELS[mode] && MODE_SPEEDS[mode] > 0 && ['foot', 'bike', 'car'].includes(MODE_NETWORK[mode]));
assert.ok(isMode('taxi') && !isMode('plane') && !isMode(undefined));
assert.ok(MODE_SPEEDS.foot < MODE_SPEEDS.scooter && MODE_SPEEDS.scooter < MODE_SPEEDS.bike && MODE_SPEEDS.bus < MODE_SPEEDS.car);

// Where each keeps on a two-way street with two lanes each way (6.8 m to the kerb).
assert.equal(keepRight('car', 1.5, 6.8), 1.5 * 3.4, 'drivers in the rightmost lane');
assert.equal(keepRight('taxi', 1.5, 6.8), keepRight('bus', 1.5, 6.8));
assert.equal(keepRight('bike', 1.5, 6.8), 6, 'cyclists just inside the kerb');
assert.equal(keepRight('foot', 1.5, 6.8), 8.3, 'pedestrians on the pavement');
assert.equal(keepRight('foot', 0, 0), 0, 'off a known street, on the line');

assert.deepEqual(['1', '21', '300', '349', '1000', '2000', '5000', '1500', '2340'].map(Number).map(spokenDistance),
  ['10 метров', '20 метров', '300 метров', '350 метров', '1 километр', '2 километра', '5 километров', '1,5 километра', '2,3 километра']);

assert.equal(turnPrompt('left', 800, 'car'), null, 'nothing while the turn is far');
assert.deepEqual(turnPrompt('left', 480, 'car'), { stage: 1, text: 'Через 500 метров поверните налево' });
assert.deepEqual(turnPrompt('right', 140, 'taxi'), { stage: 2, text: 'Через 150 метров поверните направо' });
assert.deepEqual(turnPrompt('right', 30, 'car'), { stage: 3, text: 'Поверните направо' });
assert.equal(turnPrompt('left', 300, 'foot'), null, 'a pedestrian hears it nearer');
assert.deepEqual(turnPrompt('uturn', 40, 'foot'), { stage: 2, text: 'Через 40 метров развернитесь' });
assert.deepEqual(turnPrompt('arrive', 10, 'bike'), { stage: 3, text: 'Точка Б впереди' }, 'arrival itself is announced once, with the thank-you');
assert.equal(arrivalPhrase(true), 'Вы прибыли в точку Б. Спасибо, что выбрали Кави Мапс');
assert.equal(arrivalPhrase(false), 'Конец маршрута. Спасибо, что выбрали Кави Мапс');

console.log('PASS: six travel modes with their networks and speeds, keep-right positions for drivers, cyclists and pedestrians, and Russian turn prompts with correct plurals.');
