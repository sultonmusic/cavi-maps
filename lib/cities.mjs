// Towns of Tajikistan the map can jump to, grouped by region, with the other spellings people type.
// Shared by the city selector, the search (settlements and "near me" sorting), the Profile and the
// Node checks, so it stays plain JavaScript with no browser globals.
//
//   r   half the size of the town's box in degrees of latitude: the search browses inside it and the
//       map calls itself by the town's name while its middle is within about 2.2 r of the centre.

export const REGIONS = ['Вся страна', 'Душанбе и районы республиканского подчинения', 'Согдийская область', 'Хатлонская область', 'ГБАО'];

const [COUNTRY_REGION, CAPITAL, SUGHD, KHATLON, GBAO] = REGIONS;
/** name, lat, lon, zoom, r, aliases */
const ROWS = [
  [COUNTRY_REGION, 'Таджикистан', 38.9, 71.0, 7, null, ['Tajikistan', 'Тоҷикистон']],
  [CAPITAL, 'Душанбе', 38.575, 68.79, 13, 0.13, ['Dushanbe']],
  [CAPITAL, 'Вахдат', 38.561, 69.017, 14, 0.05, ['Vahdat', 'Ваҳдат', 'Кофарнихон']],
  [CAPITAL, 'Гиссар', 38.53, 68.558, 14, 0.05, ['Hisor', 'Ҳисор']],
  [CAPITAL, 'Турсунзаде', 38.514, 68.232, 14, 0.05, ['Tursunzoda', 'Турсунзода', 'Регар']],
  [CAPITAL, 'Рогун', 38.695, 69.757, 14, 0.05, ['Rogun', 'Роғун']],
  [CAPITAL, 'Гарм', 39.027, 70.374, 14, 0.05, ['Gharm', 'Ғарм', 'Рашт']],
  [SUGHD, 'Худжанд', 40.283, 69.623, 13, 0.1, ['Khujand', 'Хуҷанд', "Xo'jand", 'Ходжент', 'Ленинабад']],
  [SUGHD, 'Шайдон', 40.6601966, 70.3597068, 16, 0.06, ['Shaydon', 'Шайдан', 'Ашт']],
  [SUGHD, 'Истаравшан', 39.908, 68.996, 14, 0.05, ['Istaravshan', 'Ура-Тюбе']],
  [SUGHD, 'Канибадам', 40.291, 70.425, 14, 0.05, ['Konibodom', 'Конибодом']],
  [SUGHD, 'Исфара', 40.123, 70.613, 14, 0.05, ['Isfara']],
  [SUGHD, 'Пенджикент', 39.495, 67.61, 14, 0.05, ['Panjakent', 'Панҷакент']],
  [SUGHD, 'Бустон', 40.236, 69.699, 14, 0.04, ['Buston', 'Чкаловск']],
  [SUGHD, 'Гулистон', 40.267, 69.798, 14, 0.04, ['Guliston', 'Кайраккум', 'Қайроққум']],
  [SUGHD, 'Гафуров', 40.222, 69.73, 14, 0.04, ['Ghafurov', 'Ғафуров']],
  [SUGHD, 'Истиклол', 40.566, 69.642, 14, 0.04, ['Istiqlol', 'Табошар']],
  [SUGHD, 'Нау', 40.151, 69.373, 14, 0.04, ['Спитамен', 'Nov']],
  [KHATLON, 'Бохтар', 37.837, 68.78, 13, 0.07, ['Bokhtar', 'Курган-Тюбе', 'Қурғонтеппа']],
  [KHATLON, 'Куляб', 37.914, 69.785, 13, 0.07, ['Kulob', 'Кӯлоб', 'Кулоб']],
  [KHATLON, 'Левакант', 37.872, 68.926, 14, 0.04, ['Levakant', 'Сарбанд']],
  [KHATLON, 'Вахш', 37.716, 68.837, 14, 0.04, ['Vakhsh']],
  [KHATLON, 'Нурек', 38.39, 69.308, 14, 0.05, ['Norak', 'Норак']],
  [KHATLON, 'Дангара', 38.095, 69.332, 14, 0.05, ['Danghara', 'Данғара']],
  [KHATLON, 'Яван', 38.318, 69.047, 14, 0.05, ['Yovon', 'Ёвон']],
  [KHATLON, 'Пяндж', 37.242, 69.095, 14, 0.05, ['Panj', 'Панҷ']],
  [KHATLON, 'Шаартуз', 37.267, 68.144, 14, 0.05, ['Shahrituz', 'Шаҳритус']],
  [KHATLON, 'Кабадиян', 37.406, 68.184, 14, 0.04, ['Qubodiyon', 'Қубодиён']],
  [KHATLON, 'Фархор', 37.493, 69.4, 14, 0.05, ['Farkhor']],
  [GBAO, 'Хорог', 37.49, 71.55, 14, 0.05, ['Khorog', 'Хоруғ']],
  [GBAO, 'Рушан', 37.942, 71.58, 14, 0.04, ['Rushon', 'Вамар']],
  [GBAO, 'Мургаб', 38.171, 73.967, 14, 0.05, ['Murghob', 'Мурғоб']],
];

/** Every entry; the whole country comes first. */
export const CITIES = Object.freeze(ROWS.map(([region, name, lat, lon, zoom, r, aliases]) =>
  Object.freeze({ name, region, lat, lon, zoom, r, aliases: Object.freeze(aliases) })));
export const COUNTRY = CITIES[0];

const BY_NAME = new Map(CITIES.map(city => [city.name, city]));
/** The entry called exactly `name`, e.g. 'Худжанд'. */
export function cityByName(name) {
  return BY_NAME.get(name);
}

const RAD = Math.PI / 180;
function kmBetween(lat1, lon1, lat2, lon2) {
  const dLat = (lat2 - lat1) * RAD, dLon = (lon2 - lon1) * RAD;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(dLon / 2) ** 2;
  return 12742 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** The nearest town, however far, and the distance to it in kilometres. */
export function nearestCity(lat, lon) {
  let best = null, km = Infinity;
  for (const city of CITIES) {
    if (city.r === null) continue;
    const gap = kmBetween(lat, lon, city.lat, city.lon);
    if (gap < km) { km = gap; best = city }
  }
  return best ? { city: best, km } : null;
}

/** The town whose name the map should show with its middle at lat, lon, or null out in the country. */
export function cityAt(lat, lon) {
  const cos = Math.cos(lat * RAD);
  let best = null, shortest = Infinity;
  for (const city of CITIES) {
    if (city.r === null) continue;
    const gap = Math.hypot(lat - city.lat, (lon - city.lon) * cos);
    if (gap < city.r * 2.2 && gap / city.r < shortest) { shortest = gap / city.r; best = city }
  }
  return best;
}

/** Whether lat, lon lies in the town's box. The whole country contains everything. */
export function inCity(city, lat, lon) {
  if (city.r === null) return true;
  return Math.abs(lat - city.lat) < city.r && Math.abs(lon - city.lon) * Math.cos(city.lat * RAD) < city.r;
}
