// Импорт статистики текущего патча для подсказок коуча (только чтение открытых данных OpenDota):
//  - матчапы и доля побед героев — публичные рейтинговые матчи «All Pick» с даты выхода патча (не старше 7 дней);
//  - сборки предметов (что и на какой минуте покупают), порядок навыков, добивания к 10-й минуте —
//    профессиональные матчи с даты выхода патча (OpenDota explorer, таблицы matches / player_matches);
//  - ориентиры GPM / XPM / добиваний в минуту — OpenDota /benchmarks (свежие публичные матчи);
//  - связки (доля побед пары героев в одной команде) — те же публичные матчи, что и матчапы (для драфта);
//  - позиции 1–5 по профи патча (место по GPM в своей команде) и запасные сборки OpenDota /itemPopularity
//    для героев, которых профи почти не берут (там данные не только текущего патча — помечены как «популярное»).
// Защита от старых данных: патч берётся из базы знаний (resources/data/kb/current.json) и сверяется с последним патчем
// Valve (datafeed). Не совпадает — импорт останавливается: сначала обновите базу (npm run kb:import).
// Все значения — imported-unverified (собраны автоматически, вручную не сверены).
//   node scripts/import-stats.mjs
// Результат: resources/data/kb/<патч>/stats.json
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALVE = 'https://www.dota2.com/datafeed';
const OD = 'https://api.opendota.com/api';
const MATCHUP_DAYS = 7;
const PRO_PAGE = 1000;
/** Сколько предметов сборки и первых уровней навыков хранить */
const ITEMS_KEEP = 14;
const SKILL_LEVELS = 18;
/** Расходники, варды и составные части не считаем «предметами сборки» */
const BUILD_SKIP = new Set([
  'tango', 'flask', 'clarity', 'enchanted_mango', 'faerie_fire', 'tpscroll', 'ward_observer', 'ward_sentry', 'ward_dispenser',
  'dust', 'smoke_of_deceit', 'branches', 'blood_grenade', 'famango', 'great_famango', 'greater_famango', 'courier',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'DotaCoach-stats-import/0.1 (local tool)' } });
      if (res.status === 400) {
        const body = (await res.text()).slice(0, 200);
        // таймаут запроса explorer повторяем, остальные ошибки запроса — сразу наружу
        throw Object.assign(new Error(`HTTP 400: ${body}`), { fatal: !/timeout/i.test(body) });
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e.fatal || attempt >= 4) throw new Error(`${url.slice(0, 120)}: ${e.message}`);
      await sleep(3000 * attempt);
    }
  }
}
async function sql(query) {
  const d = await getJson(`${OD}/explorer?sql=${encodeURIComponent(query)}`);
  if (d.err) throw new Error(`explorer: ${d.err}`);
  return d.rows;
}
const median = (a) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const r3 = (x) => Math.round(x * 1000) / 1000;

// --- Патч: база знаний и Valve должны совпадать ---
const { patch } = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8'));
const kbDir = join(root, 'resources/data/kb', patch);
const meta = JSON.parse(readFileSync(join(kbDir, 'meta.json'), 'utf8'));
const heroes = JSON.parse(readFileSync(join(kbDir, 'heroes.json'), 'utf8'));
const items = JSON.parse(readFileSync(join(kbDir, 'items.json'), 'utf8'));
const valvePatches = (await getJson(`${VALVE}/patchnoteslist?language=english`)).patches;
const latest = valvePatches[valvePatches.length - 1];
if (latest.patch_number !== patch) {
  console.error(`Последний патч Valve — ${latest.patch_number}, а база знаний — ${patch}. Сначала npm run kb:import.`);
  process.exit(1);
}
const patchStart = latest.patch_timestamp;
const now = Math.floor(Date.now() / 1000);
const since = Math.max(patchStart, now - MATCHUP_DAYS * 86400);
console.log(`Патч ${patch} с ${new Date(patchStart * 1000).toISOString().slice(0, 10)}; матчапы с ${new Date(since * 1000).toISOString()}`);

const heroById = new Map(heroes.map((h) => [h.id, h]));
const abilityKeyById = new Map(heroes.flatMap((h) => h.abilities.map((a) => [a.id, a.key])));
const itemKeys = new Set(items.map((i) => i.key));
const out = new Map(heroes.map((h) => [h.id, { id: h.id, key: h.key, pub: null, matchups: {}, synergy: {}, pro: null, popular: null, bench: null }]));

// --- Матчапы и доля побед (публичные рейтинговые All Pick) ---
// Запросы по 6 часов: за неделю целиком explorer не успевает (ограничение времени запроса)
const pairAcc = new Map(); // "a:b" → [игр, побед a]
const allyAcc = new Map(); // "a:b" (a и b в одной команде) → [игр, побед]
const soloAcc = new Map(); // a → [игр, побед]
let pubMatches = 0;
const STEP = 6 * 3600;
for (let from = since; from < now; from += STEP) {
  const pub = `public_matches where start_time >= ${from} and start_time < ${Math.min(from + STEP, now)} and lobby_type = 7 and game_mode = 22`;
  const pairs = await sql(
    `select a, b, sum(n) n, sum(w) w from (
       select a, b, count(*) n, sum(case when radiant_win then 1 else 0 end) w
         from (select unnest(radiant_team) a, dire_team d, radiant_win from ${pub}) t, unnest(d) b group by a, b
       union all
       select a, b, count(*) n, sum(case when radiant_win then 0 else 1 end) w
         from (select unnest(dire_team) a, radiant_team d, radiant_win from ${pub}) t, unnest(d) b group by a, b
     ) u group by a, b`,
  );
  const allies = await sql(
    `select a, b, sum(n) n, sum(w) w from (
       select a, b, count(*) n, sum(case when radiant_win then 1 else 0 end) w
         from (select unnest(radiant_team) a, radiant_team t, radiant_win from ${pub}) x, unnest(t) b where a <> b group by a, b
       union all
       select a, b, count(*) n, sum(case when radiant_win then 0 else 1 end) w
         from (select unnest(dire_team) a, dire_team t, radiant_win from ${pub}) x, unnest(t) b where a <> b group by a, b
     ) u group by a, b`,
  );
  for (const r of allies) {
    const k = `${r.a}:${r.b}`;
    const acc = allyAcc.get(k) ?? [0, 0];
    acc[0] += Number(r.n);
    acc[1] += Number(r.w);
    allyAcc.set(k, acc);
  }
  for (const r of pairs) {
    const k = `${r.a}:${r.b}`;
    const acc = pairAcc.get(k) ?? [0, 0];
    acc[0] += Number(r.n);
    acc[1] += Number(r.w);
    pairAcc.set(k, acc);
    // каждая игра героя a даёт 5 пар — по ним же считаем общую долю побед a
    const s = soloAcc.get(Number(r.a)) ?? [0, 0];
    s[0] += Number(r.n) / 5;
    s[1] += Number(r.w) / 5;
    soloAcc.set(Number(r.a), s);
  }
  console.log(`  с ${new Date(from * 1000).toISOString().slice(0, 13)}: пар ${pairs.length}`);
  await sleep(1100);
}
for (const [a, [n, w]] of soloAcc) {
  const h = out.get(a);
  if (!h || n < 1) continue;
  h.pub = { games: Math.round(n), winrate: r3(w / n) };
  pubMatches += n;
}
pubMatches = Math.round(pubMatches / 10);
for (const [k, [n, w]] of pairAcc) {
  const [a, b] = k.split(':').map(Number);
  const h = out.get(a);
  if (!h || !heroById.has(b)) continue;
  // [игр, доля побед героя a против героя b]
  h.matchups[b] = [n, r3(w / n)];
}
for (const [k, [n, w]] of allyAcc) {
  const [a, b] = k.split(':').map(Number);
  const h = out.get(a);
  if (!h || !heroById.has(b)) continue;
  // [игр вместе, доля побед пары]
  h.synergy[b] = [n, r3(w / n)];
}
console.log(`Публичных матчей: ${pubMatches}, пар героев: ${pairAcc.size}, связок: ${allyAcc.size}`);

// --- Профессиональные матчи патча: сборки, навыки, добивания ---
const proRows = [];
for (let lastId = 0; ; ) {
  const rows = await sql(
    `select m.match_id, m.duration, m.radiant_win, pm.player_slot, pm.hero_id, pm.lane_role, pm.gold_per_min, pm.purchase_log, pm.ability_upgrades_arr, pm.lh_t
       from matches m join player_matches pm using(match_id)
      where m.start_time >= ${patchStart} and m.match_id > ${lastId}
      order by m.match_id, pm.player_slot limit ${PRO_PAGE}`,
  );
  if (!rows.length) break;
  // страница может оборвать матч посередине — дочитываем его следующим запросом
  const lastMatch = rows[rows.length - 1].match_id;
  const full = rows.length < PRO_PAGE ? rows : rows.filter((r) => r.match_id !== lastMatch);
  proRows.push(...full);
  if (rows.length < PRO_PAGE) break;
  lastId = full.length ? full[full.length - 1].match_id : lastMatch;
  await sleep(1100);
}
const proMatches = new Set(proRows.map((r) => r.match_id)).size;
console.log(`Профессиональных матчей: ${proMatches}, строк игроков: ${proRows.length}`);

// Позиция 1–5: место игрока по GPM в своей команде (1 — больше всех золота). Для саппортов (4/5) точнее не бывает.
const teamOf = new Map();
for (const r of proRows) {
  const k = `${r.match_id}:${r.player_slot < 128}`;
  if (!teamOf.has(k)) teamOf.set(k, []);
  teamOf.get(k).push(r);
}
for (const team of teamOf.values()) {
  if (team.length !== 5) continue;
  [...team].sort((a, b) => (b.gold_per_min ?? 0) - (a.gold_per_min ?? 0)).forEach((r, i) => (r.pos = i + 1));
}
const byHero = new Map();
for (const r of proRows) {
  if (!byHero.has(r.hero_id)) byHero.set(r.hero_id, []);
  byHero.get(r.hero_id).push(r);
}
for (const [heroId, rows] of byHero) {
  const h = out.get(heroId);
  if (!h) continue;
  const n = rows.length;
  const firstBuy = new Map(); // ключ → минуты первой покупки
  const start = new Map();
  const lhByRole = {};
  const posCount = [0, 0, 0, 0, 0];
  const skillVotes = Array.from({ length: SKILL_LEVELS }, () => new Map());
  let wins = 0;
  for (const r of rows) {
    const radiant = r.player_slot < 128;
    if (radiant === r.radiant_win) wins++;
    if (r.pos) posCount[r.pos - 1]++;
    const seen = new Set();
    for (const p of r.purchase_log ?? []) {
      if (!itemKeys.has(p.key) || seen.has(p.key)) continue;
      seen.add(p.key);
      if (p.time <= 0) start.set(p.key, (start.get(p.key) ?? 0) + 1);
      else if (!BUILD_SKIP.has(p.key)) {
        if (!firstBuy.has(p.key)) firstBuy.set(p.key, []);
        firstBuy.get(p.key).push(p.time / 60);
      }
    }
    (r.ability_upgrades_arr ?? []).slice(0, SKILL_LEVELS).forEach((id, i) => {
      const key = abilityKeyById.get(id) ?? (id ? `talent:${id}` : null);
      if (key) skillVotes[i].set(key, (skillVotes[i].get(key) ?? 0) + 1);
    });
    if (Array.isArray(r.lh_t) && r.lh_t.length > 10 && r.lane_role) {
      (lhByRole[r.lane_role] ??= []).push(r.lh_t[10]);
    }
  }
  const build = [...firstBuy.entries()]
    .map(([key, mins]) => ({ key, share: r3(mins.length / n), medianMin: Math.round(median(mins) * 10) / 10 }))
    .filter((x) => x.share >= 0.15)
    .sort((a, b) => a.medianMin - b.medianMin)
    .slice(0, ITEMS_KEEP);
  const startItems = [...start.entries()].map(([key, c]) => ({ key, share: r3(c / n) })).filter((x) => x.share >= 0.3).sort((a, b) => b.share - a.share);
  const skills = skillVotes.map((m) => {
    const best = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
    return best ? { key: best[0].startsWith('talent:') ? 'talent' : best[0], share: r3(best[1] / n) } : null;
  });
  const lhAt10 = {};
  for (const [role, v] of Object.entries(lhByRole)) if (v.length >= 3) lhAt10[role] = { median: median(v), n: v.length };
  const posN = posCount.reduce((a, b) => a + b, 0);
  const positions = posN ? posCount.map((c) => r3(c / posN)) : null;
  h.pro = { games: n, winrate: r3(wins / n), build, startItems, skills, lhAt10, positions };
}

// --- Ориентиры: OpenDota benchmarks (свежие публичные матчи) ---
const pick = (arr, p) => arr?.find((x) => Math.abs(x.percentile - p) < 1e-6)?.value ?? null;
let benchOk = 0;
for (const h of heroes) {
  try {
    const b = await getJson(`${OD}/benchmarks?hero_id=${h.id}`);
    const res = b.result ?? {};
    const pct = (k) => (res[k] ? { p50: pick(res[k], 0.5), p80: pick(res[k], 0.8) } : null);
    out.get(h.id).bench = { gpm: pct('gold_per_min'), xpm: pct('xp_per_min'), lhPerMin: pct('last_hits_per_min') };
    benchOk++;
  } catch (e) {
    console.warn(`benchmarks ${h.key}: ${e.message}`);
  }
  await sleep(1100);
}

// --- Запасные сборки: OpenDota /itemPopularity (недавние разобранные матчи, не только этот патч) ---
// Нужны для героев, у которых в профи патча меньше POPULAR_IF_PRO_BELOW игр
const POPULAR_IF_PRO_BELOW = 15;
const itemKeyById = new Map(items.map((i) => [i.id, i.key]));
let popularOk = 0;
for (const h of heroes) {
  if ((out.get(h.id).pro?.games ?? 0) >= POPULAR_IF_PRO_BELOW) continue;
  try {
    const p = await getJson(`${OD}/heroes/${h.id}/itemPopularity`);
    const top = (phase, keep) =>
      Object.entries(p[phase] ?? {})
        .map(([id, c]) => ({ key: itemKeyById.get(Number(id)), count: Number(c) }))
        .filter((x) => x.key && !BUILD_SKIP.has(x.key))
        .sort((a, b) => b.count - a.count)
        .slice(0, keep);
    out.get(h.id).popular = { start: top('start_game_items', 6), early: top('early_game_items', 6), mid: top('mid_game_items', 8), late: top('late_game_items', 8) };
    popularOk++;
  } catch (e) {
    console.warn(`itemPopularity ${h.key}: ${e.message}`);
  }
  await sleep(1100);
}

const stats = {
  schema: 'dota-coach.kb-stats',
  version: 1,
  patch,
  patchStart: new Date(patchStart * 1000).toISOString(),
  generatedAt: new Date().toISOString(),
  verification: 'imported-unverified',
  note: 'Собрано автоматически из OpenDota только по матчам текущего патча. Публичные данные — ранговые All Pick за последние дни, сборки и навыки — профессиональные матчи патча.',
  sources: [
    { name: 'OpenDota explorer: public_matches', covers: ['matchups', 'winrate'], since: new Date(since * 1000).toISOString(), matches: pubMatches },
    { name: 'OpenDota explorer: matches / player_matches (профессиональные)', covers: ['build', 'startItems', 'skills', 'lhAt10'], since: new Date(patchStart * 1000).toISOString(), matches: proMatches },
    { name: 'OpenDota /benchmarks', covers: ['bench'], heroes: benchOk },
    { name: 'OpenDota explorer: public_matches (одна команда)', covers: ['synergy'], since: new Date(since * 1000).toISOString(), matches: pubMatches },
    { name: 'OpenDota /heroes/{id}/itemPopularity (недавние разобранные матчи, не только этот патч)', covers: ['popular'], heroes: popularOk },
  ],
  heroes: [...out.values()],
};
writeFileSync(join(kbDir, 'stats.json'), JSON.stringify(stats));
console.log(`Готово: ${join(kbDir, 'stats.json')}`);
