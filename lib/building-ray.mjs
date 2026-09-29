// Which building a tap lands on when the map is tilted. The tapped pixel is a line of sight from the
// camera down to the ground, and a building is hit where that line first enters the solid it stands up
// as: walls from the ground to their top, and a pitched roof above them where the map draws one.
//
// Pure geometry without MapLibre, so the node checks can run it (scripts/check-building-pick.mjs).
// Points are [east, north] metres in a metricFrame(); the camera is [east, north, up] in the same metres,
// and a line of sight runs from the camera (t = 0) to the ground point it lands on (t = 1).

/** The circumference MapLibre gives the earth, in metres. */
export const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6371008.8;
/** How much of its tightest rectangle a footprint must fill to carry a pitched roof, as the map decides. */
export const ROOF_FILL = 0.8;
/** Roofs are pitched at 30 degrees and rise at most 8 m above their walls, as the map builds them. */
export const ROOF_PITCH = Math.tan(30 * Math.PI / 180);
export const ROOF_CAP = 8;

/** lon/lat to Web Mercator world units, 0..1 across the world with y growing southwards. */
export function mercator(lon, lat) {
  return [(lon + 180) / 360, (180 - 180 / Math.PI * Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360];
}

/** [lon, lat] -> [east, north] metres from the origin, on the renderer's own scale at `scaleLat`: MapLibre
    measures heights at the latitude of the map's centre, so horizontal metres must use that latitude too. */
export function metricFrame(originLon, originLat, scaleLat = originLat) {
  const [ox, oy] = mercator(originLon, originLat), k = EARTH_CIRCUMFERENCE * Math.cos(scaleLat * Math.PI / 180);
  return point => {
    const [x, y] = mercator(point[0], point[1]);
    return [(x - ox) * k, (oy - y) * k];
  };
}

export function closeRing(ring) {
  if (!ring.length) return ring;
  const first = ring[0], last = ring[ring.length - 1];
  return first[0] === last[0] && first[1] === last[1] ? ring : [...ring, first];
}

/** Average of the corners, the closing corner counted once: exactly how page.tsx's house index finds a
    house's middle, so a tapped house and the same house found by search share one place id. */
export function ringCentre(ring) {
  const closed = closeRing(ring), n = Math.max(1, closed.length - 1);
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += closed[i][0]; y += closed[i][1]; }
  return [x / n, y / n];
}

/** Even-odd test over an outline and its courtyards (or any rings); open or closed rings both work. */
function inside(x, y, rings) {
  let within = false;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) within = !within;
    }
  }
  return within;
}
export function insideRing(point, ring) { return inside(point[0], point[1], [ring]); }
export function insideRings(point, rings) { return inside(point[0], point[1], rings); }

/** How far along the line of sight from `camera` [x, y, z] to `ground` [x, y] (height 0) it first enters the
    solid standing on `rings` (an outline, then any courtyards) from `base` to `top` metres: 0 at the camera,
    1 on the ground, null when it passes by. A camera inside the solid sees none of it (walls are drawn facing
    out), so that is null too. */
export function raySolid(camera, ground, rings, base, top) {
  const cx = camera[0], cy = camera[1], cz = camera[2], gx = ground[0], gy = ground[1];
  if (!(cz > 0) || !(top > base) || !rings.length || rings[0].length < 3) return null;
  // The stretch of the line between the heights of the roof and of the base.
  const t0 = Math.max(0, 1 - top / cz), t1 = Math.min(1, 1 - base / cz);
  if (!(t0 <= t1)) return null;
  const ax = cx + (gx - cx) * t0, ay = cy + (gy - cy) * t0;
  if (inside(ax, ay, rings)) return t0 > 0 ? t0 : null; // in through the roof
  const dx = (gx - cx) * (t1 - t0), dy = (gy - cy) * (t1 - t0);
  let first = Infinity;
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const px = ring[j][0], py = ring[j][1], ex = ring[i][0] - px, ey = ring[i][1] - py;
      const cross = dx * ey - dy * ex;
      if (!cross) continue; // parallel, or the closing corner repeated
      const s = ((px - ax) * ey - (py - ay) * ex) / cross, u = ((px - ax) * dy - (py - ay) * dx) / cross;
      if (s >= 0 && s <= 1 && u >= 0 && u <= 1 && s < first) first = s;
    }
  }
  return first === Infinity ? null : t0 + first * (t1 - t0); // in through a wall
}
/** raySolid for a single outline. */
export function rayPrism(camera, ground, ring, base, top) { return raySolid(camera, ground, [ring], base, top); }

/** The tightest rectangle around a footprint in metres and how much of it the footprint fills, with the long
    side first, so a ridge runs along the building. The same fit the map gives a pitched roof. */
export function roofBox(ring) {
  const last = ring.length - 1;
  const points = last > 0 && ring[0][0] === ring[last][0] && ring[0][1] === ring[last][1] ? ring.slice(0, last) : ring;
  if (points.length < 3) return null;
  // Convex hull by monotone chain: the tightest rectangle has a side along one of its edges.
  const sorted = [...points].sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const turn = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const chain = list => {
    const kept = [];
    for (const point of list) {
      while (kept.length >= 2 && turn(kept[kept.length - 2], kept[kept.length - 1], point) <= 0) kept.pop();
      kept.push(point);
    }
    return kept.slice(0, -1);
  };
  const hull = [...chain(sorted), ...chain([...sorted].reverse())];
  if (hull.length < 3) return null;
  let best = null, bestArea = Infinity;
  for (let i = 0; i < hull.length; i++) {
    const [ax, ay] = hull[i], [bx, by] = hull[(i + 1) % hull.length], length = Math.hypot(bx - ax, by - ay);
    if (!length) continue;
    const ux = (bx - ax) / length, uy = (by - ay) / length;
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [x, y] of hull) {
      const u = x * ux + y * uy, v = y * ux - x * uy;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const area = (maxU - minU) * (maxV - minV);
    if (area >= bestArea) continue;
    bestArea = area;
    const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2, hu = (maxU - minU) / 2, hv = (maxV - minV) / 2;
    const centre = [cu * ux - cv * uy, cu * uy + cv * ux];
    best = hu >= hv ? { centre, along: [ux, uy], half: [hu, hv] } : { centre, along: [-uy, ux], half: [hv, hu] };
  }
  if (!best || !(bestArea > 0)) return null;
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) area += (points[j][0] + points[i][0]) * (points[j][1] - points[i][1]);
  return { ...best, fill: Math.abs(area / 2) / bestArea };
}

/** How far a pitched roof on this rectangle rises above its walls; 0 when the footprint keeps a flat top. */
export function roofRise(box) {
  return box && box.fill >= ROOF_FILL ? Math.min(box.half[1] * ROOF_PITCH, ROOF_CAP) : 0;
}

/** Where the line of sight first meets a pitched roof of `shape` set on walls `base` metres tall and fitted to
    `box` (roofBox of the footprint in the same metres), or null. Gabled roofs have two slopes and upright
    gables; hipped roofs slope on all four sides to a ridge; a pyramid (also a hipped roof on a square) slopes
    to a point. Each is the set of points under every one of its roof planes, inside the rectangle and above
    `base`, so the line enters it where the last of those half-spaces lets it in. */
export function rayRoof(camera, ground, box, shape, base) {
  const rise = roofRise(box), cz = camera[2];
  if (!(rise > 0) || !(cz > 0)) return null;
  const [ox, oy] = box.centre, [ex, ey] = box.along, [a, b] = box.half;
  if (!(a > 0) || !(b > 0)) return null;
  // The line in the roof's own frame: u along the ridge, v across it, z up; each is linear in t.
  const cu = (camera[0] - ox) * ex + (camera[1] - oy) * ey, cv = (camera[1] - oy) * ex - (camera[0] - ox) * ey;
  const gu = (ground[0] - ox) * ex + (ground[1] - oy) * ey, gv = (ground[1] - oy) * ex - (ground[0] - ox) * ey;
  const du = gu - cu, dv = gv - cv, dz = -cz;
  let lo = 0, hi = 1;
  // Keep the part of [lo, hi] where alpha + beta * t <= 0.
  const keep = (alpha, beta) => {
    if (beta === 0) { if (alpha > 0) hi = -Infinity; return; }
    const t = -alpha / beta;
    if (beta > 0) { if (t < hi) hi = t; } else if (t > lo) lo = t;
  };
  keep(cu - a, du); keep(-cu - a, -du); keep(cv - b, dv); keep(-cv - b, -dv);
  keep(base - cz, -dz);
  // Under the plane base + rise * (c0 + cU * u + cV * v).
  const under = (c0, cU, cV) => keep(cz - base - rise * (c0 + cU * cu + cV * cv), dz - rise * (cU * du + cV * dv));
  under(1, 0, -1 / b); under(1, 0, 1 / b);
  if (shape === 'hipped' && a - b > 0.05) { under(a / b, -1 / b, 0); under(a / b, 1 / b, 0); }
  else if (shape !== 'gabled') { under(1, -1 / a, 0); under(1, 1 / a, 0); }
  // At 0 the camera itself would be inside the roof.
  return lo <= hi && lo > 0 ? lo : null;
}

/** Floors in a wall `height` metres tall: the inverse of levels * 3 + 1, which the map and the house builder use. */
export function floorsOf(height) { return height >= 4 ? Math.max(1, Math.round((height - 1) / 3)) : 0; }

/** '1 этаж', '3 этажа', '13 этажей'. */
export function floorsLabel(n) {
  const tens = n % 100, ones = n % 10;
  const word = ones === 1 && tens !== 11 ? 'этаж' : ones >= 2 && ones <= 4 && (tens < 12 || tens > 14) ? 'этажа' : 'этажей';
  return `${n} ${word}`;
}
