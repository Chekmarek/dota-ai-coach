# Dota AI Coach

Windows-приложение — коуч Dota 2: подсказки поверх игры во время матча и разборы после смерти и матча.

> **Текущая версия 0.14.0.** Коуч читает данные своего героя через Valve Game State Integration и смотрит на экран
> (мини-карта, верхняя панель, полоски здоровья). Знает стадию игры и вашу позицию 1–5, сравнивает вас с сильными
> игроками рейтинга (STRATZ, Divine–Immortal) и профи (OpenDota) на вашем герое и позиции, советует предметы с поправкой
> на врагов, разбирает смерти по главной причине, помнит ваши повторяющиеся ошибки. Один арбитр решает, что показать:
> не больше двух подсказок сразу, без противоречий, только в матче и когда окно Доты активно.
> Что не умеет и где ошибается — [docs/LIMITATIONS.md](docs/LIMITATIONS.md); изменения — [docs/release-notes](docs/release-notes).

Приложение **не** читает память игры, **не** управляет героем и **не** вмешивается в процесс игры: только GSI и снимок экрана.
Подсказки во время матча включает пользователь; правила Valve о подсказчиках не проверены ([docs/POLICY.md](docs/POLICY.md)).

---

## Для пользователя: установка

Скачайте один из двух файлов (из папки `release\<версия>\`):

| Файл | Что это | Как запустить |
|---|---|---|
| `DotaCoach-Setup-0.2.0.exe` | Установщик | Запустить → выбрать папку → «Установить». Появятся ярлыки на рабочем столе и в «Пуске». Удаление — через «Параметры → Приложения». |
| `DotaCoach-0.2.0-win-x64-portable.zip` | Портативная версия | Распаковать в любую папку → запустить `DotaCoach.exe`. Все настройки хранятся в папке `data` рядом с программой. |

Ничего дополнительно (Node.js, Python и т.п.) ставить не нужно. Требуется Windows 10/11 x64.

**Предупреждение «Windows защитила ваш компьютер».** Программа не подписана платным сертификатом, поэтому SmartScreen её не знает.
Нажмите «Подробнее» → «Выполнить в любом случае».

### Как пользоваться (сейчас)

1. «Разбор записи» → «Папка с кадрами…» (PNG/JPG) или «Видеофайл…» (MP4/WEBM/MKV).
2. «Запустить» — видно превью кадра, фактическую частоту и счётчики.
3. Частоту кадров, лимит обработки и размер кадра можно поменять в «Настройках».

---

## Для разработчика

Требуется Node.js 24+. Проект лежит в `D:\DotaCoach` (латинский путь, вне OneDrive — см. ARCHITECTURE §0).

```powershell
npm install                  # зависимости (кэш npm — в .cache\npm)
node node_modules\electron\install.js   # один раз: скачать Electron (кэш — задайте $env:ELECTRON_CACHE="D:\DotaCoach\.cache\electron")
npm run dev                  # запуск с горячей перезагрузкой
npm test                     # unit-тесты (Vitest)
npm run test:e2e             # сборка + e2e-тесты (Playwright запускает настоящее приложение)
npm run dist                 # установщик + zip в release\<версия>\
npm run fixtures             # пересоздать синтетические тестовые кадры и иконку
npm run train:glyphs         # пересобрать шаблоны символов HUD из tests\fixtures\hud (+ отчёт точности)
npm run kb:import            # обновить базу знаний после нового патча (Valve + OpenDota)
npm run kb:stats             # статистика OpenDota: матчапы, сборки и кривые профи по минутам
npm run kb:stratz            # сильные игроки рейтинга (STRATZ): кривые и покупки по позициям; токен — %USERPROFILE%\.stratz-token.txt
node scripts/extract-map-points.mjs     # точки карты из файлов Доты: руны, Рошан, башни (после патча карты)
node scripts/fetch-shadow-matches.mjs   # про-матчи STRATZ для «режима тени» → .tmp\shadow
$env:DOTACOACH_SHADOW='1'; npx vitest run tests/unit/shadow.test.ts   # «режим тени»: коуч на про-матчах, итог в docs\night
node scripts/train-cooldown.ts          # шаблоны крупных цифр перезарядки способностей (tests\fixtures\cooldown)
```

Иконки предметов (после нового патча — после `kb:import`). Сами картинки Valve лежат только в `.cache\icons`
и в репозиторий не попадают; в проект идут только сжатые шаблоны `src\data\item-templates.json`:

```powershell
node scripts/download-icons.mjs                                         # иконки предметов, способностей, героев
node_modules\electron\dist\electron.exe scripts\icons-to-rgba\main.cjs D:\DotaCoach\.cache\icons\7.41f D:\DotaCoach\.cache\icons\7.41f-rgba
node scripts/make-item-templates.ts                                     # шаблоны 12×9 для инвентаря
```

Проверка собранной портативной версии:

```powershell
Expand-Archive release\0.2.0\DotaCoach-0.2.0-win-x64-portable.zip -DestinationPath .tmp\portable-check
$env:DOTACOACH_PACKAGED_EXE = "D:\DotaCoach\.tmp\portable-check\DotaCoach.exe"; npx playwright test packaged
```

## Выпуск новой версии

Релизы собирает GitHub Actions из ветки `sources` (`.github/workflows/release-sources.yml`):

1. Поднять версию: `npm version 0.7.1 --no-git-tag-version` (меняет `package.json` и `package-lock.json`).
2. Написать, что нового, в `docs/release-notes/v0.7.1.md` (2–5 пунктов по-русски) — коуч покажет это во вкладке «Обновления».
3. Проверить локально: `npm run typecheck`, `npm test`, `npm run test:e2e`. Выпускать, только когда последний прогон
   `checks` (Actions: типы, unit-тесты и e2e на Windows при каждом push в `sources`) зелёный.
4. Закоммитить и запушить в `sources`. GitHub сам проверит типы и тесты, соберёт установщик, zip, `app.asar`
   и `app.asar.sha256` и опубликует релиз `v0.7.1`. Коуч у всех предложит «Установить».

Если версия в `package.json` не поменялась, релиз не создаётся. Ход сборки — на вкладке Actions репозитория.
База знаний (`resources/data/kb`) с 0.9.0 лежит **внутри `app.asar`**, поэтому после `npm run kb:import` достаточно
выпустить новую версию: база придёт всем через автообновление. Копия рядом с программой (`resources\data`) остаётся
для установщика и zip; коуч берёт более новую из двух копий (по `meta.generatedAt`).

Документы: [архитектура](docs/ARCHITECTURE.md) · [ограничения](docs/LIMITATIONS.md) · [политика использования](docs/POLICY.md) · [источники данных](docs/DATA_SOURCES.md).
