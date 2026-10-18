// Как играют сильные игроки в рейтинге (этап 3 «понимания игры»): STRATZ heroStats по рангам Divine–Immortal за
// последнюю неделю — по каждому герою и позиции 1–5:
//  - кривые по минутам: средние добивания, ценность героя (networth), опыт, уровень (heroStats.stats, groupByTime);
//  - покупки предметов: доля матчей, медианная минута, доля побед (heroStats.itemFullPurchase).
// Только рейтинговые матчи: у сводной статистики STRATZ нет фильтра по режиму, Турбо здесь нет (проверено 2026-10-18).
// Токен STRATZ — личный ключ владельца: читается из %USERPROFILE%\.stratz-token(.txt) или STRATZ_TOKEN, никуда не
// пишется и не печатается. ~130 запросов за запуск (лимит бесплатного ключа — тысячи в час).
//   node scripts/import-stratz.mjs
// Результат: resources/data/kb/<патч>/stats-ranked.json
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const tokenFile = ['.stratz-token', '.stratz-token.txt'].map((f) => join(home, f)).find((f) => existsSync(f));
const token = (process.env.STRATZ_TOKEN ?? (tokenFile ? readFileSync(tokenFile, 'utf8') : '')).replace(/^﻿/, '').trim();
if (!token) {
  console.error('Нет токена STRATZ: положите его в %USERPROFILE%\\.stratz-token.txt (одна строка) или в STRATZ_TOKEN.');
  process.exit(1);
}
const BRACKET = 'DIVINE_IMMORTAL';
const MAX_MIN = 40;
const CURVE_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40];
/** Сколько матчей на позиции нужно, чтобы кривая и покупки считались */
const MIN_MATCHES = 200;
/** Предмет в списке позиции, если его покупают хотя бы в такой доле матчей */
const ITEM_MIN_SHARE = 0.08;
const ITEMS_KEEP = 18;
const SKIP = new Set(['tango', 'flask', 'clarity', 'enchanted_mango', 'faerie_fire', 'tpscroll', 'ward_observer', 'ward_sentry', 'ward_dispenser', 'dust', 'smoke_of_deceit', 'branches', 'blood_grenade', 'famango', 'great_famango', 'greater_famango', 'courier']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(query) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch('https://api.stratz.com/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' },
      body: JSON.stringify({ query }),
    });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text);
      if (j.errors?.length) throw new Error(`STRATZ: ${j.errors[0].message}`.replaceAll(token, '<token>'));
      return j.data;
    }
    // 429 — лимит: ждём и повторяем; остальное — до 4 попыток
    if (attempt >= 4) throw new Error(`STRATZ HTTP ${res.status}: ${text.slice(0, 200)}`.replaceAll(token, '<token>'));
    await sleep(res.status === 429 ? 30_000 : 3000 * attempt);
  }
}
const median = (pairs) => {
  // pairs: [значение, вес]
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = s.reduce((a, [, w]) => a + w, 0);
  let acc = 0;
  for (const [v, w] of s) if ((acc += w) >= total / 2) return v;
  return null;
};

const { patch } = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8'));
const kbDir = join(root, 'resources/data/kb', patch);
const heroes = JSON.parse(readFileSync(join(kbDir, 'heroes.json'), 'utf8'));
const items = JSON.parse(readFileSync(join(kbDir, 'items.json'), 'utf8'));
const itemKeyById = new Map(items.map((i) => [i.id, i.key]));

// Патч STRATZ должен совпадать с базой знаний — иначе данные другого баланса
const versions = (await gql('{ constants { gameVersions { id name } } }')).constants.gameVersions;
if (versions[0]?.name !== patch) {
  console.error(`Последний патч STRATZ — ${versions[0]?.name}, а база знаний — ${patch}. Сначала npm run kb:import.`);
  process.exit(1);
}

const out = [];
let calls = 1;
for (const h of heroes) {
  const q = `{ heroStats {
    stats(heroIds: [${h.id}], bracketBasicIds: [${BRACKET}], groupByTime: true, groupByPosition: true, maxTime: ${MAX_MIN}) { time position matchCount cs networth xp level }
    itemFullPurchase(heroId: ${h.id}, bracketBasicIds: [${BRACKET}]) { itemId time matchCount winCount position }
  } }`;
  let d;
  try {
    d = (await gql(q)).heroStats;
    calls++;
  } catch (e) {
    console.warn(`${h.key}: ${e.message}`);
    continue;
  }
  const curves = {};
  const matchesByPos = {};
  for (const r of d.stats) {
    const pos = String(r.position ?? '').replace('POSITION_', '');
    if (!/^[1-5]$/.test(pos)) continue;
    if (r.time === 0) matchesByPos[pos] = r.matchCount;
    if (!CURVE_MINUTES.includes(r.time)) continue;
    const c = (curves[pos] ??= { n: 0, at: {} });
    c.n = Math.max(c.n, r.matchCount);
    // [добивания, ценность героя, опыт, уровень] — средние по матчам, которые дожили до этой минуты
    if (r.matchCount >= MIN_MATCHES) c.at[r.time] = [Math.round(r.cs * 10) / 10, Math.round(r.networth), Math.round(r.xp), Math.round(r.level * 10) / 10];
  }
  for (const [pos, c] of Object.entries(curves)) if (c.n < MIN_MATCHES || !Object.keys(c.at).length) delete curves[pos];
  const buys = {};
  for (const r of d.itemFullPurchase) {
    const pos = String(r.position ?? '').replace('POSITION_', '');
    const key = itemKeyById.get(r.itemId);
    if (!/^[1-5]$/.test(pos) || !key || SKIP.has(key)) continue;
    const b = ((buys[pos] ??= {})[key] ??= { n: 0, w: 0, times: [] });
    b.n += r.matchCount;
    b.w += r.winCount;
    b.times.push([r.time, r.matchCount]);
  }
  const itemsByPos = {};
  for (const [pos, list] of Object.entries(buys)) {
    const total = matchesByPos[pos] ?? curves[pos]?.n ?? 0;
    if (total < MIN_MATCHES) continue;
    itemsByPos[pos] = Object.entries(list)
      .map(([key, b]) => ({ key, share: Math.round((b.n / total) * 1000) / 1000, medianMin: median(b.times), winrate: Math.round((b.w / b.n) * 1000) / 1000 }))
      .filter((x) => x.share >= ITEM_MIN_SHARE && x.medianMin !== null)
      .sort((a, b) => a.medianMin - b.medianMin)
      .slice(0, ITEMS_KEEP);
  }
  out.push({ id: h.id, key: h.key, matches: matchesByPos, curves, items: itemsByPos });
  if (out.length % 20 === 0) console.log(`  героев: ${out.length}`);
  await sleep(400);
}

const file = {
  schema: 'dota-coach.stats-ranked',
  version: 1,
  patch,
  bracket: BRACKET,
  generatedAt: new Date().toISOString(),
  verification: 'imported-unverified',
  note: 'Рейтинговые матчи рангов Divine–Immortal за последнюю неделю (STRATZ heroStats). Кривые — средние значения по минутам: [добивания, ценность героя, опыт, уровень]. Турбо здесь нет.',
  source: { name: 'STRATZ heroStats.stats / itemFullPurchase', calls },
  heroes: out,
};
writeFileSync(join(kbDir, 'stats-ranked.json'), JSON.stringify(file));
console.log(`Готово: героев ${out.length}, запросов ${calls} → ${join(kbDir, 'stats-ranked.json')}`);
