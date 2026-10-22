// Сторож автопродолжения после докачки STRATZ (DECISIONS.md п. 85, TODO_HOME п. 17–18). Саму докачку не трогает:
// только читает .tmp/items-progress.txt, .tmp/items-{ap,turbo}/state.json и .tmp/items-fetch.lock.
//   node scripts/after-items-fetch.mjs                 — ждать конца докачки (проверка раз в 30 мин), потом один раз пересчитать
//   node scripts/after-items-fetch.mjs --test <папка>   — проверка на копии: состояние докачки из <папки>, ветка test/…,
//                                                        рабочая папка и отчёт — там же (--poll <с> — чаще проверять)
// Когда докачка закончена (оба режима: цель набрана или матчи патча кончились, процесса докачки нет), один раз:
//   1. рабочая папка git (worktree) рядом с проектом, ветка feature/items-situations от release/0.16.2 — основная папка
//      проекта не переключается (иначе скрипт докачки на диске сменился бы на версию из release/0.16.2);
//   2. режим тени «до» (All Pick и Турбо); 3. build-item-timings.mjs и build-item-situations.mjs; 4. типы, unit, e2e;
//   5. режим тени «после»; 6. отчёт .tmp/AFTER_FETCH_REPORT.md и строки в MORNING_REPORT.md ветки; 7. коммит в ветку.
// Не вливает, не пушит, версию не поднимает, STRATZ не вызывает. Пока запущена Dota 2 — пауза. Низкий приоритет.
// Один экземпляр (свой lock). ПК не засыпает, пока идёт докачка или пересчёт. Сделано — метка .tmp/after-items-fetch.done.
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import os from 'node:os';
import { buildReport, fetchStatus, modeDone, parseSituations, parseTimings, targetsFromProgress } from './after-items-fetch-lib.mjs';

try {
  os.setPriority(0, os.constants.priority.PRIORITY_LOW);
} catch {
  // нет прав — обычный приоритет
}
const repo = join(import.meta.dirname, '..');
const argv = process.argv.slice(2);
const arg = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const testDir = arg('--test') ? resolve(arg('--test')) : null;
const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15);
/** Откуда читать состояние докачки и куда писать своё */
const dataDir = testDir ?? join(repo, '.tmp');
const outDir = join(dataDir, 'after-fetch');
const logsDir = join(outDir, 'logs');
const lockFile = join(dataDir, 'after-items-fetch.lock');
const doneFile = join(dataDir, 'after-items-fetch.done');
const logFile = join(dataDir, 'after-items-fetch.log');
const reportFile = join(dataDir, 'AFTER_FETCH_REPORT.md');
const stepsFile = join(outDir, 'steps.json');
const BRANCH = testDir ? `test/after-fetch-${stamp}` : 'feature/items-situations';
const BASE = 'release/0.16.2';
const worktree = testDir ? join(testDir, 'wt') : join(dirname(repo), 'DotaCoach-items-situations');
const POLL_MS = (Number(arg('--poll')) || 30 * 60) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(logsDir, { recursive: true });
const log = (s) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  appendFileSync(logFile, line + '\n');
};

if (existsSync(doneFile)) {
  console.log(`Уже сделано (${doneFile}) — выхожу`);
  process.exit(0);
}

/** Процесс жив и это node (номер процесса после перезагрузки может достаться другой программе) */
function nodeAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return /node\.exe/i.test(execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH'], { encoding: 'utf8', windowsHide: true }));
  } catch {
    return true;
  }
}
const readPid = (f) => (existsSync(f) ? Number(readFileSync(f, 'utf8').trim()) || 0 : 0);

// Один экземпляр
if (nodeAlive(readPid(lockFile))) {
  console.log(`Сторож уже работает (процесс ${readPid(lockFile)})`);
  process.exit(0);
}
writeFileSync(lockFile, String(process.pid));

const dotaRunning = () => {
  try {
    return /dota2\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq dota2.exe', '/NH'], { encoding: 'utf8', windowsHide: true }));
  } catch {
    return false;
  }
};
async function waitNoDota() {
  let said = false;
  while (dotaRunning()) {
    if (!said) log('пауза: запущена Dota 2');
    said = true;
    await sleep(60_000);
  }
}

const readJson = (f) => {
  try {
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
function fetchState() {
  const progress = existsSync(join(dataDir, 'items-progress.txt')) ? readFileSync(join(dataDir, 'items-progress.txt'), 'utf8') : '';
  const targets = targetsFromProgress(progress);
  const ap = readJson(join(dataDir, 'items-ap', 'state.json'));
  const turbo = readJson(join(dataDir, 'items-turbo', 'state.json'));
  const fetcherAlive = nodeAlive(readPid(join(dataDir, 'items-fetch.lock')));
  const heroes = Object.fromEntries(
    [['ap', ap], ['turbo', turbo]].map(([k, s]) => {
      const c = Object.values(s?.heroCounts ?? {});
      return [k, { reached: c.filter((x) => x >= targets[k]).length, total: c.length, target: targets[k], done: modeDone(s, targets[k]) }];
    }),
  );
  return { progress, targets, heroes, status: fetchStatus({ ap, turbo, targets, fetcherAlive }) };
}

// --- Не даём ПК уснуть, пока идёт пересчёт: PowerShell держит SetThreadExecutionState и сам выходит, если сторожа нет
let awake = null;
function keepAwake(on) {
  if (on && !awake) {
    const ps = `$s=Add-Type -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);' -Name P -Namespace W -PassThru; while ($true) { [void]$s::SetThreadExecutionState([uint32]2147483649); if (-not (Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue)) { exit }; Start-Sleep 30 }`;
    awake = spawn('powershell', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', ps], { stdio: 'ignore', windowsHide: true });
    awake.on('exit', () => (awake = null));
  } else if (!on && awake) {
    awake.kill();
    awake = null;
  }
}

// --- Шаги (продолжение после перезагрузки: сделанные шаги записаны в steps.json)
const steps = readJson(stepsFile) ?? { done: {}, results: {} };
const saveSteps = () => writeFileSync(stepsFile, JSON.stringify(steps, null, 1));
async function stepOnce(name, fn) {
  if (steps.done[name]) return steps.results[name];
  await waitNoDota();
  log(`шаг: ${name}`);
  const r = await fn();
  steps.done[name] = new Date().toISOString();
  steps.results[name] = r ?? null;
  saveSteps();
  return r;
}

/** Команда в рабочей папке ветки; вывод — в logs/<имя>.log; возвращает { ok, out } */
function run(name, cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { cwd: worktree, env: { ...process.env, ...env }, encoding: 'utf8', shell: true, windowsHide: true, maxBuffer: 256 * 1024 * 1024, timeout: 3 * 3600_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(join(logsDir, `${name}.log`), `$ ${cmd} ${args.join(' ')}\n${out}\nexit ${r.status}${r.error ? ` (${r.error.message})` : ''}\n`);
  return { ok: r.status === 0, out };
}
const git = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).trim();
const gitOk = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', windowsHide: true }).status === 0;

const FIXTURE_LINKS = ['tests/fixtures/hud', 'tests/fixtures/draftscreen'];
/** Ссылки (junction) из рабочей папки на данные проекта: node_modules, кадры тестов и папки .tmp — только чтение */
function linkData() {
  const links = [];
  const link = (from, to) => {
    if (existsSync(from)) return;
    execFileSync('cmd', ['/c', 'mklink', '/J', from, to], { windowsHide: true, stdio: 'ignore' });
    links.push(from);
  };
  link(join(worktree, 'node_modules'), join(repo, 'node_modules'));
  // Кадры владельца для тестов зрения (не в git): без них в ветке пропускается больше тестов, чем в основной папке
  for (const f of FIXTURE_LINKS) if (existsSync(join(repo, f))) link(join(worktree, f), join(repo, f));
  mkdirSync(join(worktree, '.tmp'), { recursive: true });
  // Все папки .tmp (матчи, экзамены и режим тени — чтобы пересчёт исключил запрещённые матчи), кроме своих
  for (const d of readdirSync(join(repo, '.tmp'), { withFileTypes: true })) {
    if (d.isDirectory() && !d.name.startsWith('after-fetch')) link(join(worktree, '.tmp', d.name), join(repo, '.tmp', d.name));
  }
  return links;
}
/** Убрать ссылки (только сами ссылки: rmdir не заходит внутрь junction) */
function unlinkData() {
  const isLink = (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  };
  const all = [join(worktree, 'node_modules'), ...FIXTURE_LINKS.map((f) => join(worktree, f)), ...(existsSync(join(worktree, '.tmp')) ? readdirSync(join(worktree, '.tmp')).map((d) => join(worktree, '.tmp', d)) : [])];
  for (const p of all) if (isLink(p)) execFileSync('cmd', ['/c', 'rmdir', p], { windowsHide: true, stdio: 'ignore' });
}

async function pipeline(state) {
  const notes = [];
  // 1. Ветка и рабочая папка
  const base = await stepOnce('worktree', () => {
    let b = BASE;
    if (!gitOk('rev-parse', '--verify', '--quiet', BASE)) {
      b = 'sources';
      notes.push(`Ветки ${BASE} нет — ветка взята от sources.`);
    }
    if (!existsSync(join(worktree, '.git'))) {
      if (gitOk('rev-parse', '--verify', '--quiet', BRANCH)) git('worktree', 'add', worktree, BRANCH);
      else git('worktree', 'add', '-b', BRANCH, worktree, b);
    }
    return b;
  });
  linkData();
  const shadow = async (when) => {
    const res = {};
    for (const [k, env] of [['ap', {}], ['turbo', { SHADOW_TURBO: '1', SHADOW_DIR: '.tmp/shadow-turbo' }]]) {
      const outRel = `.tmp/after-fetch-shadow/${when}-${k}`;
      res[k] = await stepOnce(`shadow-${when}-${k}`, () => {
        mkdirSync(join(worktree, outRel), { recursive: true });
        const r = run(`shadow-${when}-${k}`, 'npx', ['vitest', 'run', 'tests/unit/shadow.test.ts'], { DOTACOACH_SHADOW: '1', SHADOW_OUT: outRel, ...env });
        return readJson(join(worktree, outRel, 'shadow-results.json')) ?? { error: r.ok ? 'нет файла результата' : 'прогон упал' };
      });
    }
    return res;
  };
  // 2. Режим тени до пересчёта
  const before = await shadow('before');
  // 3. Пересчёт
  const timings = await stepOnce('build-item-timings', () => {
    const r = run('build-item-timings', 'node', ['scripts/build-item-timings.mjs']);
    return { ok: r.ok, ...parseTimings(r.out) };
  });
  const situations = await stepOnce('build-item-situations', () => {
    const r = run('build-item-situations', 'node', ['scripts/build-item-situations.mjs']);
    return { ok: r.ok, ...parseSituations(r.out) };
  });
  // 4. Проверки
  const check = (name, cmd, args, pick) =>
    stepOnce(`check-${name}`, () => {
      const r = run(`check-${name}`, cmd, args);
      return { name, ok: r.ok, summary: pick(r.out) };
    });
  const last = (re) => (out) => (out.match(re) ?? []).map((x) => x.trim()).join(', ');
  const checks = [
    await check('typecheck', 'npm', ['run', 'typecheck'], (o) => (/error TS/.test(o) ? `${(o.match(/error TS/g) ?? []).length} ошибок` : 'чисто')),
    await check('unit', 'npx', ['vitest', 'run'], last(/^\s+Tests\s+.+$/m)),
    await check('e2e', 'npm', ['run', 'test:e2e'], last(/^\s+\d+ (passed|failed|skipped|flaky).*$/gm)),
  ];
  // 5. Режим тени после
  const after = await shadow('after');
  if (!timings.ok) notes.push('build-item-timings.mjs завершился с ошибкой — см. logs/build-item-timings.log');
  if (!situations.ok) notes.push('build-item-situations.mjs завершился с ошибкой — см. logs/build-item-situations.log');
  // 6. Отчёт и коммит
  const info = { finishedAt: new Date().toISOString(), branch: BRANCH, base, worktree, progress: state.progress, heroes: state.heroes, timings, situations, checks, shadow: { ap: { before: before.ap, after: after.ap }, turbo: { before: before.turbo, after: after.turbo } }, notes, commit: null };
  const allOk = checks.every((c) => c.ok) && timings.ok && situations.ok;
  const commit = await stepOnce('commit', () => {
    const morning = join(worktree, 'MORNING_REPORT.md');
    const short = [
      '',
      `## Пересчёт после докачки (${info.finishedAt.slice(0, 10)}, сторож scripts/after-items-fetch.mjs)`,
      '',
      `- Сборка от положения: пар с ≥ 40 матчами в каждом положении ${situations.pairs40 ?? '—'}, прошли отбор ${situations.found ?? '—'}, подтвердились ${situations.confirmed ?? '—'}.`,
      `- Сборки Турбо: ${timings.turboRank ? `по рангу ${timings.turboRank}` : 'публичные (данных по рангу мало)'}.`,
      `- Проверки: ${checks.map((c) => `${c.name} ${c.ok ? 'ок' : 'УПАЛО'}`).join(', ')}. Подробно — .tmp/AFTER_FETCH_REPORT.md.`,
      `- Ветка ${BRANCH}: не влито, версия не поднята, не опубликовано.`,
      '',
    ].join('\n');
    appendFileSync(morning, short);
    run('git-add', 'git', ['add', 'src/data/item-timings.json', 'src/data/item-situations.json', 'MORNING_REPORT.md']);
    const msg = `Пересчёт после докачки: сборка от положения (подтвердилось ${situations.confirmed ?? '—'}), сборки Турбо ${timings.turboRank ?? 'публичные'}${allOk ? '' : ' — ПРОВЕРКИ УПАЛИ, см. .tmp/AFTER_FETCH_REPORT.md'}\n\nСторож scripts/after-items-fetch.mjs (DECISIONS.md п. 85). Не влито, версия не поднята.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n`;
    writeFileSync(join(outDir, 'commit-msg.txt'), msg);
    const r = run('git-commit', 'git', ['commit', '-F', JSON.stringify(join(outDir, 'commit-msg.txt'))]);
    return r.ok ? execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: worktree, encoding: 'utf8' }).trim() : null;
  });
  info.commit = commit;
  const report = buildReport(info);
  writeFileSync(reportFile, report);
  if (!testDir) copyFileSync(reportFile, join(outDir, 'AFTER_FETCH_REPORT.md'));
  return { allOk, commit };
}

// --- Главный цикл
log(`Старт сторожа${testDir ? ` (проверка на копии: ${testDir})` : ''}. Ветка ${BRANCH}, рабочая папка ${worktree}`);
let lastStatus = null;
for (;;) {
  const st = fetchState();
  if (st.status !== lastStatus) log(`докачка: ${st.status} (All Pick ${st.heroes.ap.reached}/${st.heroes.ap.total}, Турбо ${st.heroes.turbo.reached}/${st.heroes.turbo.total})`);
  lastStatus = st.status;
  // Пока докачка работает, ПК не засыпает (сама она этого не делает, а её код не меняем — DECISIONS п. 86)
  keepAwake(st.status === 'running');
  if (st.status === 'done') {
    await waitNoDota();
    keepAwake(true);
    try {
      const r = await pipeline(st);
      log(`готово: коммит ${r.commit ?? 'не сделан'}, проверки ${r.allOk ? 'зелёные' : 'НЕ все зелёные'}; отчёт ${reportFile}`);
      writeFileSync(doneFile, new Date().toISOString() + '\n');
    } catch (e) {
      log(`ошибка: ${e.message} — повторю через ${POLL_MS / 60000} мин с того же шага`);
      keepAwake(false);
      unlinkData();
      await sleep(POLL_MS);
      continue;
    } finally {
      keepAwake(false);
      unlinkData();
    }
    break;
  }
  await sleep(POLL_MS);
}
rmSync(lockFile, { force: true });
log('Выход');
