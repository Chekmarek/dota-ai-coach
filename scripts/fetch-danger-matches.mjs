// Набор для будущей модели опасности: разобранные STRATZ рейтинговые матчи высокого ранга (Divine+) текущего патча
// с playbackData — позиции, здоровье/мана, уровни, ценность всех 10 героев по секундам, смерти и убийства.
// Только для разработчика. id матчей — из OpenDota publicMatches (рейтинг, All Pick, средний ранг ≥ Divine),
// данные — STRATZ match(id). Без ников и id игроков. Продолжает с места обрыва (состояние в state.json).
// Кладёт в .tmp/danger/<id>.json.gz (не в git).
//   node scripts/fetch-danger-matches.mjs [сколько матчей нужно, по умолчанию 2000] [--turbo]
// --turbo — Турбо (game_mode 23, любой ранг: высоких рангов в Турбо мало) в .tmp/danger-turbo.
// Экзамен (docs/EXAM.md): --dir exam1-ap — своя папка в .tmp; --exclude danger,danger-turbo,… — пропускать матчи,
// которые уже есть в этих папках (обучение, прошлые проверки); --cursor-from <папка> — начать список OpenDota с места,
// где закончила другая загрузка (не перебирать те же матчи); --inventory — сразу и инвентарь по секундам.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, appendFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');
const turbo = process.argv.includes('--turbo');
const want = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 2000);
const argOf = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const dir = join(root, '.tmp', argOf('--dir') ?? (turbo ? 'danger-turbo' : 'danger'));
const withInventory = process.argv.includes('--inventory');
/** Матчи, которые уже где-то использованы (обучение, проверки, прошлые экзамены) — не скачивать */
const excluded = new Set(
  (argOf('--exclude') ?? '')
    .split(',')
    .filter(Boolean)
    .flatMap((d) => (existsSync(join(root, '.tmp', d)) ? readdirSync(join(root, '.tmp', d)).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, -8)) : [])),
);
/** Рейтинг All Pick (lobby 7, mode 22) или Турбо (lobby 0, mode 23) */
const LOBBY = turbo ? 0 : 7, MODE = turbo ? 23 : 22, MIN_RANK = turbo ? 0 : 71;
mkdirSync(dir, { recursive: true });
const logFile = join(dir, 'fetch.log');
const log = (s) => {
  const line = `${new Date().toISOString()} ${s}`;
  console.log(line);
  appendFileSync(logFile, line + '\n');
};

const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const tokenFile = ['.stratz-token', '.stratz-token.txt'].map((f) => join(home, f)).find((f) => existsSync(f));
const token = (process.env.STRATZ_TOKEN ?? (tokenFile ? readFileSync(tokenFile, 'utf8') : '')).replace(/^﻿/, '').trim();
if (!token) throw new Error('Нет токена STRATZ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Состояние: курсор OpenDota, очередь id, отклонённые ---
const stateFile = join(dir, 'state.json');
const state = existsSync(stateFile)
  ? JSON.parse(readFileSync(stateFile, 'utf8'))
  : { cursor: null, queue: [], rejected: {}, patchFrom: null, exhausted: false };
if (!existsSync(stateFile) && argOf('--cursor-from')) {
  const other = join(root, '.tmp', argOf('--cursor-from'), 'state.json');
  if (existsSync(other)) state.cursor = JSON.parse(readFileSync(other, 'utf8')).cursor;
}
const saveState = () => {
  writeFileSync(stateFile + '.tmp', JSON.stringify(state));
  renameSync(stateFile + '.tmp', stateFile);
};
const have = () => new Set(readdirSync(dir).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, -8)));

// --- STRATZ: лимиты 8/с, 150/мин, 1 500/ч, 15 000/сут; идём не чаще раза в 3 с и смотрим остаток в заголовках ---
// DANGER_GAP_MS — реже, если параллельно идёт вторая загрузка (лимит STRATZ общий на токен)
const STRATZ_GAP_MS = Number(process.env.DANGER_GAP_MS ?? 3000);
let lastCall = 0;
async function gql(query) {
  for (let a = 1; ; a++) {
    const wait = lastCall + STRATZ_GAP_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    let res;
    try {
      res = await fetch('https://api.stratz.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' }, body: JSON.stringify({ query }), signal: AbortSignal.timeout(120_000) });
    } catch (e) {
      if (a >= 5) throw new Error(`сеть: ${e.message}`);
      await sleep(15_000 * a);
      continue;
    }
    const hour = Number(res.headers.get('x-ratelimit-remaining-hour') ?? 1000);
    const minute = Number(res.headers.get('x-ratelimit-remaining-minute') ?? 100);
    const day = Number(res.headers.get('x-ratelimit-remaining-day') ?? 10000);
    if (res.ok) {
      const j = await res.json();
      // Запас под приложение коуча (тот же токен): ночью оно может обновлять справочник
      if (day < 1500) {
        log(`STRATZ: суточный остаток ${day} — пауза 1 ч`);
        await sleep(3600_000);
      } else if (hour < 100) {
        log(`STRATZ: часовой остаток ${hour} — пауза 10 мин`);
        await sleep(600_000);
      } else if (minute < 20) await sleep(30_000);
      if (j.errors?.length) throw new Error(String(j.errors[0].message).replaceAll(token, '<token>'));
      return j.data;
    }
    if (a >= 5) throw new Error(`STRATZ HTTP ${res.status}`);
    log(`STRATZ HTTP ${res.status}, повтор ${a}`);
    await sleep(res.status === 429 ? 120_000 : 10_000 * a);
  }
}

// --- OpenDota: публичные матчи, свежие вперёд; STRATZ разбирает матч примерно через сутки ---
async function refill() {
  if (!state.patchFrom) {
    const d = await gql('{ constants { gameVersions { id name asOfDateTime } } }');
    const v = [...d.constants.gameVersions].sort((a, b) => b.asOfDateTime - a.asOfDateTime)[0];
    state.patchFrom = { id: v.id, name: v.name, asOf: v.asOfDateTime };
    log(`Патч ${v.name} (id ${v.id}) с ${new Date(v.asOfDateTime * 1000).toISOString().slice(0, 10)}`);
  }
  const url = `https://api.opendota.com/api/publicMatches?${MIN_RANK ? `min_rank=${MIN_RANK}&` : ''}${state.cursor ? `&less_than_match_id=${state.cursor}` : ''}`;
  let rows;
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'DotaCoach-danger/0.1 (local tool)' }, signal: AbortSignal.timeout(60_000) });
      if (res.ok) {
        rows = await res.json();
        break;
      }
      log(`OpenDota HTTP ${res.status}, повтор ${a}`);
    } catch (e) {
      log(`OpenDota: ${e.message}, повтор ${a}`);
    }
    await sleep(Math.min(600_000, 20_000 * a));
  }
  await sleep(1500);
  if (!rows.length) {
    state.exhausted = true;
    return;
  }
  const now = Date.now() / 1000;
  state.cursor = Math.min(...rows.map((r) => r.match_id));
  let added = 0;
  for (const r of rows) {
    if (r.start_time < state.patchFrom.asOf) state.exhausted = true;
    // режим, не короче 15 мин (Турбо — 10), сыгран не меньше 20 ч назад (STRATZ успел разобрать)
    if (r.lobby_type !== LOBBY || r.game_mode !== MODE || r.duration < (turbo ? 600 : 900) || r.start_time < state.patchFrom.asOf) continue;
    if (now - r.start_time < 20 * 3600) continue;
    state.queue.push(r.match_id);
    added++;
  }
  // самые свежие публичные матчи OpenDota ещё не разобраны — перескакиваем курсором к суточной давности
  // (id матчей растут почти равномерно по времени)
  if (!added && rows.every((r) => now - r.start_time < 20 * 3600)) {
    const s = [...rows].sort((a, b) => a.start_time - b.start_time);
    const perSec = (s.at(-1).match_id - s[0].match_id) / Math.max(1, s.at(-1).start_time - s[0].start_time);
    const back = (s[0].start_time - (now - 21 * 3600)) * Math.max(1, perSec);
    state.cursor = Math.round(state.cursor - Math.max(0, back));
    log(`Пропуск свежих: курсор → ${state.cursor}`);
  }
  saveState();
}

const PB = `playbackData {
  playerUpdatePositionEvents { time x y }
  playerUpdateHealthEvents { time hp maxHp mp maxMp }
  playerUpdateLevelEvents { time level }
  playerUpdateGoldEvents { time gold networth }
  purchaseEvents { time itemId }
  deathEvents { time timeDead isBurst isEngagedOnDeath hasHealAvailable isAttemptTpOut isDieBack positionX positionY }
  killEvents { time }${withInventory ? `
  inventoryEvents { time ${['item0', 'item1', 'item2', 'item3', 'item4', 'item5', 'backPack0', 'backPack1', 'backPack2', 'teleport0', 'neutral0'].map((x) => `${x} { itemId charges }`).join(' ')} }` : ''}
}`;
const Q = (id) => `{ match(id: ${id}) { id didRadiantWin durationSeconds gameVersionId startDateTime parsedDateTime lobbyType gameMode rank bracket averageRank
  players { heroId isRadiant isVictory position lane role kills deaths assists numLastHits goldPerMinute experiencePerMinute ${PB} } } }`;

let got = have().size;
log(`Старт: уже есть ${got}, нужно ${want}, в очереди ${state.queue.length}`);
let fails = 0;
while (got < want) {
  if (!state.queue.length) {
    if (state.exhausted) {
      log('Матчи текущего патча в OpenDota закончились');
      break;
    }
    await refill();
    continue;
  }
  const id = state.queue.shift();
  const files = have();
  if (files.has(String(id)) || state.rejected[id] || excluded.has(String(id))) {
    saveState();
    continue;
  }
  try {
    const m = (await gql(Q(id))).match;
    fails = 0;
    const ok = m && m.parsedDateTime && m.gameVersionId === state.patchFrom.id && m.players?.length === 10 && m.players.every((p) => p.playbackData?.playerUpdatePositionEvents?.length && p.playbackData?.playerUpdateHealthEvents?.length);
    if (!ok) {
      state.rejected[id] = !m ? 'нет матча' : !m.parsedDateTime ? 'не разобран' : m.gameVersionId !== state.patchFrom.id ? `патч ${m.gameVersionId}` : 'нет playbackData';
    } else {
      writeFileSync(join(dir, `${id}.json.gz`), gzipSync(JSON.stringify(m)));
      got++;
      if (got % 25 === 0) log(`Скачано ${got}/${want} (отклонено ${Object.keys(state.rejected).length})`);
    }
  } catch (e) {
    fails++;
    log(`${id}: ${e.message}`);
    state.rejected[id] = `ошибка: ${e.message.slice(0, 80)}`;
    if (fails >= 10) {
      log('10 ошибок подряд — пауза 15 мин');
      await sleep(900_000);
      fails = 0;
    }
  }
  saveState();
}
const rej = Object.values(state.rejected).reduce((a, r) => ((a[r.replace(/\d+/g, 'N')] = (a[r.replace(/\d+/g, 'N')] ?? 0) + 1), a), {});
log(`Готово: ${got} матчей в ${dir}; отклонено: ${JSON.stringify(rej)}`);
