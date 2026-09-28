// Lanes of a street, and where a car drives on it. Shared by the map, the admin panel, the local
// API and the verification scripts.
//
// A street's `asphalt` value is 0 for one shared lane, or 1–6 lanes in each direction; on a
// one-way carriageway it is the lanes in its one direction.
export const MAX_LANES = 6;
export const isLanes = value => Number.isInteger(value) && value >= 0 && value <= MAX_LANES;
export const isOneway = tags => ['yes', '1', 'true', '-1'].includes(tags?.oneway) || tags?.junction === 'roundabout';

/** Lanes across the carriageway; 0 for one shared lane. */
export const totalLanes = (asphalt, oneway) => !isLanes(asphalt) || asphalt === 0 ? 0 : oneway ? asphalt : asphalt * 2;

/** Traffic keeps right: the middle of the rightmost lane, in lane widths right of the centre line. */
export function laneShift(asphalt, oneway) {
  const total = totalLanes(asphalt, oneway);
  return total === 0 ? 0 : oneway ? (total - 1) / 2 : asphalt - 0.5;
}

/* Pixels across a two-lane asphalt street by zoom, for the zoomed-out view: wider than life so a
   road stays legible, easing to its true width by zoom 16, where the asphalt is drawn to scale. */
export const ASPHALT_STOPS = [[6, 0.7], [9, 1.3], [11, 2.6], [12, 4.1], [13, 6], [14, 6.5], [15, 7], [16, 7.3]];

/** Metres across a lane, and across one lane both directions share. */
export const LANE_METRES = 3.4;
export const SHARED_METRES = 4.6;
/** Metres across a street's asphalt, kerb to kerb. */
export const carriagewayMetres = (asphalt, oneway) => totalLanes(asphalt, oneway) * LANE_METRES || SHARED_METRES;

const METRES = 111_320;
const distinct = line => line.filter((point, i) => i === 0 || point[0] !== line[i - 1][0] || point[1] !== line[i - 1][1]);
/** A line in metres east and north of its first point, with the way back to degrees. */
function local(line) {
  const [lon0, lat0] = line[0], east = METRES * Math.cos(lat0 * Math.PI / 180);
  return { points: line.map(([lon, lat]) => [(lon - lon0) * east, (lat - lat0) * METRES]), degrees: (x, y) => [lon0 + x / east, lat0 + y / METRES] };
}

/** A line moved `metres` to its right (to its left when negative), its corners mitred. */
export function offsetLine(line, metres) {
  const unique = distinct(line);
  if (unique.length < 2 || !metres) return unique.map(point => [point[0], point[1]]);
  const { points, degrees } = local(unique);
  const right = (a, b) => { const dx = b[0] - a[0], dy = b[1] - a[1], length = Math.hypot(dx, dy); return [dy / length, -dx / length]; };
  return points.map((point, i) => {
    const before = i > 0 ? right(points[i - 1], point) : null, after = i + 1 < points.length ? right(point, points[i + 1]) : null;
    let [nx, ny] = before ?? after;
    if (before && after) {
      const mx = before[0] + after[0], my = before[1] + after[1], length = Math.hypot(mx, my);
      // The mitre lengthens as the corner sharpens, up to twice the offset.
      if (length > 1e-9) { const scale = Math.min(2 / length, 1 / (mx * before[0] + my * before[1])); nx = mx * scale; ny = my * scale; }
    }
    return degrees(point[0] + nx * metres, point[1] + ny * metres);
  });
}

/** A line with its distance from the start at every point, in metres. */
function measure(line) {
  const unique = distinct(line);
  if (unique.length < 2) return null;
  const { points, degrees } = local(unique), along = [0];
  for (let i = 1; i < points.length; i++) along.push(along[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  return { unique, points, degrees, along, total: along[along.length - 1] };
}

/** The stretch of a measured line between two distances along it. */
function cut(measured, from, to) {
  const { unique, points, degrees, along } = measured;
  const at = distance => {
    let i = 1;
    while (i < points.length - 1 && along[i] < distance) i++;
    const t = (distance - along[i - 1]) / (along[i] - along[i - 1]);
    return degrees(points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t);
  };
  const inner = unique.filter((_, i) => along[i] > from && along[i] < to).map(point => [point[0], point[1]]);
  return [at(from), ...inner, at(to)];
}

/** A line with `metres` cut from each end, or null when nothing would be left. */
export function trimLine(line, metres) {
  const measured = measure(line);
  return measured && measured.total > metres * 2 ? cut(measured, metres, measured.total - metres) : null;
}

const bend = (a, b, c) => {
  const cos = Math.cos(b[1] * Math.PI / 180);
  const turn = Math.abs(Math.atan2((c[0] - b[0]) * cos, c[1] - b[1]) - Math.atan2((b[0] - a[0]) * cos, b[1] - a[1])) * 180 / Math.PI;
  return turn > 180 ? 360 - turn : turn;
};

/** A street's asphalt `width` metres across, as polygons: an outline for each stretch between sharp
    bends, and a disc at every bend so the bend comes out round. The ends are rounded to `caps`
    radii: half the width at a dead end, smaller where a narrower street meets it, 0 for a flat end. */
export function ribbon(line, width, caps = [width / 2, width / 2]) {
  const points = distinct(line);
  if (points.length < 2) return [];
  const half = width / 2, polygons = [], discs = [[points[0], caps[0]], [points[points.length - 1], caps[1]]];
  const outline = stretch => {
    const right = offsetLine(stretch, half), left = offsetLine(stretch, -half).reverse();
    polygons.push([[...right, ...left, right[0]]]);
  };
  let start = 0;
  for (let i = 1; i < points.length - 1; i++) {
    if (bend(points[i - 1], points[i], points[i + 1]) <= 50) continue;
    outline(points.slice(start, i + 1));
    discs.push([points[i], half]);
    start = i;
  }
  outline(points.slice(start));
  for (const [[lon, lat], radius] of discs) {
    if (!(radius > 0)) continue;
    const east = METRES * Math.cos(lat * Math.PI / 180);
    const ring = Array.from({ length: 12 }, (_, i) => [lon + Math.cos(i / 6 * Math.PI) * radius / east, lat + Math.sin(i / 6 * Math.PI) * radius / METRES]);
    polygons.push([[...ring, ring[0]]]);
  }
  return polygons;
}

/** Lane lines of a street: dashed between lanes, and a double line down the middle of a two-way
    street with two or more lanes each way. `crossing(point)` is the half width of the widest other
    street through a point of this one: the lines break off 1.5 m before its kerb, and 4 m before a
    dead end, so they stay out of junctions. */
export function laneLines(road, crossing = () => 0) {
  const total = totalLanes(road.asphalt, !!road.oneway), measured = total > 1 ? measure(road.coordinates) : null;
  if (!measured) return [];
  const { unique, along } = measured, last = unique.length - 1, kept = [];
  let from = 0;
  unique.forEach((point, i) => {
    const other = crossing(point), gap = other > 0 ? other + 1.5 : i === 0 || i === last ? 4 : 0;
    if (!gap) return;
    if (along[i] - gap - from > 2) kept.push([from, along[i] - gap]);
    from = Math.max(from, along[i] + gap);
  });
  if (measured.total - from > 2) kept.push([from, measured.total]);
  const lines = [], double = !road.oneway && road.asphalt >= 2;
  for (const [start, end] of kept) {
    const line = cut(measured, start, end);
    for (let slot = 1; slot < total; slot++) {
      if (double && slot * 2 === total) lines.push({ kind: 'centre', coordinates: offsetLine(line, -0.12) }, { kind: 'centre', coordinates: offsetLine(line, 0.12) });
      else lines.push({ kind: 'dash', coordinates: offsetLine(line, (slot - total / 2) * LANE_METRES) });
    }
  }
  return lines;
}
const CELL = 0.0005;
const PAD = 0.0002;
const cellKey = (lon, lat) => `${Math.floor(lon / CELL)}:${Math.floor(lat / CELL)}`;

/** Straight pieces of the streets whose width is known, each with its rightmost lane (in lane
    widths) and its half width (in metres), bucketed by ~50 m. */
export function laneSegments(roads) {
  const index = new Map();
  for (const road of roads) {
    const line = road.coordinates;
    if (!Array.isArray(line)) continue;
    const shift = laneShift(road.asphalt, !!road.oneway), half = carriagewayMetres(road.asphalt, !!road.oneway) / 2;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1], b = line[i], segment = { a, b, shift, half };
      for (let x = Math.floor((Math.min(a[0], b[0]) - PAD) / CELL); x <= Math.floor((Math.max(a[0], b[0]) + PAD) / CELL); x++) {
        for (let y = Math.floor((Math.min(a[1], b[1]) - PAD) / CELL); y <= Math.floor((Math.max(a[1], b[1]) + PAD) / CELL); y++) {
          const key = `${x}:${y}`, list = index.get(key);
          if (list) list.push(segment);
          else index.set(key, [segment]);
        }
      }
    }
  }
  return index;
}

/** The street under a point heading a given way (degrees from north): the rightmost lane and half
    width of the closest street running along the heading within `reach` metres, or null. */
export function laneAt(index, lon, lat, heading, reach = 4) {
  const cos = Math.cos(lat * Math.PI / 180), hx = Math.sin(heading * Math.PI / 180), hy = Math.cos(heading * Math.PI / 180);
  let best = null, closest = reach;
  for (const segment of index.get(cellKey(lon, lat)) ?? []) {
    const { a, b } = segment;
    const ax = (a[0] - lon) * cos * METRES, ay = (a[1] - lat) * METRES;
    const dx = (b[0] - a[0]) * cos * METRES, dy = (b[1] - a[1]) * METRES, length = Math.hypot(dx, dy);
    // Crossing a street is not driving along it.
    if (!length || Math.abs(dx * hx + dy * hy) / length < 0.8) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (length * length)));
    const gap = Math.hypot(ax + dx * t, ay + dy * t);
    if (gap < closest) { closest = gap; best = segment; }
  }
  return best && { shift: best.shift, half: best.half };
}

const bearingOf = (a, b) => (Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI + 360) % 360;

/** The street nearest a point within `reach` metres, whichever way it runs: its direction in degrees
    from north and its half width, or null. */
export function streetAt(index, lon, lat, reach = 4) {
  const cos = Math.cos(lat * Math.PI / 180);
  let best = null, closest = reach;
  for (const segment of index.get(cellKey(lon, lat)) ?? []) {
    const { a, b } = segment;
    const ax = (a[0] - lon) * cos * METRES, ay = (a[1] - lat) * METRES;
    const dx = (b[0] - a[0]) * cos * METRES, dy = (b[1] - a[1]) * METRES, length = dx * dx + dy * dy;
    if (!length) continue;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / length));
    const gap = Math.hypot(ax + dx * t, ay + dy * t);
    if (gap < closest) { closest = gap; best = segment; }
  }
  return best && { bearing: bearingOf(best.a, best.b), half: best.half };
}

/** Every place a [lon, lat] line crosses the centre line of an indexed street: the point, the
    street's direction and its half width. */
export function streetCrossings(index, line) {
  const found = [];
  for (let i = 1; i < line.length; i++) {
    const p = line[i - 1], q = line[i], cos = Math.cos(p[1] * Math.PI / 180);
    const rx = (q[0] - p[0]) * cos * METRES, ry = (q[1] - p[1]) * METRES;
    const steps = Math.max(1, Math.ceil(Math.max(Math.abs(q[0] - p[0]), Math.abs(q[1] - p[1])) / (CELL / 2)));
    const seen = new Set();
    for (let k = 0; k <= steps; k++) {
      for (const segment of index.get(cellKey(p[0] + (q[0] - p[0]) * k / steps, p[1] + (q[1] - p[1]) * k / steps)) ?? []) {
        if (seen.has(segment)) continue;
        seen.add(segment);
        const wx = (segment.a[0] - p[0]) * cos * METRES, wy = (segment.a[1] - p[1]) * METRES;
        const sx = (segment.b[0] - segment.a[0]) * cos * METRES, sy = (segment.b[1] - segment.a[1]) * METRES;
        const cross = rx * sy - ry * sx;
        if (Math.abs(cross) < 1e-9) continue;
        const t = (wx * sy - wy * sx) / cross, u = (wx * ry - wy * rx) / cross;
        if (t < 0 || t > 1 || u < 0 || u > 1) continue;
        found.push({ point: [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t], bearing: bearingOf(segment.a, segment.b), half: segment.half });
      }
    }
  }
  return found;
}

/** A zebra crossing on a street at `point`: white bars half a metre wide and four metres long, one
    every metre across the carriageway, lying the way the street runs (`bearing`). */
export function zebra(point, bearing, half) {
  const [lon, lat] = point, east = METRES * Math.cos(lat * Math.PI / 180), rad = bearing * Math.PI / 180;
  const along = [Math.sin(rad), Math.cos(rad)], across = [Math.cos(rad), -Math.sin(rad)];
  const polygons = [];
  for (let offset = -half + 0.5; offset <= half - 0.5 + 1e-9; offset += 1) {
    const corners = [[-2, -0.25], [2, -0.25], [2, 0.25], [-2, 0.25]].map(([length, width]) => [
      lon + (along[0] * length + across[0] * (offset + width)) / east,
      lat + (along[1] * length + across[1] * (offset + width)) / METRES,
    ]);
    polygons.push([[...corners, corners[0]]]);
  }
  return polygons;
}

/** A [lon, lat] path cut into pieces that each keep one offset: `keep` turns the street under a
    stretch into metres right of its centre line, the rightmost lane unless told otherwise. */
export function lanePieces(index, path, keep = spot => spot ? spot.shift * LANE_METRES : 0) {
  const pieces = [];
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i];
    const heading = Math.atan2((b[0] - a[0]) * Math.cos(a[1] * Math.PI / 180), b[1] - a[1]) * 180 / Math.PI;
    const shift = keep(laneAt(index, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2, heading));
    const last = pieces[pieces.length - 1];
    if (last && last.shift === shift) last.coordinates.push(b);
    else pieces.push({ shift, coordinates: [a, b] });
  }
  return pieces;
}
