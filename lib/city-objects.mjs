// Landscaping the admin draws by hand: paving, lawns, a fountain basin, a flagpole and park details.
// Shared by the browser, the local API and the verification scripts.
/* The geometries each kind may take. A square or a lawn is either an outline or a strip drawn
   along a line with a width, the way a walkway is. */
const SHAPES = {
  path: ['LineString'], square: ['Polygon', 'LineString'], lawn: ['Polygon', 'LineString'], fountain: ['Polygon'],
  flag: ['Point'], monument: ['Point'], lamp: ['Point'], bench: ['Point'], tree: ['Point'], bin: ['Point'],
};
export const CITY_KINDS = Object.keys(SHAPES);
export const SURFACES = ['tiles', 'plain', 'asphalt'];
/* The sizes each kind may carry, as [lowest, highest, default]. A size without a default stays
   out until the admin sets it, and the map derives it from the others. */
export const CITY_SIZES = {
  path: { width: [0.5, 30, 3] },
  square: { width: [0.5, 100] },
  lawn: { width: [0.5, 100] },
  flag: { height: [3, 80, 12], thickness: [0.05, 2], length: [0.5, 30], rotation: [0, 360] },
  monument: { height: [1, 40, 4], width: [0.3, 20, 1.5], rotation: [0, 360] },
  lamp: { height: [2, 15, 5], rotation: [0, 360] },
  bench: { length: [0.8, 10, 1.8], rotation: [0, 360] },
  tree: { height: [1, 30, 6], width: [0.5, 20] },
};
const LABELS = { width: 'Ширина', height: 'Высота', length: 'Длина', thickness: 'Толщина', rotation: 'Направление' };
const numeric = (value, label, min, max) => { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Некорректное поле: ${label}`); return value; };
const present = value => value !== undefined && value !== null && value !== '';
const position = value => {
  if (!Array.isArray(value) || value.length !== 2) throw new Error('Некорректная точка');
  return [numeric(value[0], 'Долгота', 66, 76.5), numeric(value[1], 'Широта', 35.5, 42)];
};

export function validateCityObject(input) {
  if (!input || typeof input !== 'object') throw new Error('Некорректный объект');
  const id = input.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 150 || !/^[\p{L}\p{N}_./:-]+$/u.test(id) || ['__proto__', 'constructor', 'prototype'].includes(id)) throw new Error('Некорректный ID');
  const kind = input.kind;
  if (typeof kind !== 'string' || !Object.hasOwn(SHAPES, kind)) throw new Error('Некорректный тип объекта');
  const name = input.name ?? '';
  if (typeof name !== 'string' || name.length > 200 || /[<>]|\p{Cc}/u.test(name)) throw new Error('Некорректное название');
  const geometry = input.geometry;
  if (!geometry || !SHAPES[kind].includes(geometry.type)) throw new Error('Нарисуйте объект на карте');
  const type = geometry.type;
  let coordinates;
  if (type === 'Point') coordinates = position(geometry.coordinates);
  else if (type === 'LineString') {
    if (!Array.isArray(geometry.coordinates) || geometry.coordinates.length < 2 || geometry.coordinates.length > 500) throw new Error('У линии должно быть от 2 до 500 точек');
    coordinates = geometry.coordinates.map(position);
  } else {
    const ring = Array.isArray(geometry.coordinates) && geometry.coordinates.length === 1 ? geometry.coordinates[0] : null;
    if (!Array.isArray(ring) || ring.length < 4 || ring.length > 2000) throw new Error('У контура должно быть от 3 углов');
    coordinates = [ring.map(position)];
    const first = coordinates[0][0], last = coordinates[0].at(-1);
    if (first[0] !== last[0] || first[1] !== last[1]) throw new Error('Контур должен быть замкнут');
  }
  if (JSON.stringify(coordinates).length > 100000) throw new Error('Слишком сложный объект');
  const result = { id: id.trim(), kind, name: name.trim(), geometry: { type, coordinates }, updatedAt: Date.now() };
  for (const [key, [min, max, fallback]] of Object.entries(CITY_SIZES[kind] ?? {})) {
    if (present(input[key])) result[key] = numeric(input[key], LABELS[key], min, max);
    else if (fallback !== undefined) result[key] = fallback;
  }
  // A strip is nothing without its width; an outline has no use for one.
  if (type === 'LineString' && !('width' in result)) result.width = 3;
  if (type === 'Polygon') delete result.width;
  if (kind === 'path' || kind === 'square') {
    const surface = present(input.surface) ? input.surface : 'tiles';
    if (!SURFACES.includes(surface)) throw new Error('Некорректное покрытие');
    result.surface = surface;
  }
  return result;
}

/** True when an outline is too thin to be an area: under a quarter square metre, or narrower on
    average (twice the area over the perimeter) than 30 cm — corners tapped along one line. */
export function isNarrowOutline(ring) {
  if (!Array.isArray(ring) || ring.length < 3) return true;
  const [lon0, lat0] = ring[0], east = 111320 * Math.cos(lat0 * Math.PI / 180), north = 110540;
  const points = ring.map(([lon, lat]) => [(lon - lon0) * east, (lat - lat0) * north]);
  let area = 0, perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i], [bx, by] = points[(i + 1) % points.length];
    area += ax * by - bx * ay;
    perimeter += Math.hypot(bx - ax, by - ay);
  }
  area = Math.abs(area) / 2;
  return area < 0.25 || 2 * area / perimeter < 0.3;
}

/** Firestore cannot hold nested arrays, so the geometry travels as a JSON string. */
export function encodeCloudCityObject(input) {
  const value = validateCityObject(input);
  return { ...value, geometry: { type: value.geometry.type, coordinatesJson: JSON.stringify(value.geometry.coordinates) } };
}

export function decodeCloudCityObject(input) {
  const json = input?.geometry?.coordinatesJson;
  if (typeof json !== 'string' || json.length > 100000) throw new Error('Некорректный облачный объект благоустройства');
  let coordinates;
  try { coordinates = JSON.parse(json); } catch { throw new Error('Не удалось прочитать объект благоустройства'); }
  const result = validateCityObject({ ...input, geometry: { type: input.geometry.type, coordinates } });
  if (Number.isFinite(input.updatedAt)) result.updatedAt = input.updatedAt;
  return result;
}
