// What a place is, in Russian: the singular word on its card and in the results list, the chip
// (category button) it belongs to, and the everyday words people search it by ("аптека",
// "банкомат", "заправка"). One table for the page, the search and the Node checks; the map's
// pictograms (lib/poi-icons.mjs) keep their own icon table.

/** The category chips above the results, in order. */
export const CHIPS = [
  ['all', 'Все'], ['food', 'Еда'], ['shop', 'Магазины'], ['hotel', 'Отели'], ['health', 'Здоровье'],
  ['fuel', 'АЗС'], ['bank', 'Банки'], ['transport', 'Транспорт'], ['edu', 'Учёба'], ['tourism', 'Досуг'],
];
const CHIP_IDS = new Set(CHIPS.map(([id]) => id));
const CHIP_WORDS = Object.fromEntries(CHIPS.map(([id, label]) => [id, label.toLowerCase()]));

/** Map labels (settlements, streets) by their kind. */
export const PLACE_KIND_LABELS = {
  village: 'Село', hamlet: 'Посёлок', town: 'Город', city: 'Город', neighbourhood: 'Микрорайон',
  district: 'Микрорайон', country: 'Страна', road: 'Улица',
};
/** Businesses the administrator adds, by their category. */
export const BUSINESS_LABELS = {
  food: 'Еда', shop: 'Магазин', hotel: 'Отель', health: 'Здоровье', fuel: 'АЗС',
  tourism: 'Достопримечательность', service: 'Услуги', other: 'Организация',
};

/** Groups of `key: [label, synonyms]` that share a chip ('' = only under «Все»). */
const GROUPS = {
  food: {
    'amenity=restaurant': ['Ресторан', 'ресторан'],
    'amenity=cafe': ['Кафе', 'кафе чайхона кофе'],
    'amenity=fast_food': ['Фастфуд', 'шаурма бургер'],
    'amenity=bar': ['Бар', ''],
    'amenity=pub': ['Паб', 'бар'],
    'amenity=food_court': ['Фудкорт', ''],
    'amenity=ice_cream': ['Мороженое', ''],
  },
  hotel: {
    'tourism=hotel': ['Гостиница', 'гостиница отель'],
    'tourism=guest_house': ['Гостевой дом', 'гостиница'],
    'tourism=hostel': ['Хостел', ''],
    'tourism=motel': ['Мотель', ''],
    'tourism=apartment': ['Апартаменты', 'посуточно квартира'],
  },
  health: {
    'amenity=hospital': ['Больница', 'больница госпиталь'],
    'amenity=clinic': ['Поликлиника', 'клиника'],
    'amenity=pharmacy': ['Аптека', 'аптека лекарства'],
    'amenity=doctors': ['Врач', 'доктор'],
    'amenity=dentist': ['Стоматология', 'стоматолог зубной'],
    'amenity=veterinary': ['Ветеринарная клиника', 'ветеринар'],
    'healthcare=pharmacy': ['Аптека', 'аптека лекарства'],
    'healthcare=hospital': ['Больница', 'больница госпиталь'],
    'healthcare=clinic': ['Поликлиника', 'клиника'],
    'healthcare=doctor': ['Врач', 'доктор'],
    'healthcare=dentist': ['Стоматология', 'стоматолог зубной'],
    'shop=optician': ['Оптика', 'очки'],
  },
  fuel: {
    'amenity=fuel': ['АЗС', 'азс заправка бензин газ'],
    'amenity=charging_station': ['Зарядная станция', 'зарядка электромобиль'],
  },
  bank: {
    'amenity=bank': ['Банк', 'банк'],
    'amenity=atm': ['Банкомат', 'банкомат'],
    'amenity=bureau_de_change': ['Обмен валюты', 'обмен'],
    'amenity=money_transfer': ['Денежные переводы', 'перевод'],
    'amenity=payment_terminal': ['Платёжный терминал', 'терминал оплата'],
    'shop=pawnbroker': ['Ломбард', ''],
  },
  transport: {
    'amenity=bus_station': ['Автостанция', 'автовокзал автобус'],
    'amenity=taxi': ['Стоянка такси', 'такси'],
    'amenity=parking': ['Парковка', 'стоянка'],
    'amenity=car_rental': ['Прокат автомобилей', 'аренда'],
    'amenity=car_wash': ['Автомойка', 'мойка'],
  },
  edu: {
    'amenity=school': ['Школа', ''],
    'amenity=kindergarten': ['Детский сад', ''],
    'amenity=childcare': ['Детский центр', 'детский сад'],
    'amenity=university': ['Университет', 'вуз'],
    'amenity=college': ['Колледж', ''],
    'amenity=language_school': ['Языковая школа', 'курсы'],
    'amenity=driving_school': ['Автошкола', ''],
    'amenity=library': ['Библиотека', ''],
  },
  tourism: {
    'tourism=attraction': ['Достопримечательность', ''],
    'tourism=museum': ['Музей', ''],
    'tourism=viewpoint': ['Смотровая площадка', ''],
    'tourism=artwork': ['Арт-объект', 'памятник скульптура'],
    'tourism=theme_park': ['Парк развлечений', 'аттракционы'],
    'tourism=zoo': ['Зоопарк', ''],
    'tourism=gallery': ['Галерея', ''],
    'tourism=information': ['Туристическая информация', ''],
    'tourism=camp_site': ['Кемпинг', ''],
    'tourism=caravan_site': ['Кемпинг', ''],
    'tourism=picnic_site': ['Место для пикника', ''],
    'tourism=alpine_hut': ['Горный приют', ''],
    'tourism=wilderness_hut': ['Приют', ''],
    'amenity=theatre': ['Театр', ''],
    'amenity=cinema': ['Кинотеатр', 'кино'],
    'amenity=arts_centre': ['Центр искусств', ''],
    'leisure=park': ['Парк', ''],
    'leisure=stadium': ['Стадион', ''],
    'leisure=sports_centre': ['Спортивный центр', 'спорт'],
    'leisure=fitness_centre': ['Фитнес-клуб', 'спортзал фитнес'],
    'leisure=water_park': ['Аквапарк', ''],
    'historic=monument': ['Памятник', ''],
    'historic=memorial': ['Мемориал', 'памятник'],
    'historic=archaeological_site': ['Археологический памятник', 'раскопки'],
    'historic=castle': ['Крепость', ''],
  },
  '': {
    'amenity=place_of_worship': ['Мечеть', 'мечеть храм'],
    'amenity=post_office': ['Почта', ''],
    'amenity=police': ['Полиция', 'милиция'],
    'amenity=townhall': ['Администрация', 'хукумат'],
    'amenity=courthouse': ['Суд', ''],
    'amenity=community_centre': ['Общественный центр', ''],
    'amenity=nightclub': ['Ночной клуб', ''],
    'amenity=toilets': ['Туалет', ''],
    'amenity=drinking_water': ['Питьевая вода', 'вода'],
    'amenity=water_point': ['Питьевая вода', 'вода'],
    'amenity=fountain': ['Фонтан', ''],
    'amenity=shelter': ['Навес', ''],
    'amenity=social_facility': ['Социальная служба', ''],
    'amenity=fire_station': ['Пожарная часть', ''],
    'amenity=nursing_home': ['Дом престарелых', ''],
    'amenity=public_bath': ['Баня', 'хаммом'],
    'amenity=internet_cafe': ['Интернет-кафе', ''],
    'amenity=public_building': ['Общественное здание', ''],
    'amenity=events_venue': ['Банкетный зал', 'тойхона свадьба'],
    'amenity=grave_yard': ['Кладбище', ''],
    'amenity=prison': ['Исправительное учреждение', ''],
    'amenity=studio': ['Студия', ''],
    'amenity=telephone': ['Телефон-автомат', ''],
  },
  shop: {
    'amenity=marketplace': ['Рынок', 'базар'],
    'shop=convenience': ['Продукты', 'магазин'],
    'shop=supermarket': ['Супермаркет', 'продукты'],
    'shop=general': ['Магазин', 'продукты'],
    'shop=kiosk': ['Киоск', ''],
    'shop=clothes': ['Одежда', ''],
    'shop=beauty': ['Салон красоты', ''],
    'shop=car_repair': ['Автосервис', 'сто ремонт'],
    'shop=mobile_phone': ['Телефоны', ''],
    'shop=hairdresser': ['Парикмахерская', 'стрижка'],
    'shop=mall': ['Торговый центр', 'тц молл'],
    'shop=furniture': ['Мебель', ''],
    'shop=car_parts': ['Автозапчасти', ''],
    'shop=bookmaker': ['Букмекер', ''],
    'shop=bakery': ['Пекарня', 'хлеб нон'],
    'shop=electronics': ['Электроника', ''],
    'shop=car': ['Автосалон', ''],
    'shop=confectionery': ['Кондитерская', ''],
    'shop=pastry': ['Кондитерская', ''],
    'shop=chocolate': ['Кондитерская', 'шоколад'],
    'shop=doityourself': ['Стройматериалы', ''],
    'shop=hardware': ['Хозтовары', ''],
    'shop=department_store': ['Универмаг', ''],
    'shop=gift': ['Подарки', ''],
    'shop=greengrocer': ['Овощи и фрукты', ''],
    'shop=books': ['Книги', ''],
    'shop=butcher': ['Мясная лавка', ''],
    'shop=computer': ['Компьютеры', ''],
    'shop=tyres': ['Шины', 'шиномонтаж'],
    'shop=cosmetics': ['Косметика', ''],
    'shop=perfumery': ['Парфюмерия', ''],
    'shop=chemist': ['Бытовая химия', ''],
    'shop=tailor': ['Ателье', ''],
    'shop=alcohol': ['Алкоголь', ''],
    'shop=wine': ['Вино', 'алкоголь'],
    'shop=stationery': ['Канцтовары', ''],
    'shop=ticket': ['Билеты', ''],
    'shop=travel_agency': ['Турагентство', 'туры'],
    'shop=jewelry': ['Ювелирный магазин', ''],
    'shop=shoes': ['Обувь', ''],
    'shop=houseware': ['Товары для дома', ''],
    'shop=variety_store': ['Универсальный магазин', ''],
    'shop=sports': ['Спорттовары', ''],
    'shop=appliance': ['Бытовая техника', ''],
    'shop=toys': ['Игрушки', ''],
    'shop=baby_goods': ['Детские товары', ''],
    'shop=florist': ['Цветы', ''],
    'shop=copyshop': ['Копицентр', ''],
    'shop=photo': ['Фотоателье', 'фото'],
    'shop=pet': ['Зоотовары', ''],
    'shop=farm': ['Фермерские продукты', ''],
    'shop=coffee': ['Кофе', ''],
    'shop=carpet': ['Ковры', ''],
    'shop=massage': ['Массаж', ''],
    'shop=dry_cleaning': ['Химчистка', ''],
  },
};

/** key 'amenity=pharmacy' → [label, chip ('' when only under «Все»), synonyms]. */
export const KINDS = (() => {
  const out = Object.create(null);
  for (const [chip, group] of Object.entries(GROUPS)) {
    for (const [key, [label, words]] of Object.entries(group)) {
      if (key in out) throw new Error(`place-kinds: ${key} is listed twice`);
      out[key] = Object.freeze([label, chip, Object.freeze(words ? words.split(' ') : [])]);
    }
  }
  return Object.freeze(out);
})();

const KEYS = ['amenity', 'shop', 'tourism', 'leisure', 'office', 'craft', 'healthcare', 'historic'];

/** 'amenity=pharmacy', 'business:food' for an administrator's business, or '' for a map object. */
export function kindKey(tags) {
  if (!tags) return '';
  if (tags['atlas:type'] === 'business') return 'business:' + (tags['atlas:category'] || 'other');
  for (const key of KEYS) {
    const value = tags[key];
    if (value) return `${key}=${value}`;
  }
  return '';
}

/** The singular Russian word for one place: «Аптека», «Школа», «Гостевой дом». */
export function kindLabel(tags) {
  if (!tags) return 'Место';
  if (tags['atlas:type'] === 'business') return BUSINESS_LABELS[tags['atlas:category']] || BUSINESS_LABELS.other;
  if (tags.amenity === 'place_of_worship' && tags.religion === 'christian') return 'Церковь';
  const kind = KINDS[kindKey(tags)];
  if (kind) return kind[0];
  if (tags.shop) return 'Магазин';
  if (tags.tourism) return 'Место для туристов';
  if (tags.office) return 'Офис';
  return 'Место';
}

/** Everyday words the place is also found by: its synonyms and its chip's name. */
export function kindWords(tags) {
  const kind = KINDS[kindKey(tags)];
  const words = kind ? [...kind[2]] : [];
  const chip = chipOf(tags);
  if (chip !== 'all') words.push(CHIP_WORDS[chip]);
  return words;
}

/** The chip a place is listed under; 'all' when it belongs to none. */
export function chipOf(tags) {
  if (!tags) return 'all';
  const category = tags['atlas:category'];
  if (category) return CHIP_IDS.has(category) ? category : 'all';
  const kind = KINDS[kindKey(tags)];
  if (kind && kind[1]) return kind[1];
  if (tags.shop) return 'shop';
  if (tags.tourism) return 'tourism';
  return 'all';
}

const LABEL_ZOOM = { city: 12, town: 13, village: 14.5, hamlet: 15, neighbourhood: 15 };
/** How close the map comes when the place is opened from the list. */
export function focusZoom(tags) {
  const type = tags?.['atlas:type'];
  if (type === 'label') return LABEL_ZOOM[tags['atlas:place']] ?? 14.5;
  if (type === 'district') return 15;
  if (type === 'street') return 16;
  if (type === 'route') return 12;
  return 17;
}
