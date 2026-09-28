export type LatLng = [number, number];
export type Maneuver = {
  index: number;
  metersFromStart: number;
  instruction: string;
  kind: 'straight' | 'left' | 'right' | 'uturn' | 'arrive';
};
export type RouteProjection = {
  point: LatLng;
  segmentIndex: number;
  progressMeters: number;
  remainingMeters: number;
  offRouteMeters: number;
  totalMeters: number;
  valid: boolean;
};

const EARTH_RADIUS = 6371008.8;
const RAD = Math.PI / 180;
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));
const validPoint = (p: LatLng) => Array.isArray(p) && p.length >= 2 &&
  Number.isFinite(p[0]) && Number.isFinite(p[1]) && Math.abs(p[0]) <= 90 && Math.abs(p[1]) <= 180;
const longitudeDelta = (degrees: number) => ((degrees + 540) % 360) - 180;

/** Great-circle distance in metres. Invalid coordinates are rejected, never converted to (0, 0). */
export function distance(a: LatLng, b: LatLng): number {
  if (!validPoint(a) || !validPoint(b)) throw new RangeError('Некорректные координаты');
  const dLat = (b[0] - a[0]) * RAD;
  const dLon = longitudeDelta(b[1] - a[1]) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(clamp(h, 0, 1)));
}

function pathData(path: LatLng[]) {
  if (!path.length || path.some(p => !validPoint(p))) return null;
  const cumulative = new Float64Array(path.length);
  for (let i = 1; i < path.length; i++) cumulative[i] = cumulative[i - 1] + distance(path[i - 1], path[i]);
  return { cumulative, total: cumulative[cumulative.length - 1] };
}

function interpolate(a: LatLng, b: LatLng, t: number): LatLng {
  return [a[0] + (b[0] - a[0]) * t, longitudeDelta(a[1] + longitudeDelta(b[1] - a[1]) * t)];
}

function atDistance(path: LatLng[], cumulative: Float64Array, metres: number): LatLng {
  const target = clamp(metres, 0, cumulative[cumulative.length - 1]);
  let lo = 0, hi = path.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  if (!lo) return path[0];
  const length = cumulative[lo] - cumulative[lo - 1];
  return interpolate(path[lo - 1], path[lo], length ? (target - cumulative[lo - 1]) / length : 0);
}

function bearing(a: LatLng, b: LatLng): number {
  const lon = longitudeDelta(b[1] - a[1]) * RAD;
  const y = Math.sin(lon) * Math.cos(b[0] * RAD);
  const x = Math.cos(a[0] * RAD) * Math.sin(b[0] * RAD) - Math.sin(a[0] * RAD) * Math.cos(b[0] * RAD) * Math.cos(lon);
  return Math.atan2(y, x) / RAD;
}

/** A point a given distance along the path, with the direction of travel there. */
export function alongRoute(path: LatLng[], metres: number): { point: LatLng; heading: number; total: number } | null {
  const data = pathData(path);
  if (!data) return null;
  const point = atDistance(path, data.cumulative, metres);
  // Look a few metres either side so a vertex does not snap the heading.
  const behind = atDistance(path, data.cumulative, Math.max(0, metres - 4));
  const ahead = atDistance(path, data.cumulative, Math.min(data.total, metres + 4));
  const heading = distance(behind, ahead) > 0.5 ? (bearing(behind, ahead) + 360) % 360 : 0;
  return { point, heading, total: data.total };
}

/** Move a point a number of metres towards a compass heading. */
export function moveTowards(point: LatLng, headingDegrees: number, metres: number): LatLng {
  if (!validPoint(point)) throw new RangeError('Некорректные координаты');
  const angle = headingDegrees * RAD;
  const dLat = (metres * Math.cos(angle)) / EARTH_RADIUS / RAD;
  const dLon = (metres * Math.sin(angle)) / (EARTH_RADIUS * Math.max(1e-8, Math.cos(point[0] * RAD))) / RAD;
  return [clamp(point[0] + dLat, -90, 90), longitudeDelta(point[1] + dLon)];
}

/** Geometric guidance, without claims about named junctions, signs or turn permissions. */
export function buildManeuvers(path: LatLng[]): Maneuver[] {
  const data = pathData(path);
  if (!data) return [];
  if (data.total < 0.1) return [{ index: path.length - 1, metersFromStart: 0, instruction: 'Вы прибыли в точку Б', kind: 'arrive' }];
  const result: Maneuver[] = [{ index: 0, metersFromStart: 0, instruction: 'Двигайтесь прямо', kind: 'straight' }];
  const peaks: { index: number; metres: number; angle: number }[] = [];
  for (let i = 1; i < path.length - 1; i++) {
    const metres = data.cumulative[i];
    // Looking 20 m either side suppresses noisy short segments and gentle road bends.
    const before = atDistance(path, data.cumulative, metres - 20);
    const after = atDistance(path, data.cumulative, metres + 20);
    if (distance(before, path[i]) < 3 || distance(path[i], after) < 3) continue;
    const angle = longitudeDelta(bearing(path[i], after) - bearing(before, path[i]));
    if (Math.abs(angle) < 38) continue;
    const previous = peaks[peaks.length - 1];
    // A densely sampled corner yields several candidates: retain its strongest point.
    if (previous && metres - previous.metres < 32 && Math.sign(previous.angle) === Math.sign(angle)) {
      if (Math.abs(angle) > Math.abs(previous.angle)) peaks[peaks.length - 1] = { index: i, metres, angle };
    } else peaks.push({ index: i, metres, angle });
  }
  for (const peak of peaks) {
    const kind = Math.abs(peak.angle) >= 150 ? 'uturn' : peak.angle > 0 ? 'right' : 'left';
    result.push({
      index: peak.index, metersFromStart: peak.metres, kind,
      instruction: kind === 'uturn' ? 'Развернитесь' : kind === 'right' ? 'Поверните направо' : 'Поверните налево',
    });
  }
  result.push({ index: path.length - 1, metersFromStart: data.total, instruction: 'Вы прибыли в точку Б', kind: 'arrive' });
  return result;
}

/**
 * Project an actual GPS fix on a route. previousProgress only resolves near-equal
 * candidates at crossings; it does not fabricate forward motion or lock the route.
 * Empty or malformed paths return valid:false and finite, neutral distances.
 */
export function projectOnRoute(position: LatLng, path: LatLng[], previousProgress?: number): RouteProjection {
  const invalid: RouteProjection = {
    point: validPoint(position) ? [...position] : [0, 0], segmentIndex: -1,
    progressMeters: 0, remainingMeters: 0, offRouteMeters: 0, totalMeters: 0, valid: false,
  };
  const data = pathData(path);
  if (!validPoint(position) || !data) return invalid;
  if (path.length === 1 || data.total < 0.1) return {
    point: [...path[0]], segmentIndex: 0, progressMeters: 0, remainingMeters: 0,
    offRouteMeters: distance(position, path[0]), totalMeters: data.total, valid: true,
  };
  let best: RouteProjection | null = null;
  let bestScore = Infinity;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i], b = path[i + 1];
    const cosLat = Math.max(1e-8, Math.cos(((a[0] + b[0] + position[0]) / 3) * RAD));
    const ax = longitudeDelta(a[1] - position[1]) * RAD * EARTH_RADIUS * cosLat;
    const ay = (a[0] - position[0]) * RAD * EARTH_RADIUS;
    const bx = longitudeDelta(b[1] - position[1]) * RAD * EARTH_RADIUS * cosLat;
    const by = (b[0] - position[0]) * RAD * EARTH_RADIUS;
    const dx = bx - ax, dy = by - ay, squareLength = dx * dx + dy * dy;
    const t = squareLength ? clamp(-(ax * dx + ay * dy) / squareLength, 0, 1) : 0;
    const point = interpolate(a, b, t);
    const offRouteMeters = distance(position, point);
    const progressMeters = data.cumulative[i] + t * (data.cumulative[i + 1] - data.cumulative[i]);
    // At most a 5 m bias: a clearly closer segment always wins after a real move.
    const tieBreak = Number.isFinite(previousProgress) ? Math.min(5, Math.abs(progressMeters - previousProgress!) * 0.015) : 0;
    const score = offRouteMeters + tieBreak;
    if (score < bestScore) {
      bestScore = score;
      best = { point, segmentIndex: i, progressMeters, remainingMeters: Math.max(0, data.total - progressMeters), offRouteMeters, totalMeters: data.total, valid: true };
    }
  }
  return best ?? invalid;
}

export function navigationSnapshot(position: LatLng, path: LatLng[], maneuvers?: Maneuver[], previousProgress?: number) {
  const projection = projectOnRoute(position, path, previousProgress);
  const end = path[path.length - 1];
  const arrived = projection.valid && projection.remainingMeters <= 25 && projection.offRouteMeters <= 35 && distance(position, end) <= 35;
  const steps = maneuvers ?? buildManeuvers(path);
  const nextManeuver = projection.valid ? steps.find(step => step.kind !== 'straight' && step.metersFromStart >= projection.progressMeters - 6)
    ?? steps[steps.length - 1] ?? null : null;
  const metersToManeuver = nextManeuver ? Math.max(0, nextManeuver.metersFromStart - projection.progressMeters) : 0;
  const instruction = !projection.valid ? 'Маршрут недоступен' : arrived ? 'Вы прибыли в точку Б'
    : nextManeuver?.kind === 'arrive' ? 'Продолжайте движение к точке Б' : nextManeuver?.instruction ?? 'Двигайтесь прямо';
  return { ...projection, nextManeuver, instruction, metersToManeuver, arrived };
}
