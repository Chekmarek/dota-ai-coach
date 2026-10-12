# Отчёт о слиянии обновления 0.5.0

Дата: 2026-10-12. Пакет: `DotaCoach-0.5.0-update-for-friend.zip` (SHA-256 `41c5a816…37b4df`), скачан владельцем с
https://github.com/Chekmarek/dota-ai-coach/releases/tag/v0.5.0 и распакован в `.tmp/friend-update-0.5.0/` (в git не входит).
Исходное состояние владельца — версия 0.3.0 (распознавание чисел HUD, имя героя, база знаний).
Откат: `git reset --hard before-0.5.0` (тег на коммите до слияния).

## Карта переноса

| Изменение 0.5.0 | Куда в исходниках | Статус |
|---|---|---|
| `out/main/live.js` (окно Доты, разрешения, IPC движка, значок, `liveLog`) | `src/main/live/live.ts` | перенесено |
| `out/main/updater.js` (обновления из GitHub) | `src/main/live/updater.ts` | **перенесено частично** — см. конфликт 1 |
| `engine-live.js`: `LiveScreenSource` | `src/engine/capture/live-screen-source.ts` | перенесено |
| `engine-live.js`: `computeLiveState`, `liveRetryDelay`, константы | `src/engine/capture/live-state.ts` (без DOM, с тестами) | перенесено |
| `preload/overlay.cjs` | `src/preload/overlay.ts` + точка `overlay` в electron-vite | перенесено |
| `renderer/overlay/index.html`, `overlay.js` | `src/overlay/index.html`, `overlay.ts` + renderer-точка `overlay` | перенесено |
| `ui-live.css` | `src/renderer/live.css` | перенесено как есть |
| main: `harden` → `allowLivePermission` | `src/main/application/windows.ts` | перенесено |
| main: настройки `live` | `src/shared/schemas/settings.ts` | перенесено |
| main: `live-observe` разрешён | `src/main/policy/policy-gate.ts` | перенесено |
| main: `onSettingsChanged` в `registerIpc` | `src/main/ipc/register.ts` | перенесено |
| main: `setLiveEngine` / `onLiveEngineGone` в `EngineLink` | `src/main/lifecycle/engine-link.ts` | перенесено |
| main: `readUpdateRepo`, `setupLive`, `setupUpdater` | `src/main/index.ts` | перенесено |
| preload движка: `dotacoachEngine { findDota, reportLive }` | `src/preload/engine.ts` | перенесено |
| preload UI: `getUpdateState`, `checkForUpdates`, `installUpdate`, `onUpdateState` | `src/preload/ui.ts`, `src/shared/ipc.ts` | перенесено |
| движок: `live:start` / `live:stop` / `ui:visibility` | `src/shared/events/engine-protocol.ts`, `src/engine/main.ts` | перенесено |
| движок: `LiveScreenSource` в `Pipeline.start`, `events.live`, `status.live`, `reportLive`, `uiVisible` | `src/engine/pipeline.ts`, `capture/frame-source.ts`, `shared/types/capture.ts` | перенесено |
| 0.5.0: уменьшение кадра при захвате (`maxWidth`), редкий поиск Доты (`liveRetryDelay`), нет превью при скрытом окне | соответствующие файлы выше | перенесено |
| UI: `LiveGame`, `LivePill`, автозапуск, `startLive` | `src/renderer/pages/LiveGame.tsx`, `components/live.tsx` | перенесено |
| UI: `UpdatesPage`, `UpdateBanner`, `UpdateToast`, `UpdateNotice`, точка в меню | `src/renderer/pages/Updates.tsx`, `hooks/useUpdate.ts`, `App.tsx` | перенесено |
| UI: `EngineClient.statusPort`, `sendVisibility` | `src/renderer/hooks/useEngine.ts` | перенесено |
| UI: «Настройки» по разделам (`NumberSetting`, `SettingsSection`, `LiveSettingsCard`) | `src/renderer/pages/AppSettings.tsx` | перенесено |
| UI: тексты `Dashboard`, `ReplayMode` | соответствующие страницы | перенесено |
| 0.4.0: вкладка «Диагностика зрения» убрана | `App.tsx` | **перенесено с переносом содержимого** — см. конфликт 2 |
| `package.json`: версия, `updateRepo` | `package.json` | 0.5.0, `Chekmarek/dota-ai-coach` |
| Защита: fuses `RunAsNode`, `EnableNodeOptionsEnvironmentVariable` выключены | `electron-builder.yml` (`electronFuses`, встроено в electron-builder 26 — новых зависимостей нет) | сделано |

## Конфликты и решения

1. **Автоустановка обновлений.** Сначала её заблокировала система безопасности Claude Code (в автоматическом
   режиме), поэтому в первом коммите 0.5.0 была только проверка релизов и ссылка на страницу релиза. Затем владелец
   переключил режим разрешений и подтвердил запись: `updater.js` перенесён целиком в `src/main/live/updater.ts`
   (логика та же: скачивание `app.asar` в `<userData>/updates`, сверка SHA-256, cmd-скрипт подмены после выхода,
   `elevate.exe` или PowerShell `RunAs` для Program Files, откат на `app.asar.prev`, перезапуск, очистка старых
   загрузок). Вкладка «Обновления»: кнопка «Установить», полоса загрузки, сообщение об установке.
   Риск: `app.asar.sha256` лежит в том же релизе, поэтому сумма защищает от повреждённой загрузки, но не от подмены
   релиза — безопасность обновлений = безопасность GitHub-аккаунта `Chekmarek` (нужна двухфакторная защита).
2. **«Диагностика зрения».** В 0.4.0 команда удалила вкладку: у них там была заглушка этапа C. У владельца там
   настоящее распознавание (числа HUD, «чья панель», имя героя). По правилу 6 промпта содержимое перенесено:
   - в «Живую игру» — вместо карточки-заглушки «Распознавание HUD» (распознавание теперь работает и на живой игре);
   - в «Разбор записи» — чтобы распознавание по записям тоже было видно.
   Рамки областей HUD на кадре показываются по переключателю `ui.showRegions` («Подсвечивать распознанные области HUD»).
   Компоненты вынесены в `src/renderer/components/HudRecognition.tsx`. Файл `src/renderer/pages/VisionDiagnostics.tsx`
   больше не используется, **но не удалён** (владелец просил не удалять файлы без его согласия).
3. **Статус конвейера.** У команды `pipeline.vision = 'not-implemented'`, у владельца — `'hud-numbers'` и время
   распознавания. Оставлено значение владельца.
4. **Код окон.** `harden`, `pageUrl`, `preloadDir` у владельца лежат в `src/main/application/windows.ts` — экспортированы
   оттуда и передаются в `setupLive(...)` (как у команды через deps), без циклических импортов.
5. **Строки IPC движка** продублированы в `src/preload/engine.ts` и `overlay.ts` с проверкой типов: sandbox-preload
   не умеет подгружать общие чанки сборки (известная особенность проекта владельца).
6. **Версия:** у владельца 0.3.0, у команды 0.5.0 → 0.5.0.
7. **Запуск записи** теперь берёт свежие настройки из main (раньше — из кэша интерфейса). Нужно потому, что
   интерфейс теперь загружает настройки сразу (для автозапуска живого режима), а кэш мог устареть.
8. **Тесты:** e2e по умолчанию запускаются с `live.autoStart = false` (чтобы не зависеть от того, открыта ли Дота)
   и без сетевой проверки обновлений (`DOTACOACH_NO_UPDATE_CHECK`). Живой режим проверяется отдельным тестом.

Зафиксированные факты из промпта соблюдены: пустой `mediaTypes` допустим; окно ищется по `/dota\s*2/i` без
`/dota ai coach/i` с приоритетом точного «Dota 2»; `live-coach-unranked` и `live-coach-ranked` — `allowed: false`;
CSP не ослаблен (значок получил ту же политику, что и остальные окна).

## Проверки

- Типы (`npm run typecheck`): без ошибок. Линтера в проекте нет (скрипта `lint` нет) — не запускался.
- Unit/integration (Vitest): **44 из 44**, в т.ч. новые тесты `computeLiveState`, `liveRetryDelay`, `compareVersions`,
  загрузка старого `settings.json` без раздела `live`.
- E2E (Playwright, настоящее приложение): **10 из 10**, в т.ч. живой режим (автозапуск, поиск окна, `live.log`,
  выкл/вкл, запись выключает живой захват), страница обновлений, разделы настроек, распознавание на записи владельца.
- Запуск: в `live.log` есть строки `setup` и `windows` (видны окна «Dota AI Coach», «Claude», «NVIDIA GeForce Overlay»).
  **Dota 2 не была запущена** — строка `engine` с состоянием `seeing` не проверялась.
  Проверка велась на собранном приложении (как в e2e), а не в `npm run dev`.
- Сборка: `release/0.5.0/DotaCoach-Setup-0.5.0.exe`, `DotaCoach-0.5.0-win-x64-portable.zip`; портативная версия
  проверена тестом. `release/app.asar` и `release/app.asar.sha256` подготовлены. **Ничего не опубликовано.**

## Важно для команды

- `release/app.asar` из этой сборки рассчитан на установку владельца: база знаний лежит рядом, в `resources/data`.
  Если поставить его через автообновление в старую установку 0.1–0.5 команды, экран «База знаний» покажет ошибку
  (остальное работает). Дальше лучше собирать релизы из этих исходников, иначе обновление «откатит» распознавание HUD.

## Что проверить руками

1. Дота в режиме «Оконный без рамки» → вкладка «Живая игра» показывает «Видит игру», превью и распознанные значения.
2. Значок «Коуч» поверх игры (угол меняется в «Настройках»).
3. Вкладка «Обновления»: «Проверить сейчас» показывает версии с GitHub.
