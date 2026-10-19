// Обучение и проверка модели опасности (docs/DANGER_MODEL.md). Только для разработчика, по флагу — как «режим тени»
// (ядро коуча импортирует JSON так, как умеет только сборщик, поэтому через vitest):
//   $env:DOTACOACH_DANGER_TRAIN='1'; npx vitest run tests/unit/danger-train.test.ts
// Параметры: DANGER_TRAIN_MAX (матчей All Pick для обучения, 1200), DANGER_EVAL_MAX (отложенных на режим, 120),
// DANGER_STEP (шаг строк, с, 5), DANGER_WRITE=1 — записать src/data/danger-model.json и .tmp/danger-eval.json.
// Данные: .tmp/danger (All Pick, Divine+) и .tmp/danger-turbo (Турбо) — scripts/fetch-danger-matches.mjs.
// 1. Матчи делятся по id: 70% обучение, 10% подбор порога, 20% проверка (отложенные).
// 2. Строки: каждые DANGER_STEP с живого героя — снимок коуча, как в игре (свой герой + видимые враги: туман войны
//    по обзору своих героев, полоски врагов рядом), признаки dangerFeatures; ответ — умер ли в ближайшие 15 с.
// 3. Логистическая регрессия: All Pick → затем дообучение на Турбо (с весов All Pick).
// 4. Порог и сравнение с правилами: настоящий движок коуча посекундно (как «режим тени»): предупреждения правил
//    о риске против предупреждений модели при не большем их числе — на отложенных матчах, отдельно по режимам.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { realData, sim, type SimPlayer } from './coach-sim.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { buildView } from '../../src/core/coach/view.ts';
import { parseStatsRanked } from '../../src/shared/types/stats-ranked.ts';
import { DANGER_CONSUMABLES, DANGER_FEATURES, DANGER_HORIZON_SEC, dangerFeatures, dangerProbability, itemValueOf, RISK_RULES } from '../../src/core/coach/danger-model.ts';

const root = join(import.meta.dirname, '../..');
const env = (k: string, d: number) => (process.env[k] ? Number(process.env[k]) : d);
const TRAIN_MAX = env('DANGER_TRAIN_MAX', 1200);
const EVAL_MAX = env('DANGER_EVAL_MAX', 120);
const STEP = env('DANGER_STEP', 5);
const WRITE = process.env.DANGER_WRITE === '1';
/** Полезное предупреждение — за 2…15 с до смерти (позже уже не успеть отойти) */
const WARN_FROM = 15, WARN_TO = 2;
const COOLDOWN = 20;

type Ev<T> = ({ time: number } & T)[];
interface DPlayer {
  heroId: number;
  isRadiant: boolean;
  position: string | null;
  playbackData: {
    playerUpdatePositionEvents: Ev<{ x: number; y: number }>;
    playerUpdateHealthEvents: Ev<{ hp: number; maxHp: number; mp: number; maxMp: number }>;
    playerUpdateLevelEvents: Ev<{ level: number }>;
    playerUpdateGoldEvents: Ev<{ gold: number; networth: number }>;
    purchaseEvents: Ev<{ itemId: number }>;
    deathEvents: Ev<{ timeDead: number }>;
    killEvents: Ev<object>;
  };
}
interface DMatch {
  id: number;
  durationSeconds: number;
  players: DPlayer[];
  /** Инвентарь по секундам (scripts/fetch-danger-inventory.mjs) — только у матчей подбора порога и проверки */
  inv?: Map<number, Ev<Record<string, { itemId: number; charges: number | null } | null>>>;
}
type W = { bias: number; w: number[] };
/** Свой герой владельца в его записанных матчах (gsi-sessions 2026-10-18); 9050641393 — просмотр записи, героя нет */
const OWN_HEROES: Record<string, string> = { '9050466932': 'bristleback', '9051282375': 'bristleback', '9051474634': 'ogre_magi', '9051586060': 'shadow_shaman' };
type P = { x: number; y: number };

// --- Матчи ---
const load = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.json.gz')).sort().map((f) => join(dir, f)) : []);
const split = (file: string) => {
  const id = Number(/(\d+)\.json\.gz$/.exec(file)![1]);
  const h = (id * 2654435761) % 100;
  return h < 70 ? 'train' : h < 80 ? 'val' : 'test';
};
function readMatch(f: string): DMatch {
  const m = JSON.parse(gunzipSync(readFileSync(f)).toString('utf8')) as DMatch;
  const invFile = join(f, '..', 'inv', f.split(/[\/]/).pop()!);
  if (existsSync(invFile)) {
    const inv = JSON.parse(gunzipSync(readFileSync(invFile)).toString('utf8')) as { players: { heroId: number; playbackData: { inventoryEvents: Ev<Record<string, { itemId: number; charges: number | null } | null>> } | null }[] };
    m.inv = new Map(inv.players.filter((p) => p.playbackData).map((p) => [p.heroId, p.playbackData!.inventoryEvents]));
  }
  return m;
}
const INV_SLOTS = [['item0', 'inv0'], ['item1', 'inv1'], ['item2', 'inv2'], ['item3', 'inv3'], ['item4', 'inv4'], ['item5', 'inv5'], ['backPack0', 'stash1'], ['backPack1', 'stash2'], ['backPack2', 'stash3'], ['teleport0', 'tp'], ['neutral0', 'neutral']] as const;

// --- Таймлайн игрока ---
const world = (c: number) => c * 128 - 16240;
function at<T extends { time: number }>(evs: readonly T[], t: number): T | null {
  let lo = 0, hi = evs.length - 1, best: T | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (evs[m]!.time <= t) (best = evs[m]!), (lo = m + 1);
    else hi = m - 1;
  }
  return best;
}
const deadAt = (p: DPlayer, t: number) => p.playbackData.deathEvents.some((d) => t >= d.time && t < d.time + Math.max(1, d.timeDead));
const posAt = (p: DPlayer, t: number): P | null => {
  const e = at(p.playbackData.playerUpdatePositionEvents, t);
  return e ? { x: world(e.x), y: world(e.y) } : null;
};
const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
/** День 0:00–5:00, ночь 5:00–10:00 и т. д.; обзор героя днём ~1800, ночью ~800 */
const night = (t: number) => Math.floor(Math.max(0, t) / 300) % 2 === 1;
/** Полоска врага «на экране» — враг ближе к своему герою */
const SCREEN = 1400;
const diesSoon = (me: DPlayer, t: number) => me.playbackData.deathEvents.some((d) => d.time > t && d.time <= t + DANGER_HORIZON_SEC);

function harness() {
  const ranked = parseStatsRanked(JSON.parse(readFileSync(join(root, 'resources/data/kb/7.41f/stats-ranked.json'), 'utf8')), '7.41f');
  // Модели в данных движка нет: правила работают как без неё (их и сравниваем)
  const data: CoachData = { ...realData(), statsRanked: ranked, dangerModel: null };
  const look = new CoachLookup(data);
  const itemKey = new Map(data.items.map((i) => [i.id, i.key]));

  /**
   * Предметы своего героя на секунде t (если инвентарь скачан). Перезарядок в STRATZ нет: Town Portal Scroll — «не
   * известно» (как в «режиме тени»), остальное — готово. Без инвентаря — пусто (реген и ТП неизвестны).
   */
  function itemsAt(m: DMatch, me: DPlayer, t: number) {
    const evs = m.inv?.get(me.heroId);
    const inv = evs ? at(evs, t) : null;
    const items: { slot: string; key: string; charges: number | null; cooldownSec: number | null }[] = [];
    if (inv)
      for (const [from, slot] of INV_SLOTS) {
        const it = inv[from];
        const key = it ? itemKey.get(it.itemId) : undefined;
        if (key) items.push({ slot, key, charges: it!.charges ?? null, cooldownSec: slot === 'tp' ? null : 0 });
      }
    return items;
  }

  /** Снимок, как его видит коуч игрока me на секунде t (тот же sim, что в «режиме тени») */
  function snapshot(m: DMatch, me: DPlayer, t: number, lastSeen: Map<DPlayer, number>, turbo: boolean) {
    const allies = m.players.filter((p) => p !== me && p.isRadiant === me.isRadiant);
    const enemies = m.players.filter((p) => p.isRadiant !== me.isRadiant);
    const myPos = posAt(me, t);
    const hp = at(me.playbackData.playerUpdateHealthEvents, t);
    const lvl = at(me.playbackData.playerUpdateLevelEvents, t)?.level ?? 1;
    const gold = at(me.playbackData.playerUpdateGoldEvents, t);
    const vision = night(t) ? 800 : 1800;
    const watchers = [me, ...allies].filter((p) => !deadAt(p, t)).map((p) => posAt(p, t)).filter((x): x is P => x !== null);
    const enemyInputs: SimPlayer[] = enemies.map((p, k) => {
      const ep = posAt(p, t);
      const dead = deadAt(p, t);
      const seen = !dead && ep !== null && watchers.some((w) => dist(w, ep) <= vision);
      if (seen) lastSeen.set(p, t);
      const h = at(p.playbackData.playerUpdateHealthEvents, t);
      const onScreen = seen && myPos !== null && dist(myPos, ep!) <= SCREEN;
      return {
        slot: (me.isRadiant ? 5 : 0) + k,
        hero: look.heroById.get(p.heroId)?.key ?? 'axe',
        alive: !dead,
        pos: seen ? ep : dead ? undefined : null,
        missingForSec: seen ? 0 : t - (lastSeen.get(p) ?? 0),
        hpPercent: onScreen && h ? Math.round((h.hp / Math.max(1, h.maxHp)) * 100) : null,
        barLevel: onScreen ? (at(p.playbackData.playerUpdateLevelEvents, t)?.level ?? null) : null,
      };
    });
    const allyInputs: SimPlayer[] = allies.map((p, k) => ({ slot: (me.isRadiant ? 0 : 5) + k + 1, hero: look.heroById.get(p.heroId)?.key ?? 'axe', alive: !deadAt(p, t), pos: posAt(p, t) }));
    const kills = (radiant: boolean) => m.players.filter((p) => p.isRadiant === radiant).reduce((s, p) => s + p.playbackData.killEvents.filter((k) => k.time <= t).length, 0);
    let itemValue = 0;
    for (const e of me.playbackData.purchaseEvents) {
      if (e.time > t) break;
      const k = itemKey.get(e.itemId);
      if (k && !DANGER_CONSUMABLES.has(k)) itemValue += look.itemCost(k) ?? 0;
    }
    const s = sim({
      wallMs: 1_000_000 + t * 1000,
      clock: t,
      mode: turbo ? { mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' } : { mode: 'all-pick', source: 'gsi', raw: 'DOTA_GAMEMODE_AP' },
      team: me.isRadiant ? 'radiant' : 'dire',
      heroKey: look.heroById.get(me.heroId)?.key ?? 'antimage',
      heroId: me.heroId,
      level: lvl,
      hp: hp?.hp ?? 600,
      maxHp: hp?.maxHp ?? 600,
      mana: hp?.mp ?? 300,
      maxMana: hp?.maxMp ?? 300,
      gold: gold?.gold ?? 600,
      night: night(t),
      scoreRadiant: kills(true),
      scoreDire: kills(false),
      alive: !deadAt(me, t),
      respawnSec: deadAt(me, t) ? 20 : 0,
      pos: myPos ?? undefined,
      items: itemsAt(m, me, t),
      abilities: [],
      enemies: enemyInputs,
      allies: allyInputs,
      buildings: null,
    });
    return { s, itemValue };
  }

  /** Строки для обучения и оценки AUC */
  function rows(files: string[], turbo: boolean) {
    const X: number[][] = [], Y: number[] = [];
    for (const f of files) {
      const m = readMatch(f);
      for (const me of m.players) {
        const lastSeen = new Map<DPlayer, number>();
        for (let t = 0; t <= m.durationSeconds - DANGER_HORIZON_SEC; t += STEP) {
          if (deadAt(me, t)) continue;
          const { s, itemValue } = snapshot(m, me, t, lastSeen, turbo);
          const x = dangerFeatures(buildView(s.state, s.gsi, s.state.wallMs), { itemValue, turbo });
          if (!x) continue;
          X.push(x);
          Y.push(diesSoon(me, t) ? 1 : 0);
        }
      }
    }
    return { X, Y };
  }

  interface Rec {
    matchId: string;
    heroKey: string | null;
    rules: number[];
    probs: [number, number[]][];
    deaths: number[];
    aliveSec: number;
  }
  /** Движок коуча посекундно: предупреждения правил о риске и признаки модели из того же снимка */
  function engineRun(files: string[], turbo: boolean): Rec[] {
    const out: Rec[] = [];
    for (const f of files) {
      const m = readMatch(f);
      for (const me of m.players) {
        const pos = (me.position ?? '').replace('POSITION_', '');
        let now = 1_000_000;
        const e = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), position: /^[1-5]$/.test(pos) ? (pos as '1') : 'auto', aiLive: false } });
        const lastSeen = new Map<DPlayer, number>();
        const rec: Rec = { matchId: String(m.id), heroKey: look.heroById.get(me.heroId)?.key ?? null, rules: [], probs: [], deaths: me.playbackData.deathEvents.map((d) => d.time), aliveSec: 0 };
        for (let t = 0; t <= m.durationSeconds; t++) {
          now = 1_000_000 + t * 1000;
          const snap = snapshot(m, me, t, lastSeen, turbo);
          const s = snap.s;
          // Как в игре: стоимость предметов — по инвентарю (если скачан), при обучении — по покупкам
          const itemValue = m.inv ? itemValueOf(itemsAt(m, me, t).map((i) => i.key), (k) => look.itemCost(k)) : snap.itemValue;
          const u = e.tick(s.state, s.gsi, now);
          if (deadAt(me, t)) continue;
          rec.aliveSec++;
          if (u.shown.some((h) => (RISK_RULES as readonly string[]).includes(h.id.split(':')[0]!))) rec.rules.push(t);
          const v = e.currentView;
          const x = v ? dangerFeatures(v, { itemValue, turbo }) : null;
          if (x) rec.probs.push([t, x]);
        }
        out.push(rec);
      }
    }
    return out;
  }
  return { rows, engineRun };
}

// --- Логистическая регрессия (Adam, L2) ---
function train(X: number[][], Y: number[], init: W | null = null, epochs = 40, l2 = 1e-4, lr = 0.05): W {
  const n = X.length, d = DANGER_FEATURES.length;
  const w = init ? [...init.w] : new Array<number>(d).fill(0);
  const pos = Y.reduce((a, c) => a + c, 0);
  let b = init ? init.bias : Math.log((pos + 1) / (n - pos + 1));
  const m1 = new Array<number>(d + 1).fill(0), m2 = new Array<number>(d + 1).fill(0);
  const batch = 4096;
  let step = 0;
  const order = [...Array(n).keys()];
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  for (let ep = 0; ep < epochs; ep++) {
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [order[i], order[j]] = [order[j]!, order[i]!];
    }
    for (let s = 0; s < n; s += batch) {
      const g = new Array<number>(d + 1).fill(0);
      const e = Math.min(n, s + batch);
      for (let k = s; k < e; k++) {
        const x = X[order[k]!]!;
        let z = b;
        for (let q = 0; q < d; q++) z += w[q]! * x[q]!;
        const err = 1 / (1 + Math.exp(-z)) - Y[order[k]!]!;
        for (let q = 0; q < d; q++) g[q]! += err * x[q]!;
        g[d]! += err;
      }
      step++;
      for (let q = 0; q <= d; q++) {
        const gq = g[q]! / (e - s) + (q < d ? l2 * w[q]! : 0);
        m1[q] = 0.9 * m1[q]! + 0.1 * gq;
        m2[q] = 0.999 * m2[q]! + 0.001 * gq * gq;
        const upd = (lr * (m1[q]! / (1 - 0.9 ** step))) / (Math.sqrt(m2[q]! / (1 - 0.999 ** step)) + 1e-8);
        if (q < d) w[q]! -= upd;
        else b -= upd;
      }
    }
  }
  return { bias: b, w };
}
function auc(p: number[], y: number[]): number | null {
  const idx = [...p.keys()].sort((a, b) => p[a]! - p[b]!);
  let pos = 0, rankSum = 0;
  idx.forEach((i, r) => {
    if (y[i]) (pos++, (rankSum += r + 1));
  });
  const neg = y.length - pos;
  return pos && neg ? (rankSum - (pos * (pos + 1)) / 2) / (pos * neg) : null;
}
const logloss = (p: number[], y: number[]) => -p.reduce((s, q, i) => s + (y[i] ? Math.log(Math.max(1e-9, q)) : Math.log(Math.max(1e-9, 1 - q))), 0) / p.length;

type Score = { deaths: number; warned: number; recall: number; alerts: number; perMin: number; precision: number };
/** Доля смертей с предупреждением за 2–15 с; предупреждений в минуту; доля предупреждений, после которых смерть ≤ 15 с */
function score(recs: { deaths: number[]; aliveSec: number }[], alertsOf: (r: never) => number[]): Score {
  let deaths = 0, warned = 0, alerts = 0, hits = 0, aliveSec = 0;
  for (const r of recs) {
    const a = alertsOf(r as never);
    aliveSec += r.aliveSec;
    alerts += a.length;
    hits += a.filter((t) => r.deaths.some((d) => d > t && d <= t + DANGER_HORIZON_SEC)).length;
    for (const d of r.deaths) {
      deaths++;
      if (a.some((t) => t >= d - WARN_FROM && t <= d - WARN_TO)) warned++;
    }
  }
  return { deaths, warned, recall: deaths ? warned / deaths : 0, alerts, perMin: alerts / Math.max(1, aliveSec / 60), precision: alerts ? hits / alerts : 0 };
}
const modelAlerts = (w: W, thr: number) => (r: { probs: [number, number[]][] }) => {
  const out: number[] = [];
  let last = -Infinity;
  for (const [t, x] of r.probs)
    if (t - last >= COOLDOWN && dangerProbability(w, x) >= thr) {
      out.push(t);
      last = t;
    }
  return out;
};

describe.runIf(process.env.DOTACOACH_DANGER_TRAIN)('модель опасности: обучение и проверка по режимам', () => {
  it('обучение (All Pick → Турбо), порог, сравнение с правилами на отложенных матчах', () => {
    const { rows, engineRun } = harness();
    // Свои Турбо-матчи владельца (gsi-sessions, разобраны STRATZ) — только для проверки, не для обучения
    const own = load(join(root, '.tmp/danger-own'));
    const ownIds = new Set(own.map((f) => f.split(/[\/]/).pop()));
    const ap = load(join(root, '.tmp/danger')), tb = load(join(root, '.tmp/danger-turbo')).filter((f) => !ownIds.has(f.split(/[\/]/).pop()));
    const by = (files: string[], sp: string) => files.filter((f) => split(f) === sp);
    console.log(`Матчей: All Pick ${ap.length} (${by(ap, 'train').length}/${by(ap, 'val').length}/${by(ap, 'test').length}); Турбо ${tb.length} (${by(tb, 'train').length}/${by(tb, 'val').length}/${by(tb, 'test').length})`);
    const t0 = Date.now();
    const apTrain = rows(by(ap, 'train').slice(0, TRAIN_MAX), false);
    console.log(`Строк All Pick: ${apTrain.X.length}, смерть в горизонте: ${((100 * apTrain.Y.reduce((a, b) => a + b, 0)) / apTrain.X.length).toFixed(2)}% (${Math.round((Date.now() - t0) / 1000)} с)`);
    const wAP = train(apTrain.X, apTrain.Y);
    let wTB = wAP;
    const report: Record<string, unknown> = { trainedAt: new Date().toISOString(), matches: { ap: ap.length, turbo: tb.length }, trainRows: { ap: apTrain.X.length } };
    if (tb.length) {
      const tbTrain = rows(by(tb, 'train'), true);
      (report.trainRows as Record<string, number>).turbo = tbTrain.X.length;
      // дообучение: с весов All Pick, меньше шагов и сильнее держимся за них (L2)
      wTB = train(tbTrain.X, tbTrain.Y, wAP, 20, 3e-4, 0.02);
    }
    const result: Record<string, { enabled: boolean; threshold: number; weights: W }> = {};
    const modes: Record<string, unknown> = {};
    for (const [mode, files, w, turbo] of [['normal', ap, wAP, false], ['turbo', tb, wTB, true]] as const) {
      const rounded = { bias: Math.round(w.bias * 1e4) / 1e4, w: w.w.map((x) => Math.round(x * 1e4) / 1e4) };
      if (!by(files, 'test').length || !by(files, 'val').length) {
        result[mode] = { enabled: false, threshold: 0.5, weights: rounded };
        modes[mode] = { enabled: false, why: 'нет разобранных матчей этого режима для проверки' };
        console.log(`\n${mode}: нет отложенных матчей — остаются правила`);
        continue;
      }
      const testFiles = [...by(files, 'test').slice(0, EVAL_MAX), ...(turbo ? own : [])];
      const tr = rows(testFiles, turbo);
      const p = tr.X.map((x) => dangerProbability(w, x));
      const pAP = turbo ? tr.X.map((x) => dangerProbability(wAP, x)) : null;
      const val = engineRun(by(files, 'val').slice(0, Math.ceil(EVAL_MAX / 2)), turbo);
      const rulesVal = score(val, (r: { rules: number[] }) => r.rules);
      // Порог: не больше предупреждений, чем у правил, — лучший по доле предупреждённых смертей
      let pick = { thr: 0.99, s: score(val, modelAlerts(w, 0.99)) };
      for (let thr = 0.02; thr < 0.95; thr += 0.01) {
        const s = score(val, modelAlerts(w, thr));
        if (s.perMin <= rulesVal.perMin && s.recall > pick.s.recall) pick = { thr: Math.round(thr * 100) / 100, s };
      }
      const test = engineRun(testFiles, turbo);
      if (turbo && own.length) {
        // Отдельно — свои матчи владельца: все 10 героев и только свой герой (по записи GSI)
        const ownRecs = test.slice(test.length - own.length * 10);
        const mine = ownRecs.filter((r) => r.heroKey !== null && OWN_HEROES[r.matchId] === r.heroKey);
        const o = { matches: own.length, all: { rules: score(ownRecs, (r: { rules: number[] }) => r.rules), model: score(ownRecs, modelAlerts(w, pick.thr)) }, mine: { players: mine.length, rules: score(mine, (r: { rules: number[] }) => r.rules), model: score(mine, modelAlerts(w, pick.thr)) } };
        (report as Record<string, unknown>).own = o;
        console.log(`  свои матчи (${own.length}): все герои — правила ${(100 * o.all.rules.recall).toFixed(1)}% / модель ${(100 * o.all.model.recall).toFixed(1)}%; свой герой (${mine.length}) — правила ${o.mine.rules.warned}/${o.mine.rules.deaths}, модель ${o.mine.model.warned}/${o.mine.model.deaths}`);
      }
      const rulesTest = score(test, (r: { rules: number[] }) => r.rules);
      const modelTest = score(test, modelAlerts(w, pick.thr));
      // Лучше правил: больше предупреждённых смертей, предупреждений не больше (±5%) и они не менее точны
      const better = modelTest.recall > rulesTest.recall && modelTest.perMin <= rulesTest.perMin * 1.05 && modelTest.precision >= rulesTest.precision;
      modes[mode] = { rows: tr.X.length, auc: auc(p, tr.Y), aucApWeights: pAP ? auc(pAP, tr.Y) : undefined, logloss: logloss(p, tr.Y), threshold: pick.thr, val: { rules: rulesVal, model: pick.s }, test: { matches: testFiles.length, rules: rulesTest, model: modelTest }, enabled: better };
      result[mode] = { enabled: better, threshold: pick.thr, weights: rounded };
      const fmt = (s: Score) => `смертей ${s.deaths}, предупреждено ${s.warned} (${(100 * s.recall).toFixed(1)}%), предупреждений ${s.alerts} (${s.perMin.toFixed(2)}/мин), после них смерть ≤15 с: ${(100 * s.precision).toFixed(1)}%`;
      console.log(`\n${mode}: AUC ${auc(p, tr.Y)?.toFixed(3)}${pAP ? ` (веса All Pick: ${auc(pAP, tr.Y)?.toFixed(3)})` : ''}, logloss ${logloss(p, tr.Y).toFixed(4)}, порог ${pick.thr}`);
      console.log(`  правила: ${fmt(rulesTest)}\n  модель:  ${fmt(modelTest)}\n  → ${better ? 'модель ЛУЧШЕ — включается' : 'модель не лучше — остаются правила'}`);
    }
    report.modes = modes;
    console.log('\nВеса All Pick:', DANGER_FEATURES.map((f, i) => `${f}=${wAP.w[i]!.toFixed(2)}`).join(' '), `bias=${wAP.bias.toFixed(2)}`);
    if (tb.length) console.log('Веса Турбо:', DANGER_FEATURES.map((f, i) => `${f}=${wTB.w[i]!.toFixed(2)}`).join(' '), `bias=${wTB.bias.toFixed(2)}`);
    if (WRITE) {
      const model = { schema: 'dota-coach.danger-model', version: 1, features: [...DANGER_FEATURES], horizonSec: DANGER_HORIZON_SEC, cooldownSec: COOLDOWN, trainedAt: report.trainedAt, normal: result.normal, turbo: result.turbo };
      writeFileSync(join(root, 'src/data/danger-model.json'), JSON.stringify(model, null, 1) + '\n');
      writeFileSync(join(root, '.tmp/danger-eval.json'), JSON.stringify(report, null, 1));
    }
    expect(apTrain.X.length).toBeGreaterThan(0);
  }, 24 * 3_600_000);
});
