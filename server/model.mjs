import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
export { validateBuilding, validateBuildingInfo, buildingKey } from '../lib/building-data.mjs';
export { validateCityObject } from '../lib/city-objects.mjs';
import { isLanes } from '../lib/lanes.mjs';

const scrypt = promisify(scryptCallback);
export const emptyState = () => ({ roads: {}, districts: {}, businesses: [], buildings: [], buildingInfo: {}, cityObjects: [], reviews: [] });
export const publicState = state => ({ ...state, businesses: state.businesses.filter(x => x.published), reviews: state.reviews.filter(x => x.status === 'approved' && state.businesses.some(b => b.id === x.businessId && b.published && b.reviewsEnabled)) });
export function text(value, label, max = 200, optional = false) {
  if (optional && (value === undefined || value === null || value === '')) return '';
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f<>]/.test(value)) throw new Error(`Некорректное поле: ${label}`);
  return value.trim();
}
export function id(value) { const result = text(value, 'ID', 150); if (!/^[\p{L}\p{N}_./:-]+$/u.test(result) || ['__proto__','constructor','prototype'].includes(result)) throw new Error('Некорректный ID'); return result; }
const bool = (value, label) => { if (typeof value !== 'boolean') throw new Error(`Некорректное поле: ${label}`); return value; };
const number = (value, label, min, max) => { if (!Number.isFinite(value) || value < min || value > max) throw new Error(`Некорректное поле: ${label}`); return value; };
export function validateRoad(input) {
  const result = { roadId: id(input.roadId), updatedAt: Date.now() };
  if ('name' in input) result.name = text(input.name, 'Название дороги', 200);
  if ('asphalt' in input) { if (input.asphalt !== null && !isLanes(input.asphalt)) throw new Error('Выберите число полос: от 0 до 6'); result.asphalt = input.asphalt; }
  if (!('name' in result) && !('asphalt' in result)) throw new Error('Изменения не указаны');
  return result;
}
export const validateDistrict = input => ({ districtId: id(input.districtId), name: text(input.name, 'Название микрорайона'), updatedAt: Date.now() });
export function validateBusiness(input) {
  const website = text(input.website, 'Сайт', 500, true);
  if (website) { let url; try { url = new URL(website); } catch { throw new Error('Укажите полный адрес сайта'); } if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Сайт должен начинаться с https:// или http://'); }
  const email = text(input.email, 'Email', 250, true);
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Некорректный email');
  if (!Array.isArray(input.menu) || input.menu.length > 100) throw new Error('В меню допускается до 100 позиций');
  return { id: id(input.id), name: text(input.name, 'Название'), lat: number(input.lat, 'Широта', 35.5, 42), lon: number(input.lon, 'Долгота', 66, 76.5), category: text(input.category, 'Категория', 80), info: text(input.info, 'Описание', 5000, true), phone: text(input.phone, 'Телефон', 80, true), email, website, address: text(input.address, 'Адрес', 500, true), hours: text(input.hours, 'Часы работы', 500, true), menu: input.menu.map(item => ({ id: id(item.id), name: text(item.name, 'Позиция меню', 150), price: number(item.price, 'Цена', 0, 10000000), currency: 'TJS', description: text(item.description, 'Описание позиции', 1000, true) })), reviewsEnabled: bool(input.reviewsEnabled, 'Отзывы'), published: bool(input.published, 'Публикация'), updatedAt: Date.now() };
}
export function validateReview(input, state) {
  const businessId = id(input.businessId);
  if (!state.businesses.some(x => x.id === businessId && x.published && x.reviewsEnabled)) throw new Error('Отзывы для этого места отключены');
  const rating = number(input.rating, 'Оценка', 1, 5);
  if (!Number.isInteger(rating)) throw new Error('Оценка должна быть целой');
  return { id: randomBytes(12).toString('hex'), businessId, name: text(input.name, 'Имя', 100), rating, text: text(input.text, 'Отзыв', 2000), status: 'pending', createdAt: Date.now() };
}
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) throw new Error('Пароль должен содержать не менее 8 символов');
  const salt = randomBytes(32).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return { algorithm: 'scrypt', salt, hash: hash.toString('hex') };
}
export async function verifyPassword(password, credentials) {
  if (typeof password !== 'string' || password.length > 1024 || credentials?.algorithm !== 'scrypt' || !/^[a-f0-9]{64}$/.test(credentials.salt ?? '') || !/^[a-f0-9]{128}$/.test(credentials.hash ?? '')) return false;
  const actual = await scrypt(password, credentials.salt, 64);
  return timingSafeEqual(actual, Buffer.from(credentials.hash, 'hex'));
}
