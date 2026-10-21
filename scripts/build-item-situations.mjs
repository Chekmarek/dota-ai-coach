// Сборка от положения в матче (DECISIONS.md п. 79): что сильные игроки берут на герое, когда команда отстаёт или ведёт
// по счёту убийств. Только то, что прошло строгий отбор на 70% матчей и подтвердилось на отложенных 30%.
//   node scripts/build-item-situations.mjs          — пересчёт и запись src/data/item-situations.json
//   node scripts/build-item-situations.mjs --dry    — только отчёт
// Матчи: .tmp/danger (полные) и .tmp/items-ap (облегчённые, scripts/fetch-items-matches.mjs). Читаются по одному,
// в памяти — только счётчики. Экзамены, режим тени и свои матчи не читаются (forbiddenIds).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import os from 'node:os';
import { bhSelect, confirmOnHoldout, forbiddenIds, z2 } from './items-data-lib.mjs';
import { killSituation } from '../src/core/coach/item-situation.ts';

try {
  os.setPriority(0, os.constants.priority.PRIORITY_LOW);
} catch {
  // нет прав — обычный приоритет
}
const root = join(import.meta.dirname, '..');
const kb = join(root, 'resources/data/kb/7.41f');
const items = JSON.parse(readFileSync(join(kb, 'items.json'), 'utf8'));
const heroes = JSON.parse(readFileSync(join(kb, 'heroes.json'), 'utf8'));
const itemById = new Map(items.map((i) => [i.id, i]));
const heroKeyById = new Map(heroes.map((h) => [h.id, h.key]));
const major = (it) => it && it.components?.length > 0 && it.cost >= 1200 && !it.key.includes('recipe');

export const REF_MIN = 15;
export const WINDOW_MIN = 20;
const UNTIL = (REF_MIN + WINDOW_MIN) * 60;
const Z_MIN = 3;
const FDR = 0.05;
const HOLDOUT_Z = 1.645;
/** Пара «герой — позиция» участвует, если в каждом положении (отстаём/ведём) столько матчей в поисковой части */
const MIN_GAMES = 40;

/** Отложенная часть — 30% матчей по номеру (тот же матч всегда в той же части) */
export const isHoldout = (id) => (Number(BigInt(id) * 2654435761n % 100n)) < 30;

/** Матч в общем виде: [{ heroKey, pos, radiant, buys: [[sec, key]], kills: [sec] }] */
function normalize(m, compact) {
  return m.players.map((p) => ({
    heroKey: heroKeyById.get(compact ? p.hero : p.heroId),
    pos: compact ? p.pos : String(p.position ?? '').replace('POSITION_', ''),
    radiant: compact ? p.radiant : p.isRadiant,
    buys: (compact ? p.buys : (p.playbackData?.purchaseEvents ?? []).map((e) => [e.time, e.itemId])).map(([t, id]) => [t, itemById.get(id)]).filter(([, it]) => major(it)).map(([t, it]) => [t, it.key]),
    kills: compact ? p.kills : (p.playbackData?.killEvents ?? []).map((k) => k.time),
  }));
}

function* allMatches() {
  const forbidden = forbiddenIds(root);
  const seen = new Set();
  for (const [dir, compact] of [['items-ap', true], ['danger', false]]) {
    const d = join(root, '.tmp', dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d).filter((x) => x.endsWith('.json.gz'))) {
      const id = f.slice(0, -8);
      if (seen.has(id) || forbidden.has(id)) continue;
      seen.add(id);
      const m = JSON.parse(gunzipSync(readFileSync(join(d, f))).toString('utf8'));
      yield { id, dur: m.durationSeconds ?? m.dur, players: normalize(m, compact) };
    }
  }
}

// Счётчики: часть → герой|позиция → { n: {behind, ahead}, games: {key: {behind, ahead}}, buys: {behind, ahead}, keyBuys: {key: {behind, ahead}} }
const parts = { find: new Map(), hold: new Map() };
let used = 0;
let total = 0;
for (const m of allMatches()) {
  total++;
  if (m.dur < UNTIL) continue;
  used++;
  const kills = (radiant) => m.players.filter((p) => p.radiant === radiant).reduce((a, p) => a + p.kills.filter((t) => t <= REF_MIN * 60).length, 0);
  const rad = kills(true);
  const dire = kills(false);
  const part = parts[isHoldout(m.id) ? 'hold' : 'find'];
  for (const p of m.players) {
    if (!p.heroKey || !/^[1-5]$/.test(p.pos ?? '')) continue;
    const sit = p.radiant ? killSituation(rad, dire) : killSituation(dire, rad);
    if (sit !== 'behind' && sit !== 'ahead') continue;
    const k = `${p.heroKey}|${p.pos}`;
    const t = part.get(k) ?? { n: { behind: 0, ahead: 0 }, games: {}, buys: { behind: 0, ahead: 0 }, keyBuys: {} };
    part.set(k, t);
    t.n[sit]++;
    const got = new Set(p.buys.filter(([sec]) => sec <= UNTIL).map(([, key]) => key));
    t.buys[sit] += got.size;
    for (const key of got) {
      (t.games[key] ??= { behind: 0, ahead: 0 })[sit]++;
      (t.keyBuys[key] ??= { behind: 0, ahead: 0 })[sit]++;
    }
  }
}

/** Проверка предмета в части: «отстаём» — доля матчей, «ведём» — доля среди всех покупок */
function test(t, key, sit) {
  const other = sit === 'behind' ? 'ahead' : 'behind';
  if (sit === 'behind') {
    const g = t.games[key] ?? { behind: 0, ahead: 0 };
    return { ...z2(g.behind, t.n.behind, g.ahead, t.n.ahead), n: t.n.behind, nOther: t.n.ahead, measure: 'games' };
  }
  const b = t.keyBuys[key] ?? { behind: 0, ahead: 0 };
  return { ...z2(b[sit], t.buys[sit], b[other], t.buys[other]), n: t.n[sit], nOther: t.n[other], measure: 'purchases' };
}

const tests = [];
let pairsTested = 0;
for (const [k, t] of parts.find) {
  if (t.n.behind < MIN_GAMES || t.n.ahead < MIN_GAMES) continue;
  pairsTested++;
  for (const key of Object.keys(t.games)) for (const sit of ['behind', 'ahead']) {
    const r = test(t, key, sit);
    if (r.z > 0) tests.push({ k, key, sit, ...r });
  }
}
// Бенджамини — Хохберг по всем проверкам (обе стороны, все пары) и z ≥ 3; затем подтверждение на отложенных
const found = bhSelect(tests, FDR, Z_MIN);
const confirmed = confirmOnHoldout(found, (f) => {
  const h = parts.hold.get(f.k);
  return h ? test(h, f.key, f.sit) : null;
}, HOLDOUT_Z);

const pairsWith = (part, n) => [...part.values()].filter((t) => t.n.behind >= n && t.n.ahead >= n).length;
console.log(`Матчей: ${total}, не короче ${REF_MIN + WINDOW_MIN} мин: ${used} (поиск/отложено по номеру 70/30)`);
console.log(`Пар «герой — позиция» с ≥ ${MIN_GAMES} матчами в каждом положении (поиск): ${pairsTested}; с ≥ 300: ${pairsWith(parts.find, 300)}`);
console.log(`Проверок: ${tests.length}; z ≥ ${Z_MIN} и поправка (FDR ${FDR * 100}%): ${found.length}; подтвердилось на отложенных: ${confirmed.length}`);
for (const c of confirmed.slice(0, 40)) console.log(`  ${c.k} ${c.sit === 'behind' ? 'отстаём' : 'ведём'}: ${c.key} ${(c.p1 * 100).toFixed(0)}% против ${(c.p2 * 100).toFixed(0)}% (z ${c.z.toFixed(1)}; отложено ${(c.hold.p1 * 100).toFixed(0)}% против ${(c.hold.p2 * 100).toFixed(0)}%)`);
const notConfirmed = found.filter((f) => !confirmed.some((c) => c.k === f.k && c.key === f.key && c.sit === f.sit));
if (notConfirmed.length) console.log(`Не подтвердилось на отложенных: ${notConfirmed.map((f) => `${f.k} ${f.key}`).join(', ')}`);

if (!process.argv.includes('--dry')) {
  const out = { schema: 'dota-coach.item-situations', version: 1, generatedAt: new Date().toISOString(), refMin: REF_MIN, windowMin: WINDOW_MIN, note: `Матчей ${used} (Divine+ по OpenDota, патч 7.41f). Проверок ${tests.length}, прошло отбор ${found.length}, подтвердилось ${confirmed.length}.`, items: {} };
  for (const c of confirmed) {
    const [heroKey, pos] = c.k.split('|');
    ((out.items[heroKey] ??= {})[pos] ??= []).push({ key: c.key, sit: c.sit, share: Math.round(c.p1 * 1000) / 1000, other: Math.round(c.p2 * 1000) / 1000, n: c.n, nOther: c.nOther, holdout: { share: Math.round(c.hold.p1 * 1000) / 1000, other: Math.round(c.hold.p2 * 1000) / 1000, n: c.hold.n, nOther: c.hold.nOther }, measure: c.measure });
  }
  writeFileSync(join(root, 'src/data/item-situations.json'), JSON.stringify(out) + '\n');
  console.log('Записано: src/data/item-situations.json');
}
