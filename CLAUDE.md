# Dota AI Coach — правила для Claude Code

## Что это
Electron-приложение (Electron 44, React, zod 4). Исходников на TypeScript здесь нет: `app/` — это **собранный, но не минифицированный** код из app.asar. Его правят напрямую, шага сборки нет. Исходники на TS лежат у второго разработчика, изменения переносятся к нему пакетом (`tools/make_friend_kit.py` + `docs/CLAUDE_PROMPT.md`).

## Карта кода (сначала grep, потом читать ±40 строк, НИКОГДА не читать большие файлы целиком)
- `app/out/main/index.js` — main: окна, настройки (`fields` / `DEFAULTS` / `tolerant()` / `settingsPatchSchema` / `applySettingsPatch`), IPC (`registerIpc`, `isTrustedSender`), `POLICY`, `harden()`, `EngineLink`.
- `app/out/main/live.js` — поиск окна Доты, разрешение media, значок поверх игры, `liveLog()` → `%APPDATA%\Dota AI Coach\live.log`.
- `app/out/main/updater.js` — обновления из GitHub Releases.
- `app/out/preload/ui.cjs` (`window.dotacoach`), `engine.cjs` (`window.dotacoachEngine`), `overlay.cjs`.
- `app/out/renderer/assets/engine-DTtfB-J6.js` (~3.9k строк): первые ~3400 — вшитый zod, код приложения начинается с `class FpsMeter`. Там `uiToEngineSchema`, `Pipeline`, `handle()`.
- `app/out/renderer/assets/engine-live.js` — `LiveScreenSource`, `computeLiveState`.
- `app/out/renderer/assets/ui-NX-TDieK.js` (~13k строк): первые ~12.4k — вшитый React, код приложения начинается с `class EngineClient`. Блоки между маркерами `// ===== Живой захват` и `// ===== Обновления`. JSX пишется как `jsxRuntimeExports.jsx/jsxs`, хуки — `reactExports.useState` и т. п. Страницы — массив `PAGES`.
- `app/out/renderer/assets/ui-live.css` — стили наших блоков (старый `ui-B_8pebK1.css` не трогать).
- `app/out/renderer/overlay/` — значок поверх игры.

## Жёсткие правила
- Никаких новых зависимостей: ни npm, ни node_modules (кроме уже вшитого zod). Только встроенное в Electron и Node.
- Доступ к игре только на чтение: захват окна и официальный GSI. НИКОГДА не читать память игры и не внедряться в процесс dota2.exe.
- Подсказки во время матча (`live-coach-*` в `POLICY`) остаются выключенными.
- CSP не ослаблять. Новый IPC: в main через `ipcMain.handle` с проверкой отправителя, в preload — через contextBridge, каналы и аргументы проверяются zod.
- Новые ключи настроек добавлять по шаблону `fields`/`DEFAULTS`/`tolerant`: старый `settings.json` должен загружаться без ошибок.
- Не трогать `.github/workflows/`, не ставить git-теги, не создавать релизы вручную: релиз делает GitHub Actions.
- Никаких рефакторингов, переименований и переформатирования вне задачи.

## Проверка (после каждого этапа)
1. `node --check` для каждого изменённого .js/.cjs и `node --input-type=module --check < файл` для ES-модулей.
2. `python tools/make_release.py` → `dist/app.asar`.
3. Живой тест:
   - `taskkill /IM DotaCoach.exe /F`;
   - скопировать `dist/app.asar` в `%LOCALAPPDATA%\Programs\DotaCoach\resources\app.asar`;
   - запустить `%LOCALAPPDATA%\Programs\DotaCoach\DotaCoach.exe`;
   - через 10 с прочитать хвост `%APPDATA%\Dota AI Coach\live.log`: нужны строки `setup` и `windows`, а также `engine ... seeing`, если Дота запущена.
   - Копию в Program Files не трогать: туда нужны права администратора, она обновится сама через релиз.
4. То, что видно только глазами (интерфейс, значок), перечисли в отчёте одним списком «проверь руками».

## Выпуск версии (в конце каждого этапа, только если проверка прошла)
1. Поднять `version` в `app/package.json`.
2. `docs/release-notes/v<версия>.md` — по-русски, 2–5 пунктов «что нового» для пользователя.
3. В `docs/PORTING.md` добавить раздел `## <версия>`: какие символы и файлы изменились и что сделать в TS-исходниках.
4. `python tools/make_friend_kit.py`.
5. `git add -A && git commit -m "v<версия>: …" && git push origin main` — GitHub сам выпустит релиз, коуч у всех предложит обновиться.

## Отчёт
По-русски, не больше 12 строк: что сделано, результаты проверки, что проверить руками, номер версии.
