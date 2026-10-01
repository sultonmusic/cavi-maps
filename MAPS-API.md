# Cavi Maps: ссылки, API и перенос

## Ссылка на координаты

`/Capline-Group/Maps/Tajikistan/Dushanbe/38.559772,68.787038?z=16`

Порядок в ссылке: широта, долгота. При перемещении карты адрес обновляется без перезагрузки. На GitHub Pages перед этим путём будет `/cavi-maps/`. Firebase Hosting и локальный Node-сервер имеют правило открытия этих ссылок; GitHub Pages использует существующий 404 fallback. Адрес не является названием GitHub-репозитория.

## Размещение API

GitHub Pages и обычный Firebase Hosting обслуживают статические файлы; Node API там не запускается. Код API работает через `npm start` после `npm ci && npm run build`, на отдельном Node 22+ сервере за HTTPS reverse proxy. Данные карты остаются локальными. Для API нужны исходные `server/`, `public/route-worker.js`, `public/route-rules.js`, `public/road-graph.json` и указанные в нём graph-файлы, а также `dist/` и зависимости.

На сервере задайте:

- `ATLAS_FIREBASE_PROJECT_ID`: ID Firebase проекта карты.
- `ATLAS_ADMIN_UID`: UID разрешённого пользователя Firebase Authentication (не email).
- `ATLAS_ADMIN_ORIGIN`: точный origin админ-панели, например `https://capline-tj-map-admin.web.app`.
- `PORT`: порт Node сервера.

В `public/runtime-config.json` добавьте `apiBaseUrl`, например `https://api.your-domain.example`, и пересоберите frontend. Существующая Firebase конфигурация и администратор карты остаются прежними. В локальном режиме без Firebase работает существующая серверная admin-сессия. Админ API проверяет Firebase ID token и разрешённый UID; браузер отправляет текущий token, пароль не нужен в конфигурации.

В админ-панели откройте **API**. Создайте ключ, задайте название, точные разрешённые origin и лимит 1–600 запросов/мин. Секрет показывается один раз; на backend сохраняется только SHA-256. Отзыв действует сразу, включая кэшированные маршруты. Ключи лежат в `data/api-keys.json`: сохраните этот каталог на постоянном диске и не публикуйте его. Доменный список ограничивает браузерные запросы, но не доказывает подлинность серверных запросов; ключ держите на сервере такси.

## Маршрут для сайта такси

Запрос **с backend сайта такси**:

```js
const response = await fetch(`${process.env.CAVI_API_URL}/api/v1/routes`, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${process.env.CAVI_API_KEY}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    start: [38.559772, 68.787038], // широта, долгота
    end: [38.580000, 68.800000],
    mode: 'car' // car | bike | foot
  })
});
const result = await response.json();
if (!response.ok) throw new Error(result.error);
// Верните result браузеру через собственный endpoint такси.
```

Ответ содержит `routes[0].geometry` (GeoJSON LineString: **долгота, широта**), `distanceMeters`, `durationSeconds`, расстояния привязки `startGap`/`endGap` и `traffic:false`. Время оценочное, без пробок. Неверные точки: 400; неверный ключ: 401; запрещённый origin: 403; маршрут не найден: 422; лимит: 429; заполненная очередь или таймаут: 503. Для 429/503 приходит `Retry-After: 60`.

В браузере сайта такси:

```html
<div id="taxi-map" style="height:480px"></div>
<script src="https://YOUR-MAP-ORIGIN/cavi-sdk.js"></script>
<script>
const map = new CaviMap(document.getElementById('taxi-map'), {
  mapUrl: 'https://YOUR-MAP-ORIGIN/Capline-Group/Maps/Tajikistan/Dushanbe/38.559772,68.787038'
});
// Получите маршрут от своего backend, без API-секрета в браузере:
// map.setRoute(result.routes[0].geometry);
// При удалении виджета: map.destroy();
</script>
```

Для GitHub Pages пути SDK и mapUrl должны включать `/cavi-maps/`. SDK проверяет окно и origin сообщений; карта принимает линии только от указанного родительского origin, проверяет координаты и рисует маршрут. SDK принимает готовую геометрию, не выполняет адресный поиск. Если такси принимает адреса текстом, его backend должен сначала определить координаты; это отдельная интеграция.

## Нагрузка и границы

Расчёт выполняется в отдельном Worker Thread с переиспользованием графа; основной HTTP поток не блокируется. Очередь ограничена 24 ожидающими запросами, один расчёт одновременно, таймаут 60 секунд; кэш до 200 маршрутов на 60 секунд с ограничением памяти. Frontend получает хешированные assets с immutable-кешированием на Firebase. Это защита от перегрузки одного backend, а не измеренная гарантия числа пользователей. Для нескольких реплик нужны общая база ключей, распределённый rate limit и резервирование; файловый backend рассчитан на один процесс с постоянным диском. Перед большой рекламной кампанией выполните нагрузочное тестирование на реальном сервере.

## Перенос на Capline-Group.tj@gmail.com

Самый простой вариант для Firebase — передать доступ к существующему проекту, сохранив ID `capline-tj-map`, данные и адреса сайтов. Владелец текущего проекта должен добавить `Capline-Group.tj@gmail.com` в управление доступом проекта с ролью Owner; получатель принимает приглашение, если оно требуется. Затем проверить доступ к Hosting, Firestore, Authentication и billing, если он используется. Старого владельца удалять только после проверки нового. Email владельца Google Cloud не заменяет автоматически пользователя Firebase Authentication или UID администратора карты.

Если нужен новый Firebase проект, дополнительно нужны его projectId, конфигурация Web App, созданный admin Authentication UID, перенос Firestore, обновление runtime-config.json, `.firebaserc`, hosting site IDs в firebase.json и admin UID в firestore.rules; далее публикация rules и frontend. Нельзя просто заменить email в коде.

Для переноса GitHub репозитория `sultonmusic/cavi-maps` нужен **GitHub username или организация** получателя. Gmail адрес для операции repository transfer недостаточен. После переноса проверить GitHub App доступ, Pages/Actions, deployment secrets и базовый путь. Текущий код не выполняет передачу владения и не удаляет старые ресурсы.

## Проверка

`npm run check`, `npm run build`, `node scripts/check-routing.mjs --real`, `node --test tests/partner-api.test.mjs`.
