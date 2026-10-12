# Промт для Claude Code — установка обновления {VERSION}

**Что сделать (2 минуты):**
1. Скачай `DotaCoach-{VERSION}-update-for-friend.zip` со страницы https://github.com/Chekmarek/dota-ai-coach/releases/latest
2. Распакуй папку `DotaCoach-{VERSION}-update` в корень своего проекта Dota AI Coach, рядом с `package.json`.
3. Открой Claude Code в корне проекта (лучше модель Opus) и вставь всё, что ниже линии.

Дальше агент всё делает сам и в конце пишет отчёт `MERGE_REPORT.md`. Перед началом он сохраняет твою текущую версию в git, так что откатиться можно в любой момент. Пакет накопительный: в нём всё, что сделано с версии 0.1.0, поэтому подходит, даже если прошлые обновления ты не ставил.

---

<role>
You are a senior Electron + TypeScript engineer merging a finished feature release into a project that has diverged from the release's base. You work autonomously, resolve merge conflicts yourself, and keep the owner's existing work intact.
</role>

<context>
- This repo is the source project (electron-vite + React + TypeScript + zod) of "Dota AI Coach". It started from v0.1.0 and the owner has since added his own changes. It may already contain an earlier teammate update (0.2.0, 0.3.0, …): check package.json "version", git log and any MERGE_REPORT.md.
- A teammate builds releases on top of the BUILT v0.1.0 output and tests them on real Dota 2. Everything for v{VERSION} is in ./DotaCoach-{VERSION}-update/:
  - PORTING.md — the feature spec per version, module map and list of edits. Read it first, fully.
  - reference/app/ — the complete working v{VERSION} build (readable, unminified JS). It is the source of truth for behaviour.
  - reference/baseline-0.1.0/ — the built 0.1.0 it was diffed against.
  - diff/*.diff — cumulative 0.1.0 → v{VERSION} changes per built file. Symbol names match the TS sources. new-files.txt lists files that did not exist in 0.1.0.
- Goal: this project ends up with ALL features of v{VERSION} (see PORTING.md for every version up to {VERSION}) AND all of the owner's own changes, building and passing checks.
</context>

<autonomy>
Work end to end without asking, using these merge rules:
1. Owner's code wins on behaviour he added. Teammate changes are additive: insert them into his current code; never revert, rename or reformat his code.
2. If a symbol from the diff was changed by the owner, merge both intents. Keep his signature and logic and adapt the hunk to it (types, names, call sites).
3. If he already implemented something with the same purpose (screen capture, overlay, updater, settings keys, policy changes), keep his version and wire in only what the release adds on top. Never ship two competing implementations. Record each such call.
4. If a previous teammate update is already merged, port only what is missing. Compare reference/app with src symbol by symbol; do not apply a hunk twice.
5. If a hunk targets code he deleted or restructured, re-implement the behaviour at the equivalent place, using reference/app/ to see how it is meant to work.
6. Intended removals by the team (listed in PORTING.md, e.g. the "Диагностика зрения" page in 0.4.0): remove them. If the owner added his own content there, move that content to the page that replaces it (as PORTING.md says) instead of dropping it.
7. Keep these facts exactly, because they were verified on real hardware:
   - the media permission accepts an EMPTY mediaTypes list (Windows sends []);
   - window match is /dota\s*2/i excluding /dota ai coach/i, with exact "Dota 2" preferred;
   - live-coach-unranked and live-coach-ranked stay allowed:false;
   - CSP is not loosened.
8. package.json: set version to the higher of his version and {VERSION} (if his is already ≥ {VERSION}, bump the patch); keep "updateRepo": "Chekmarek/dota-ai-coach".
9. electron-vite config: add the "overlay" renderer entry and the overlay preload entry if they are missing. Keep his other entries.
Write every non-trivial decision into MERGE_REPORT.md as you go.

Stop and ask ONLY before: deleting any of his own files or features (team removals from rule 6 excepted); git push or any remote operation; installing global tools; changing files outside this repo. Everything else — editing, adding files, local commits, installing project dependencies with his package manager — just do.
</autonomy>

<steps>
After each step print one line: ✅ <step> — <evidence>.
0. Safety: if no git repo, git init + commit all. Commit any uncommitted work as "wip: before {VERSION}", tag it "before-{VERSION}", create branch "update-{VERSION}". Make sure DotaCoach-{VERSION}-update/ is git-ignored.
1. Map: for every hunk in diff/*.diff and every module in PORTING.md, find the target file/symbol in src/ and whether it is already present. Write the map as a table at the top of MERGE_REPORT.md: hunk/module → target → status (missing / present / conflict).
2. Port the missing new modules as TS (types added, logic identical).
3. Apply the missing edits to existing code following the merge rules.
4. Checks: install deps, then typecheck, lint, the existing tests.
   - Ensure unit tests exist for computeLiveState, compareVersions and the settings parse of an old settings.json without "live"; add them if missing.
   - Fix failures your port caused. Pre-existing failures: leave them and list them in the report.
   - Repeat until green, max 5 rounds. If still red, stop and report.
5. Runtime check: start the app in dev mode.
   - Confirm in <userData>/live.log (on Windows usually %APPDATA%\Dota AI Coach) the lines "setup" and "windows".
   - If dota2.exe is running (tasklist), also confirm an "engine" line with state "seeing". If it isn't running, do not start the game; note in the report that the user should check it.
   - Close the app.
6. Release files:
   - Hardening (one-time, build config only): in his electron-builder config make sure the Electron fuses RunAsNode and EnableNodeOptionsEnvironmentVariable are disabled (electron-builder `electronFuses` or an afterPack hook with @electron/fuses — use whichever his setup already supports; ask before adding a new dependency). Do not enable asar integrity validation: the in-app updater replaces app.asar.
   - Build with his existing Windows build script.
   - Copy the produced resources/app.asar to release/app.asar.
   - Write release/app.asar.sha256 as "<sha256 hex>  app.asar".
   - Do NOT publish anything.
7. Commit on "update-{VERSION}" ("feat: Dota AI Coach {VERSION}"), then merge into his original branch locally (no push).
</steps>

<done_when>
- Every feature of every version up to {VERSION} in PORTING.md exists in src/, the team removals are done, and the owner's features still work.
- Typecheck, lint and tests are green, or only pre-existing failures remain and are listed.
- live.log shows "setup" and "windows" from a real run.
- release/app.asar and release/app.asar.sha256 exist.
- MERGE_REPORT.md (in Russian) contains:
  - the map;
  - every conflict with how it was resolved;
  - check results;
  - what the owner should verify by hand: Dota in borderless window mode → status «Видит игру», the badge over the game, the «Обновления» tab;
  - how to roll back: git reset --hard before-{VERSION}.
Finish with a summary of at most 12 lines in Russian.
</done_when>
