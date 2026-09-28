// Shared by the browser, local API and verification scripts.
const numeric = (value, label, min, max) => { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Некорректное поле: ${label}`); return value; };
const present = value => value !== undefined && value !== null && value !== '';
const floors = value => { const result = numeric(value, 'Этажей', 1, 60); if (!Number.isInteger(result)) throw new Error('Этажность должна быть целым числом'); return result; };
/** Roof shapes the map can draw; a flat roof is simply the absence of one. */
export const ROOF_SHAPES = ['gabled', 'hipped', 'pyramidal'];
const pitched = value => present(value) && value !== 'flat';
const roofShape = value => { if (!ROOF_SHAPES.includes(value)) throw new Error('Некорректная форма крыши'); return value; };
/** A shipped footprint: `ms:<index>` in the Microsoft set, `osm:way/<id>` from OpenStreetMap. */
export function buildingKey(value) {
  if (typeof value !== 'string' || value.length > 150 || !/^(ms:\d+|osm:(way|relation)\/\d+)$/.test(value)) throw new Error('Некорректный ID здания');
  return value;
}
/** Floors, a height or a roof for a shipped footprint; at least one of them. */
export function validateBuildingInfo(input) {
  if (!input || typeof input !== 'object') throw new Error('Некорректные данные здания');
  const result = { key: buildingKey(input.key), updatedAt: Date.now() };
  if (present(input.levels)) result.levels = floors(input.levels);
  if (present(input.height)) result.height = numeric(input.height, 'Высота', 1, 500);
  if (pitched(input.roof)) result.roof = roofShape(input.roof);
  if (!('levels' in result) && !('height' in result) && !('roof' in result)) throw new Error('Укажите этажность, высоту или крышу');
  return result;
}
export function validateBuilding(input) {
  if (!input || typeof input !== 'object') throw new Error('Некорректное здание');
  const id = input.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 150 || !/^[\p{L}\p{N}_./:-]+$/u.test(id) || ['__proto__','constructor','prototype'].includes(id)) throw new Error('Некорректный ID');
  const name = input.name ?? '';
  if (typeof name !== 'string' || name.length > 200 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(name)) throw new Error('Некорректное название здания');
  const geometry = input.geometry;
  if (!geometry || geometry.type !== 'Polygon' || !Array.isArray(geometry.coordinates) || !geometry.coordinates.length || geometry.coordinates.length > 20) throw new Error('Укажите контур здания');
  let total = 0;
  const coordinates = geometry.coordinates.map(ring => {
    if (!Array.isArray(ring) || ring.length < 4 || (total += ring.length) > 2000) throw new Error('Некорректный контур здания');
    const result = ring.map(point => { if (!Array.isArray(point) || point.length !== 2) throw new Error('Некорректная вершина'); return [numeric(point[0], 'Долгота', 66, 76.5), numeric(point[1], 'Широта', 35.5, 42)]; });
    if (result[0][0] !== result.at(-1)[0] || result[0][1] !== result.at(-1)[1]) throw new Error('Контур здания должен быть замкнут');
    return result;
  });
  if (JSON.stringify(coordinates).length > 100000) throw new Error('Слишком сложный контур здания');
  const result = { id: id.trim(), name: name.trim(), geometry: { type: 'Polygon', coordinates }, source: 'admin', updatedAt: Date.now() };
  if (present(input.height)) result.height = numeric(input.height, 'Высота', 0, 1000);
  if (present(input.levels)) result.levels = floors(input.levels);
  if (pitched(input.roof)) result.roof = roofShape(input.roof);
  return result;
}
export function encodeCloudBuilding(input) {
  const value = validateBuilding(input);
  return { ...value, geometry: { type: 'Polygon', coordinatesJson: JSON.stringify(value.geometry.coordinates) } };
}
export function decodeCloudBuilding(input) {
  if (!input || input.geometry?.type !== 'Polygon' || typeof input.geometry.coordinatesJson !== 'string' || input.geometry.coordinatesJson.length > 100000) throw new Error('Некорректный облачный контур здания');
  let coordinates;
  try { coordinates = JSON.parse(input.geometry.coordinatesJson); } catch { throw new Error('Не удалось прочитать контур здания'); }
  const result = validateBuilding({ ...input, geometry: { type: 'Polygon', coordinates } });
  if (Number.isFinite(input.updatedAt)) result.updatedAt = input.updatedAt;
  return result;
}
