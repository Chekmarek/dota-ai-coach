// Докачка матчей STRATZ «для предметов» (DECISIONS.md п. 79): сборка от положения в матче (All Pick) и сборки Турбо
// по рангу игрока. Работает долго (дни), продолжает с места после обрыва, не мешает игре.
//   node scripts/fetch-items-matches.mjs            — работать, пока не наберётся цель
//   node scripts/fetch-items-matches.mjs --once 20  — 20 запросов и выход (проверка)
// Что качается: id — OpenDota publicMatches (средний ранг ≥ Divine: min_rank=71, как у .tmp/danger), данные — облегчённый
// STRATZ match(id): герой, сторона, победа, позиция, ранг игрока (seasonRank), покупки и убийства по времени. Без ников
// и id игроков. Матчи — .tmp/items-ap/<id>.json.gz и .tmp/items-turbo/<id>.json.gz (не в git, не в сборке).
// Не качаются: уже скачанные (здесь и в .tmp/danger, .tmp/danger-turbo), экзамены, режим тени, свои матчи владельца.
// Сутки делятся так: All Pick до 9500 запросов, Турбо до 4000; если у токена в сутки осталось меньше 1500 запросов —
// пауза (запас для коуча: ему хватает десятков в день). Запрос раз в 3 с (≤ 1200 в час при лимите STRATZ 1500). Пока запущена Dota 2 — пауза. Приоритет процесса — низкий.
// Прогресс — .tmp/items-progress.txt (раз в 25 матчей и при паузах).
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { forbiddenIds, idsIn, prioritize, retryFailed, step, utcDay } from './items-data-lib.mjs';

try {
  os.setPriority(0, os.constants.priority.PRIORITY_LOW);
} catch {
  // нет прав — работаем с обычным приоритетом
}
const root = join(import.meta.dirname, '..');
const onceArg = process.argv.includes('--once') ? Number(process.argv[process.argv.indexOf('--once') + 1] ?? 10) : null;
const progressFile = join(root, '.tmp', 'items-progress.txt');
const logFile = join(root, '.tmp', 'items-fetch.log');
const log = (s) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  appendFileSync(logFile, line + '\n');
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const tokenFile = ['.stratz-token.txt', '.stratz-token'].map((f) => join(home, f)).find((f) => existsSync(f));
const token = (tokenFile ? readFileSync(tokenFile, 'utf8') : '').replace(/^﻿/, '').trim();
if (!token) throw new Error('Нет токена STRATZ (%USERPROFILE%\\.stratz-token.txt)');

/** Режимы: папка, где лежат старые полные матчи (не качать повторно), фильтр OpenDota, суточная квота, цель на героя */
const MODES = {
  ap: { dir: 'items-ap', old: 'danger', lobby: 7, mode: 22, minDur: 900, budget: 9500, target: 900 },
  turbo: { dir: 'items-turbo', old: 'danger-turbo', lobby: 0, mode: 23, minDur: 600, budget: 4000, target: 500 },
};
const RESERVE_DAY = 1500;
const GAP_MS = 3000;

// Один экземпляр: автозапуск при входе в Windows и ручной запуск не должны качать параллельно (лимит общий)
const lockFile = join(root, '.tmp', 'items-fetch.lock');
if (!onceArg && existsSync(lockFile)) {
  const pid = Number(readFileSync(lockFile, 'utf8'));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = pid !== process.pid;
  } catch {
    alive = false;
  }
  if (alive) {
    console.log(`Докачка уже идёт (процесс ${pid})`);
    process.exit(0);
  }
}
if (!onceArg) writeFileSync(lockFile, String(process.pid));

const forbidden = forbiddenIds(root);
log(`Старт. Запрещённых матчей (экзамены, тень, свои): ${forbidden.size}`);

function loadState(key) {
  const m = MODES[key];
  const dir = join(root, '.tmp', m.dir);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'state.json');
  const s = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { cursor: null, queue: [], rejected: {}, heroCounts: null, day: null, dayRequests: 0, exhausted: false, patch: null };
  const have = idsIn(dir);
  const old = idsIn(join(root, '.tmp', m.old));
  if (!s.heroCounts) {
    // Начальный счёт героев: старые полные матчи + уже скачанные компактные
    s.heroCounts = {};
    for (const f of readdirSync(join(root, '.tmp', m.old)).filter((x) => x.endsWith('.json.gz'))) {
      const j = JSON.parse(gunzipSync(readFileSync(join(root, '.tmp', m.old, f))).toString('utf8'));
      for (const p of j.players) s.heroCounts[p.heroId] = (s.heroCounts[p.heroId] ?? 0) + 1;
    }
    for (const id of have) {
      const j = JSON.parse(gunzipSync(readFileSync(join(dir, `${id}.json.gz`))).toString('utf8'));
      for (const p of j.players) s.heroCounts[p.hero] = (s.heroCounts[p.hero] ?? 0) + 1;
    }
  }
  // Обрыв посреди запроса: тот матч — снова в очередь
  retryFailed(s, 'обрыв');
  return { key, m, dir, file, s, have, old };
}
const save = (st) => {
  writeFileSync(st.file + '.tmp', JSON.stringify(st.s));
  renameSync(st.file + '.tmp', st.file);
};

let lastCall = 0;
let dayLeft = 15000;
async function gql(query) {
  for (let a = 1; ; a++) {
    const wait = lastCall + GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res;
    try {
      res = await fetch('https://api.stratz.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      log(`сеть: ${e.message}, повтор ${a}`);
      await sleep(Math.min(600_000, 15_000 * a));
      continue;
    }
    dayLeft = Number(res.headers.get('x-ratelimit-remaining-day') ?? dayLeft);
    const hour = Number(res.headers.get('x-ratelimit-remaining-hour') ?? 1000);
    if (res.ok) {
      const j = await res.json();
      if (hour < 150) await sleep(600_000);
      if (j.errors?.length) throw new Error(String(j.errors[0].message).replaceAll(token, '<token>'));
      return j.data;
    }
    log(`STRATZ HTTP ${res.status}, повтор ${a}`);
    await sleep(res.status === 429 ? 300_000 : Math.min(600_000, 15_000 * a));
  }
}
const Q = (id) => `{ match(id: ${id}) { id didRadiantWin durationSeconds gameVersionId parsedDateTime gameMode rank bracket
  players { heroId isRadiant isVictory position steamAccount { seasonRank } stats { itemPurchases { time itemId } killEvents { time } } } } }`;

let patch = null;
async function ensurePatch() {
  if (patch) return patch;
  const d = await gql('{ constants { gameVersions { id name asOfDateTime } } }');
  const v = [...d.constants.gameVersions].sort((a, b) => b.asOfDateTime - a.asOfDateTime)[0];
  patch = { id: v.id, name: v.name, asOf: v.asOfDateTime };
  log(`Патч ${v.name} (id ${v.id}) с ${new Date(v.asOfDateTime * 1000).toISOString().slice(0, 10)}`);
  return patch;
}

/** Очередная страница OpenDota → в очередь, сначала матчи с самыми редкими героями */
async function refill(st) {
  const p = await ensurePatch();
  const url = `https://api.opendota.com/api/publicMatches?min_rank=71${st.s.cursor ? `&less_than_match_id=${st.s.cursor}` : ''}`;
  let rows = null;
  for (let a = 1; !rows; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'DotaCoach-items/0.1 (local tool)' }, signal: AbortSignal.timeout(60_000) });
      if (res.ok) rows = await res.json();
      else log(`OpenDota HTTP ${res.status}, повтор ${a}`);
    } catch (e) {
      log(`OpenDota: ${e.message}, повтор ${a}`);
    }
    if (!rows) await sleep(Math.min(600_000, 20_000 * a));
  }
  await sleep(1200);
  if (!rows.length) {
    st.s.exhausted = true;
    return;
  }
  const now = Date.now() / 1000;
  st.s.cursor = Math.min(...rows.map((r) => r.match_id));
  if (rows.every((r) => r.start_time < p.asOf)) st.s.exhausted = true;
  const fit = rows.filter((r) => r.lobby_type === st.m.lobby && r.game_mode === st.m.mode && r.duration >= st.m.minDur && r.start_time >= p.asOf && now - r.start_time >= 20 * 3600 && !st.have.has(String(r.match_id)) && !st.old.has(String(r.match_id)) && !forbidden.has(String(r.match_id)));
  // Пропуск свежих (STRATZ разбирает примерно через сутки)
  if (!fit.length && rows.every((r) => now - r.start_time < 20 * 3600)) {
    const s = [...rows].sort((a, b) => a.start_time - b.start_time);
    const perSec = (s.at(-1).match_id - s[0].match_id) / Math.max(1, s.at(-1).start_time - s[0].start_time);
    st.s.cursor = Math.round(st.s.cursor - Math.max(0, (s[0].start_time - (now - 21 * 3600)) * Math.max(1, perSec)));
  }
  const q = prioritize(fit, st.s.heroCounts, st.m.target);
  st.s.queue = [...st.s.queue, ...q].sort((a, b) => (b.need ?? 0) - (a.need ?? 0)).slice(0, 2000);
  save(st);
}

const dotaRunning = () => {
  try {
    return /dota2\.exe/i.test(execFileSync('tasklist', ['/FI', 'IMAGENAME eq dota2.exe', '/NH'], { encoding: 'utf8', windowsHide: true }));
  } catch {
    return false;
  }
};

function progress(states, note = '') {
  const lines = [`Обновлено: ${new Date().toISOString()}${note ? ` — ${note}` : ''}`, `Остаток запросов STRATZ в сутки: ${dayLeft}`];
  for (const st of states) {
    const counts = Object.values(st.s.heroCounts);
    const reached = counts.filter((n) => n >= st.m.target).length;
    lines.push(`${st.key === 'ap' ? 'All Pick' : 'Турбо'}: скачано новых ${st.have.size} (+ старых ${st.old.size}), запросов сегодня ${st.s.dayRequests}/${st.m.budget}, героев с ≥ ${st.m.target} матчами: ${reached} из ${counts.length}, меньше всего: ${Math.min(...counts)}, отклонено ${Object.keys(st.s.rejected).length}${st.s.exhausted ? ', матчи патча кончились' : ''}`);
  }
  writeFileSync(progressFile, lines.join('\n') + '\n');
}

const states = Object.keys(MODES).map(loadState);
progress(states, 'старт');
let budgetCalls = onceArg ?? Infinity;
let saved = 0;
while (budgetCalls > 0) {
  if (dotaRunning()) {
    progress(states, 'пауза: запущена Dota 2');
    await sleep(60_000);
    continue;
  }
  const today = utcDay(Date.now());
  for (const st of states) if (st.s.day !== today) Object.assign(st.s, { day: today, dayRequests: 0 });
  if (dayLeft < RESERVE_DAY) {
    progress(states, `пауза: у токена осталось ${dayLeft} запросов в сутки (запас ${RESERVE_DAY})`);
    await sleep(1800_000);
    dayLeft = RESERVE_DAY;
    continue;
  }
  // Режим с меньшей долей использованной квоты, у которого ещё есть цель
  const open = states.filter((st) => st.s.dayRequests < st.m.budget && !(st.s.exhausted && !st.s.queue.length) && Object.values(st.s.heroCounts).some((n) => n < st.m.target));
  if (!open.length) {
    const done = states.every((st) => (st.s.exhausted && !st.s.queue.length) || Object.values(st.s.heroCounts).every((n) => n >= st.m.target));
    progress(states, done ? 'готово: цель набрана или матчи патча кончились' : 'суточные квоты исчерпаны — ждём новых суток (UTC)');
    if (done) break;
    await sleep(1800_000);
    continue;
  }
  const st = open.sort((a, b) => a.s.dayRequests / a.m.budget - b.s.dayRequests / b.m.budget)[0];
  if (!st.s.queue.length) {
    await refill(st);
    continue;
  }
  const p = await ensurePatch();
  try {
    const before = st.s.requests ?? 0;
    const r = await step(
      st.s,
      {
        fetchMatch: async (id) => (await gql(Q(id))).match,
        store: (id, c) => {
          writeFileSync(join(st.dir, `${id}.json.gz`), gzipSync(JSON.stringify(c)));
          st.have.add(id);
        },
        has: (id) => st.have.has(id) || st.old.has(id),
        forbidden,
      },
      p.id,
    );
    st.s.dayRequests += (st.s.requests ?? 0) - before;
    budgetCalls -= (st.s.requests ?? 0) - before;
    if (r === 'saved' && ++saved % 25 === 0) progress(states);
  } catch (e) {
    log(`${st.key}: ${e.message}`);
    retryFailed(st.s, e.message.slice(0, 60));
    st.s.dayRequests++;
    budgetCalls--;
    await sleep(30_000);
  }
  save(st);
}
progress(states, onceArg ? `проверочный прогон (${onceArg} запросов) закончен` : 'остановлено');
log('Выход');
