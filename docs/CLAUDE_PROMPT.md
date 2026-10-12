# Промт для Claude Code — установка обновления 0.2.0

**Как запустить:** распакуй эту папку (`DotaCoach-0.2.0-update`) в корень своего проекта Dota AI Coach, рядом с `package.json`. Открой Claude Code в корне проекта (лучше модель Opus) и вставь всё, что ниже линии. Дальше агент всё делает сам и в конце пишет отчёт. Перед началом он сохраняет твою текущую версию в git, так что откатиться можно в любой момент.

---

<role>
You are a senior Electron + TypeScript engineer merging a finished feature release into a project that has diverged from the release's base. You work autonomously, resolve merge conflicts yourself, and keep the owner's existing work intact.
</role>

<context>
- This repo is the source project (electron-vite + React + TypeScript + zod) of "Dota AI Coach". It started from v0.1.0 and the owner has since added his own changes.
- A teammate built v0.2.0 on top of the BUILT v0.1.0 output (no sources) and tested it on real Dota 2. Everything for it is in ./DotaCoach-0.2.0-update/:
  - PORTING.md — the feature spec, module map and list of edits. Read it first, fully.
  - reference/app/ — the complete working 0.2.0 build (readable, unminified JS). It is the source of truth for behaviour.
  - reference/baseline-0.1.0/ — the built 0.1.0 it was diffed against.
  - diff/*.diff — 0.1.0 → 0.2.0 changes per built file. Symbol names match the TS sources.
- Goal: this project ends up with ALL 0.2.0 features (live capture of the Dota 2 window, "Живая игра" tab, indicators, animated in-game overlay badge, live.log diagnostics, GitHub Releases updater) AND all of the owner's own changes, building and passing checks.
</context>

<autonomy>
Work end to end without asking, using these merge rules:
1. Owner's code wins on behaviour he added. 0.2.0 changes are additive: insert them into his current code; never revert, rename or reformat his code.
2. If a symbol from the diff was changed by the owner, merge both intents. Keep his signature and logic and adapt the 0.2.0 hunk to it (types, names, call sites).
3. If he already implemented something with the same purpose (screen capture, overlay, updater, settings keys, policy changes), keep his version and wire in only what 0.2.0 adds on top. Never ship two competing implementations. Record each such call.
4. If a 0.2.0 hunk targets code he deleted or restructured, re-implement the behaviour at the equivalent place, using reference/app/ to see how it is meant to work.
5. Keep these 0.2.0 facts exactly, because they were verified on real hardware:
   - the media permission accepts an EMPTY mediaTypes list (Windows sends []);
   - window match is /dota\s*2/i excluding /dota ai coach/i, with exact "Dota 2" preferred;
   - live-coach-unranked and live-coach-ranked stay allowed:false;
   - CSP is not loosened.
6. package.json: set version to the higher of his version and 0.2.0 (if his is already ≥ 0.2.0, bump the minor); add "updateRepo": "Chekmarek/dota-ai-coach".
7. electron-vite config: add the "overlay" renderer entry and the overlay preload entry. Keep his other entries.
Write every non-trivial decision into MERGE_REPORT.md as you go.

Stop and ask ONLY before: deleting any of his files or features; git push or any remote operation; installing global tools; changing files outside this repo. Everything else — editing, adding files, local commits, installing project dependencies with his package manager — just do.
</autonomy>

<steps>
After each step print one line: ✅ <step> — <evidence>.
0. Safety: if no git repo, git init + commit all. Commit any uncommitted work as "wip: before 0.2.0", tag it "before-0.2.0", create branch "update-0.2.0". Make sure DotaCoach-0.2.0-update/ is git-ignored.
1. Map: for every hunk in diff/*.diff and every module in PORTING.md, find the target file/symbol in src/. Write the map as a table at the top of MERGE_REPORT.md, flagging conflicts and divergences.
2. Port the new modules as TS (types added, logic identical): main/live, main/updater, the engine LiveScreenSource + computeLiveState, the overlay preload + page, ui-live styles.
3. Apply the edits to existing code following the merge rules: main, preloads, engine Pipeline/schema/handler, UI blocks/pages/App/EngineClient/settings cards, package.json, electron-vite config.
4. Checks: install deps, then typecheck, lint, the existing tests.
   - Add unit tests for computeLiveState, compareVersions and the settings parse of an old settings.json without "live".
   - Fix failures your port caused. Pre-existing failures: leave them and list them in the report.
   - Repeat until green, max 5 rounds. If still red, stop and report.
5. Runtime check: start the app in dev mode.
   - Confirm in <userData>/live.log (find userData from app name; on Windows usually %APPDATA%\Dota AI Coach) the lines "setup" and "windows".
   - If dota2.exe is running (tasklist), also confirm an "engine" line with state "seeing". If it isn't running, do not start the game; note in the report that the user should check it.
   - Close the app.
6. Release files: build with his existing Windows build script.
   - Copy the produced resources/app.asar to release/app.asar.
   - Write release/app.asar.sha256 as "<sha256 hex>  app.asar".
   - Do NOT publish anything.
7. Commit on "update-0.2.0" ("feat: Dota AI Coach 0.2.0 — live capture, overlay, updater"), then merge into his original branch locally (no push).
</steps>

<done_when>
- All 0.2.0 features from PORTING.md exist in src/, and all of the owner's features still work.
- Typecheck, lint and tests are green, or only pre-existing failures remain and are listed.
- live.log shows "setup" and "windows" from a real run.
- release/app.asar and release/app.asar.sha256 exist.
- MERGE_REPORT.md (in Russian) contains:
  - the map;
  - every conflict with how it was resolved;
  - check results;
  - what the owner should verify by hand: Dota in borderless window mode → status «Видит игру», the badge over the game;
  - how to roll back: git reset --hard before-0.2.0.
Finish with a summary of at most 12 lines in Russian.
</done_when>
