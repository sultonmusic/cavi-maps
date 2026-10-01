# Firebase URL, GitHub map traffic

Цель: адрес `https://capline-group-maps.web.app` остаётся в строке браузера, а карта, код приложения и её данные загружаются внутри iframe с GitHub Pages. Firebase обслуживает только маленький HTML/JS слой. Это не redirect и не прокси карты через Firebase. Геолокация делегирована карте; браузер может запросить обычное разрешение GPS.

Слой передаёт координатные ссылки в карту и безопасно получает обратно изменения центра, обновляя адрес Firebase. Сообщения проверяются по origin и окну iframe; входные координаты проверяются. Встраиваемый источник задаётся при сборке, а не URL-параметром посетителя.

## Состояние

- Новое Firebase projectId: `cavi-maps`, аккаунт `caplinegroup.tj@gmail.com`.
- Желаемый Hosting site ID: `capline-group-maps`. Доступность имени ещё не подтверждена: сайт не создан и deploy не выполнен.
- Сейчас source: `https://sultonmusic.github.io/cavi-maps/`, потому что `Capline-group/Maps` недоступен текущему GitHub connector (404). Перенос репозитория не выполнен.
- Этот профиль не переносит Firestore, Authentication или backend API. Встроенная текущая карта продолжает пользоваться своей исходной runtime-конфигурацией; Firebase Hosting слой лишь меняет публичный адрес и распределение трафика.
- Cloud Shell в браузере Firebase не открылся: сначала `Site Unavailable`, после одной попытки восстановления `Something went wrong while loading Cloud Shell`. Локальная Firebase CLI тоже не имеет авторизованного аккаунта. Поэтому публикацию нужно продолжить там, где CLI авторизована, например на компьютере владельца.

## Публикация на компьютере владельца

После загрузки актуального репозитория откройте терминал в его папке. Нужен Node 22+.

```sh
npx --yes firebase-tools login --reauth
npx --yes firebase-tools login:list
```

В официальном окне Google выберите **caplinegroup.tj@gmail.com**; убедитесь, что CLI показывает нужный аккаунт. Не отправляйте пароль, auth-коды или токены в чат и не сохраняйте их в GitHub.

```sh
node scripts/build-firebase-shell.mjs
npx --yes firebase-tools hosting:sites:create capline-group-maps --project cavi-maps
npx --yes firebase-tools deploy --only hosting --config firebase.shell.json --project cavi-maps
```

Если имя занято, создание сообщит об этом. Если сайт уже создан в этом же проекте, повторное создание не нужно: проверьте `npx --yes firebase-tools hosting:sites:list --project cavi-maps`, затем выполните deploy. Если выбран другой site ID, поменяйте только `hosting.site` в firebase.shell.json. Домены нельзя записывать со слешем: `Capline-Group/Maps.web.app` не является допустимым hostname.

После успешного deploy CLI должна подтвердить URL. Откройте его, дождитесь карты, проверьте движение карты и координатный URL, мобильный экран и GPS. Если iframe недоступен, страница покажет ожидание и кнопку повторной загрузки; Firebase слой сам не является копией данных карты. Полная автономная работа доступна исходной карте при сохранённых данных; этот слой требует отдельной проверки offline в целевом браузере и не обещает автономной работы.

## После переноса GitHub

Сначала подтвердите работающий Pages адрес новой копии. Задайте его через `MAPS_SOURCE_URL` перед сборкой (переменная окружения, URL с завершающим `/`). Затем повторите Firebase deploy. Заголовки firebase.shell.json разрешают два источника: sultonmusic.github.io и capline-group.github.io. При другом owner необходимо осознанно обновить frame-src и Permissions-Policy. GitHub Pages не является безлимитным CDN; ограничения и политика использования описаны в MAPS-API.md.

## Проверки

`node --test tests/firebase-shell.test.mjs` проверяет передачу координат, сохранение Firebase origin, отбрасывание сообщений чужого окна/origin и невозможность сменить источник query-параметром.
