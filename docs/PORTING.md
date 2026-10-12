# Dota AI Coach: что перенести в исходники (накопительно с 0.1.0)

Всё сделано и проверено в **собранной** версии 0.1.0 (`out/` из app.asar). Код не минифицирован, имена функций и классов совпадают с исходниками на TypeScript.

- `reference/app/` — рабочая сборка 0.2.0 целиком. Если непонятно, как что-то должно работать, смотри здесь.
- `reference/baseline-0.1.0/` — исходная сборка 0.1.0, от которой считались изменения.
- `diff/*.diff` — изменения 0.1.0 → 0.2.0 по каждому собранному файлу.

## Возможности 0.2.0

1. **Живой захват окна Dota 2.** Движок находит окно, в заголовке которого есть «Dota 2» (без учёта регистра; точное «Dota 2» в приоритете, окна коуча пропускаются). Кадры берутся через `getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId } } })`, запасной путь — `getDisplayMedia` через `setDisplayMediaRequestHandler`. Системного диалога нет. Доступ к игре только на чтение.
2. **Состояния:** `off` / `waiting-dota` / `no-image` / `seeing`. Причины `no-image`: кадров нет 2 с, картинка чёрная 3 с, картинка полностью застыла 10 с. Повторный поиск окна каждые 3 с, переподключение, если кадров нет 15 с. Фатальных ошибок в живом режиме нет.
3. **Разрешение:** permission-обработчик даёт `media` **только окну движка** и только видео. ⚠️ Windows присылает `mediaTypes: []`, поэтому пустой список тоже считается допустимым. Это проверено на настоящей Доте: со строгой проверкой (`length > 0`) коуч Доту не видел.
4. **Вкладка «Живая игра»**, второй пункт меню: статус, подсказки, текст ошибки, список видимых окон, превью, fps, задержка. Автозапуск (`settings.live.autoStart`) срабатывает один раз на каждое подключение к движку (`EngineClient.statusPort`).
5. **Индикаторы.** Пилюля в сайдбаре и на «Обзоре», подпись «живой режим». Значок поверх игры 172×46: прозрачное окно, без фокуса, пропускает клики, `setContentProtection(true)`. Медленные анимации, через 6 с стабильного «видит игру» приглушается до 60%. Учитывает `prefers-reduced-motion`.
6. **Политика:** `live-observe.allowed = true`. Подсказки во время обычных и рейтинговых матчей **остаются выключенными**.
7. **Настройки:** секция `live { autoStart: true, fps: 10, overlay: true, overlayCorner: "top-right" }` в том же tolerant-шаблоне. Старые `settings.json` загружаются без потерь.
8. **Журнал:** `<userData>/live.log` (до 256 КБ, затем `.old`). В нём найденные окна, решения по разрешениям, смены состояния движка, ошибки, проверки обновлений.
9. **Обновление из GitHub Releases** (`updater.js`):
   - репозиторий берётся из поля `updateRepo` в `package.json` (`Chekmarek/dota-ai-coach`);
   - проверка при запуске (через 5 с) и раз в 6 ч;
   - в релизе обязательны ассеты `app.asar` и `app.asar.sha256`;
   - загрузка в `<userData>/updates/app-<версия>.asar.download` с проверкой SHA-256;
   - подмену делает cmd-скрипт после выхода приложения: ждёт PID, сохраняет `app.asar.prev`, копирует с повторами, при сбое откатывает, перезапускает через `explorer.exe` (без прав администратора);
   - если в `resources` нельзя писать (Program Files), скрипт запускается через `resources/elevate.exe` (UAC), запасной путь — PowerShell RunAs;
   - пользователь отказался от UAC → коуч не закрывается и пишет об ошибке;
   - IPC: `update:get`, `update:check`, `update:install` и событие `update:state`. В UI это плашка «⬆ Обновление» в сайдбаре и карточка «Обновления» в Настройках.

## Новые модули → куда в исходниках

| Сборка (`reference/app/`) | Роль | Куда |
|---|---|---|
| `out/main/live.js` | окно Доты, разрешения, IPC движка, значок, `liveLog` | `src/main/live.ts` |
| `out/main/updater.js` | обновления | `src/main/updater.ts` |
| `out/renderer/assets/engine-live.js` | `LiveScreenSource`, `computeLiveState` | рядом с источниками движка |
| `out/preload/overlay.cjs` | preload значка | новая preload-точка `overlay` |
| `out/renderer/overlay/index.html`, `overlay.js` | страница значка | новая renderer-точка `overlay` в electron-vite |
| `out/renderer/assets/ui-live.css` | стили живого режима и обновлений | к стилям UI |

## Правки существующего кода (см. `diff/`)

- **main** (`main-index.diff`): импорты `live`/`updater`; `harden()` → `allowLivePermission`; секция настроек `live` (DEFAULTS, fields, tolerant, patch schema, applySettingsPatch); `live-observe` включён; `onSettingsChanged` в `registerIpc`; `setLiveEngine`/`onLiveEngineGone` в `EngineLink`; `readUpdateRepo()`, `setupLive(...)`, `setupUpdater(...)` в `whenReady`.
- **preload движка**: `dotacoachEngine { findDota, reportLive }`. `findDota` возвращает `{ source, windows }`.
- **preload UI**: `getUpdateState`, `checkForUpdates`, `installUpdate`, `onUpdateState`.
- **движок**: `live:start` / `live:stop` в `uiToEngineSchema`; `LiveScreenSource` в `Pipeline.start`; `events.live`; `status.live`; `reportLive()` (состояние, причина, ошибка).
- **UI**:
  - блоки «Живой захват» и «Обновления» (между маркерами `// =====`);
  - `PAGES`: пункт `live`;
  - `App`: автозапуск, `LivePill`, `UpdateNotice`;
  - `EngineClient.statusPort`;
  - тексты `Dashboard`, `ReplayMode`, `VisionDiagnostics`;
  - карточки `LiveSettingsCard` и `UpdateCard` в `AppSettings`;
  - `ui-live.css` в `renderer/index.html`.
- **package.json**: `version` 0.2.0 и `updateRepo`.

## Как это проверено

- Тесты main на заглушке Electron: настройки, политика, разрешения, поиск окна, значок, падение движка, журнал, проверка обновлений (новая и та же версия, офлайн, недоверенный отправитель).
- E2E в Chromium: настоящий UI и движок, вместо окна Доты — canvas-поток. Все переходы состояний, ручной старт и стоп, настройки, карточка и плашка обновлений. Ошибок в консоли нет.
- На настоящей Доте (Windows, Electron 44): окно находится меньше чем за секунду, статус «Видит игру».

## 0.3.0

Изменения 0.3.0 считай по истории git: `git diff v0.2.0 v0.3.0 -- app/`.

- `updater.js`: список `/releases?per_page=10` вместо `/releases/latest`; в состоянии появились `history` и `checkedAt`.
- UI:
  - блок «Обновления» переписан: `UpdatesPage`, `UpdateBanner`, `UpdateToast`, `ReleaseNotes`;
  - пункт `updates` в `PAGES` перед «Настройками»;
  - в навигации красная точка `nav-dot`;
  - `UpdateCard` убран из «Настроек»;
  - тост показывается один раз на версию (localStorage `dc.update.toast.seen`).
- `ui-live.css`: стили обновлений.

## 0.4.0

- **Вкладка «Диагностика зрения» убрана** — это решение команды. Она дублировала «Живую игру».
  - `VisionDiagnostics` и пункт `vision` в `PAGES` удалены.
  - Заглушка распознавания HUD (этап C) теперь карточка «Распознавание HUD» внизу `LiveGame`. Если друг дописывал что-то в `VisionDiagnostics`, это переносится в `LiveGame`.
  - Плитку «Распознавание» в показателях заменила «Кадров разобрано».
- **`LiveGame({ onNavigate })`:** кнопка ⚙ ведёт в «Настройки».
- **Настройки перестроены по смыслу** (ключи `settings.json` не менялись):
  - разделы: «Живая игра» (`LiveSettingsCard`), «Разбор записей» (`capture.targetFps`, `capture.previewFps`, `replay.loop`), «Производительность» (`capture.processingFpsCap`, `capture.maxWidth`), «О программе» с кнопкой «Обновления →»;
  - новые помощники `NumberSetting` и `SettingsSection`, `CAPTURE_FIELDS` удалён;
  - `AppSettings({ onNavigate })`.
- **Новая частота захвата применяется сразу,** если живой режим включён: `LiveSettingsCard` перезапускает живой захват (`startLive`).
- **Переключатель `ui.showRegions`** («Подсвечивать области HUD») перенесён в раздел «Живая игра». Работать он начнёт на этапе C.
- **`ui-live.css`:** стили `.settings-*`.

## 0.5.0

Три правки производительности, интерфейс почти не менялся. Дифф: `git diff v0.4.0 v0.5.0 -- app/`.

- **Нет превью, пока окно UI не видно.**
  - UI, `EngineClient`: новый метод `sendVisibility()` шлёт `{ type: "ui:visibility", visible }`. Вызывается при подключении порта (после `status:request`) и на `document` `visibilitychange`; `visible = document.visibilityState !== "hidden"`.
  - Движок: в `uiToEngineSchema` добавлен вариант `{ type: literal("ui:visibility"), visible: boolean() }`, в `handle()` — `case "ui:visibility": pipeline.uiVisible = msg.visible`.
  - `Pipeline`: поле `uiVisible = true`. `maybePreview()` при `!this.uiVisible` сразу закрывает bitmap и не кодирует JPEG. Счётчики и обработка кадров не меняются.
- **Уменьшение при захвате** (`engine-live.js`, `LiveScreenSource.open()`):
  - в `getUserMedia` mandatory теперь `maxWidth: opts.maxWidth`, `maxHeight: Math.ceil(opts.maxWidth * 0.75)` вместо 3840×2160;
  - в запасном `getDisplayMedia` добавлены `width: { ideal: maxWidth }` и `height: { ideal: ceil(maxWidth * 0.75) }`;
  - `fitWidth` в `onSourceFrame` остаётся как страховка.
- **Реже ищем Доту, когда её нет** (`engine-live.js`):
  - новые константы `LIVE_RETRY_SLOW_MS = 10000` и `LIVE_RETRY_SLOW_AFTER_MS = 60000`;
  - новая чистая функция `liveRetryDelay(waitedMs)`;
  - поле `waitingSince`: в `tick()` ставится, пока нет потока, и сбрасывается при потоке, в `attach()` и в `start()` (там же `lastAttemptAt = -Infinity`);
  - `computeLiveState` не менялся.
- UI `LiveGame`: подпись плитки «Размер окна» → «Размер кадра».
