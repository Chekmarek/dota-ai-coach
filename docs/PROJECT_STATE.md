# Состояние проекта — память для сессий Claude

Снимок на 2026-10-18 (коммит `4b34262`, версия 0.13.2). Обновлять после каждого релиза.
Подробности — в README.md, docs/LIMITATIONS.md, docs/POLICY.md, docs/ARCHITECTURE.md; здесь — сводка и правила работы.

## Что это
Windows-коуч для Dota 2 на Electron 44.4.5 + electron-vite 5 + React 19.2 + TypeScript 5.9 + zod 4.1 (единственная
runtime-зависимость). Тесты: vitest 5 (unit/integration), Playwright 1.64 (e2e на настоящем Electron).
~24,5 тыс. строк в `src/`, ~8,8 тыс. в `tests/`.

Источники данных: Valve GSI (свой герой) + захват окна Доты (`desktopCapturer`) и собственное зрение по шаблонам.
Вывод: окно настроек/страниц + прозрачное окно подсказок поверх Доты (пропускает клики, без фокуса, исключено из захвата).
ИИ: локальный llama-server (llama.cpp b11635, win-cpu-x64), по умолчанию ИИ выключен; модель для матча по умолчанию
`qwen3-1.7b`; для объяснения драфта — 8B (если выбрана в «Модель для выбора героев», по умолчанию null), иначе 4B,
1.7B — никогда. Облако — только с согласием `ai.sendToCloudConsent` и ключом в `safeStorage` (DPAPI).

## Люди и ветки
- Владелец — Chekmarek (коммиты также под `ptichka` и `Claude`). Друг — VOROBEISHESTVO: обновляется только кнопкой
  «Обновления» → «Установить» (меняется лишь `app.asar`), у него свои локальные правки; его промпт — docs/FRIEND_PROMPT.md.
- **`sources`** — единственная рабочая ветка (TS-исходники). **`main`** — старая сборка из `app/` (последний коммит
  `6ed399c` 2026-10-12 «Релизы переехали в ветку sources»), не трогать. CLAUDE.md в `main` описывает старый `app/` и к
  `sources` не относится.
- Прочие ветки на origin: `ci-tmp-build`, `ci-tmp-build-out`, `ci-tmp-gsi`, `ci-tmp-gsi2`, `v0.5.0-pending` — старые,
  не удалять без владельца.

## Карта `src/`
- `core/` — чистый TS (CI проверяет: без electron, node:, fs, path, http): `ai`, `coach` (+`rules`: context, danger,
  draft, economy, fight, laning, macro, timings), `draft`, `gsi`, `hud`, `knowledge-base`, `match-state`, `ocr`, `vision`.
- `main/` — `ai` (+`local/manifest.ts`: версии и SHA-256 моделей), `application` (окна, harden), `coach`, `gsi`
  (`server.ts` приёмник, `setup.ts` cfg в папке Доты, `recorder.ts` записи сессий), `ipc`, `knowledge`, `lifecycle`,
  `live` (`live.ts`, `updater.ts`, `hud-window.ts`, `window-rect.ts`, `dota-video.ts`), `media` (`dcmedia://`),
  `policy/policy-gate.ts`, `settings/store.ts`.
- `engine/` — скрытое окно движка (захват + зрение), `hud/` — окно подсказок, `overlay/` — значок, `preload/`,
  `renderer/pages/`: Dashboard, LiveGame, ReplayMode, MatchState, Draft, AiAssistant, History, KnowledgeBase, HudPreview,
  VoiceSettings, Updates, AppSettings.
- `shared/schemas/settings.ts` — схема настроек: `fields` + `D_*` по умолчанию + терпимый разбор (`.catch`) +
  `settingsPatchSchema`; старый settings.json обязан грузиться (tests/unit/settings-migration.test.ts).
- `src/data/` — раскладки HUD, шаблоны иконок; база знаний `resources/data/kb` (патч 7.41f) лежит внутри app.asar с 0.9.0.

## Чувствительные места (менять только аддитивно и с тестами)
- GSI: `src/main/gsi/server.ts` — только 127.0.0.1, только POST, тело ≤ 256 КБ (`GSI_MAX_BODY`), `auth.token` через
  `timingSafeEqual` по SHA-256, запросы с `Origin` отклоняются, порт по умолчанию 53790.
- Обновления: `src/main/live/updater.ts` — **не менять без владельца (кроме тестов)**. Ищет релиз с `app.asar` и
  `app.asar.sha256`, сверяет SHA-256, cmd-скрипт подмены после выхода с откатом на `app.asar.prev`, в Program Files —
  `elevate.exe` (UAC, ждёт без таймаута с 0.11.1), при 403 от API GitHub — обычные страницы github.com (0.13.1).
- Миграции настроек, локальные правки друга, пороги распознавания, модель по умолчанию — не трогать без владельца.
- Политика (docs/POLICY.md — **черновик**, одобрения Valve нет): нет чтения памяти, DLL, ввода в игру; подсказки
  в матче включены по решению владельца 2026-10-13/16, рейтинг — переключатель пользователя.

## Выпуск
1. `git fetch origin sources`, работать на последнем коммите, `git pull --rebase`.
2. `npm version X.Y.Z --no-git-tag-version`; `docs/release-notes/vX.Y.Z.md` (2–5 пунктов по-русски, формат:
   первая строка «Что нового в X.Y.Z:», дальше «- …»).
3. Локально: `npm run typecheck`, `npm test`, `npm run build`, `npm run test:e2e`.
4. Показать владельцу diff и заметки, спросить «Публикуем vX.Y.Z?», ждать «да».
5. Коммит по-русски, push только в `sources`, без force. Следить за `checks`.
6. Проверить в релизе: `app.asar`, `app.asar.sha256` (сверить с digest), `DotaCoach-Setup-X.Y.Z.exe`,
   `DotaCoach-X.Y.Z-win-x64-portable.zip`.

**Важно про CI:** `checks.yml` (типы, unit, e2e на windows-latest) и `release-sources.yml` запускаются **параллельно**
на один и тот же push. Релиз не ждёт `checks` и сам e2e не гоняет (только typecheck + unit). Значит, «релиз только
после зелёного checks» — правило процесса, а не автоматика: если `checks` упадёт, релиз всё равно уже выйдет.
Безопасный порядок — сначала запушить изменения без поднятия версии, дождаться зелёного `checks`, затем отдельным
коммитом поднять версию. Workflow-файлы Claude не меняет.

## Проверки в облачном контейнере Claude (Linux)
- `.npmrc` содержит `cache=D:\DotaCoach\.cache\npm` — на Linux npm создаёт в корне папку с таким именем (она в
  .gitignore, её можно удалить).
- Установка: `npm ci --ignore-scripts`, затем `node node_modules/electron/install.js`; e2e — через `xvfb-run -a npx playwright test`.
- Ожидаемо на Linux: e2e `ai.spec.ts:60` падает (нет `safeStorage` → кнопка «Сохранить» ключа неактивна); это не ошибка
  кода. Пропуски unit (27) — тесты на кадрах `tests/fixtures/hud` (с никами, не в репозитории), путь Steam из реестра.
  Пропуски e2e (2) — `packaged.spec.ts` (нужен `DOTACOACH_PACKAGED_EXE`) и запись пользователя (`DOTACOACH_USER_VIDEO`).

## Результаты на 4b34262 (2026-10-18)
- Локально: typecheck чисто; vitest 548 passed / 27 skipped (файлы 47/3); build ок; e2e 26 passed / 1 failed
  (ai.spec.ts:60, см. выше) / 2 skipped.
- GitHub: `checks` #47 success, `release-sources` #58 success, релиз v0.13.2 опубликован 2026-10-18 05:15 UTC, все 4
  файла на месте, `app.asar.sha256` совпадает с digest ассета (`268ba90e…f831`).

## Известные долги (не исправлены)
- README.md устарел: шапка говорит «версия 0.2.0», «не использует GSI», «рекомендаций нет», хотя всё это давно есть.
- MERGE_REPORT.md — исторический отчёт о слиянии 0.5.0–0.7.0, не актуален.
- Объяснения ИИ на странице «Драфт» ещё не подключены (обещаны в следующей версии в заметках 0.13.2).
- Из LIMITATIONS: 16:10/21:9/4:3 — только расчёт (выключены); FPS Доты под ИИ на слабых ПК не измерен; облако
  проверено только на подставном сервере.

## Турбо (0.13.3, готовится; выпуск — только после «да» владельца)
- Режим: `src/core/gsi/mode.ts` — `map.game_mode` в GSI игрока нет; `GameModeTracker` узнаёт режим по часам в первом теле
  PRE_GAME после выбора героев: −90 обычный, −60 Турбо (подтверждено матчем 2026-10-18, OpenDota: game_mode 23), −75 боты.
  Ручной выбор — `hints.gameMode` (auto / turbo / normal). Индикатор режима — `src/hud/components/mode.ts`, `mode-toast.tsx`.
- Справочник Турбо: `src/data/modes/turbo.json` (78 записей механики, источники с ревизиями Liquipedia) +
  `src/core/knowledge-base/modes.ts`; после нового патча — сверить заново (иначе вся механика Турбо «не проверено»).
- Правила: `CoachLookup.setMode` → механика Турбо, `aegisSec`, `hasNorms` (нормы обычной игры в Турбо выключены).
- Статистика Турбо: `node scripts/import-stats.mjs --turbo` → `resources/data/kb/<патч>/stats-turbo.json`.
- ИИ: строка «Режим игры» в фактах, проверка `wrongMode` в `draft-check.ts`; набор `tests/ai/draft-questions-turbo.json`.
- Тестовые записи: `tests/fixtures/gsi/recorded/lobby-normal.jsonl`, `turbo-bristleback.jsonl` (без чата и matchid).
- «Золотой» снимок обычных режимов: `tests/unit/golden-normal.test.ts` (обновлять только при намеренной смене поведения).
- Проверка в игре: `docs/TURBO_GAME_TEST.md`; ограничения — `docs/LIMITATIONS.md`, раздел «Турбо».
- Исправлено (этап 7): подсказки после конца матча (без свежего GSI матч «идёт», только если часы подтверждены
  не раньше 30 с назад и последнее чтение GSI — не конец матча; `CLOCK_CONFIRM_MS` в `src/core/coach/view.ts`);
  чат чужих игроков больше не пишется в `gsi-sessions` (`sanitizeGsiBody`; старые файлы с чатом остаются у владельца);
  e2e раскладки HUD ждёт, пока раскладка устоится (было: фиксированные 0,7 с).
- Известные баги: llama-server грузился 82 с во время матча (не воспроизведено, причина не найдена).
