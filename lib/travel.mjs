// Ways of getting about: what network each routes on, how fast it goes, where on the street it
// keeps, and the Russian spoken prompts for its turns. Shared by the planner, the map and the checks.
import { LANE_METRES } from './lanes.mjs';
import { APP_SPOKEN } from './brand.mjs';

export const MODES = ['foot', 'bike', 'scooter', 'car', 'bus', 'taxi'];
export const MODE_LABELS = { foot: 'Пешком', bike: 'Велосипед', scooter: 'Самокат', car: 'Автомобиль', bus: 'Автобус', taxi: 'Такси' };
/** Kilometres an hour for the time estimate, without traffic. */
export const MODE_SPEEDS = { foot: 5, bike: 15, scooter: 12, car: 35, bus: 22, taxi: 35 };
/** Pedestrians and cyclists have networks of their own; buses and taxis drive the streets. */
export const MODE_NETWORK = { foot: 'foot', bike: 'bike', scooter: 'bike', car: 'car', bus: 'car', taxi: 'car' };
export const isMode = value => MODES.includes(value);

/** Metres right of a street's centre line to keep to: drivers in the rightmost lane (`shift` lane
    widths), cyclists near the right kerb, pedestrians on the pavement beyond it. `half` is the
    street's half width in metres; off a street whose width is known everyone keeps to the line. */
export function keepRight(mode, shift, half) {
  if (!(half > 0)) return 0;
  const network = MODE_NETWORK[mode] ?? 'car';
  if (network === 'foot') return half + 1.5;
  if (network === 'bike') return Math.max(0, half - 0.8);
  return shift * LANE_METRES;
}

const plural = (n, one, few, many) => {
  const tens = n % 100, units = n % 10;
  return tens > 10 && tens < 20 ? many : units === 1 ? one : units > 1 && units < 5 ? few : many;
};

/** A distance as spoken in Russian: "300 метров", "1 километр", "1,5 километра". */
export function spokenDistance(metres) {
  if (metres < 950) {
    const rounded = metres < 100 ? Math.max(10, Math.round(metres / 10) * 10) : Math.round(metres / 50) * 50;
    return `${rounded} ${plural(rounded, 'метр', 'метра', 'метров')}`;
  }
  const kilometres = Math.round(metres / 100) / 10;
  return Number.isInteger(kilometres) ? `${kilometres} ${plural(kilometres, 'километр', 'километра', 'километров')}` : `${String(kilometres).replace('.', ',')} километра`;
}

const ACTIONS = { left: 'поверните налево', right: 'поверните направо', uturn: 'развернитесь', straight: 'двигайтесь прямо', arrive: 'вы прибудете в точку Б' };

/** The prompt for the next turn at a distance: said once far out, once close in and once at the
    turn, nearer for slower modes. `stage` rises as the turn approaches; null while it is still far. */
export function turnPrompt(kind, metres, mode) {
  const network = MODE_NETWORK[mode] ?? 'car';
  const [far, near, now] = network === 'foot' ? [150, 50, 12] : network === 'bike' ? [250, 80, 20] : [500, 150, 35];
  const action = ACTIONS[kind] ?? ACTIONS.straight;
  if (metres <= now) return { stage: 3, text: kind === 'arrive' ? 'Точка Б впереди' : action[0].toUpperCase() + action.slice(1) };
  if (metres <= near) return { stage: 2, text: `Через ${spokenDistance(metres)} ${action}` };
  if (metres <= far) return { stage: 1, text: `Через ${spokenDistance(metres)} ${action}` };
  return null;
}

/** Said when the route ends: arrival, or the end of the way short of point B, with a thank-you.
    The name is spelt as a Russian voice should say it. */
export const arrivalPhrase = atDestination => `${atDestination ? 'Вы прибыли в точку Б' : 'Конец маршрута'}. Спасибо, что выбрали ${APP_SPOKEN}`;
