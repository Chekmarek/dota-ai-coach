// Модель опасности, версия 2 (docs/EXAM.md): предупреждать за 8–20 с до смерти (окно — docs/WARNING_WINDOW.md). Обучение тем же путём «как в игре»,
// что на экзамене (exam-lib.ts: GSI + зрение с туманом и ошибками → MatchStateModel → снимок коуча + память коуча
// для динамики), только на матчах обучения (.tmp/danger, .tmp/danger-turbo, часть «train»), без экзаменационных.
// Порог и пауза между предупреждениями — на части «val» этих же наборов: не больше тревог, чем у старых правил
// (они считаются настоящим движком коуча без модели), наибольшая доля смертей с предупреждением за 8–20 с.
//   $env:DOTACOACH_DANGER2='1'; $env:DANGER2_WRITE='1'; npx vitest run tests/unit/danger2-train.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { GOLD_HIGH } from '../../src/core/coach/rules/economy.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { DANGER_FEATURES, RISK_RULES, dangerFeatures, itemValueOf } from '../../src/core/coach/danger-model.ts';
import { FeatureCache, featureVersion } from './feature-cache.ts';
import { parseStatsRanked } from '../../src/shared/types/stats-ranked.ts';
import type { CoachData } from '../../src/core/coach/data.ts';
import { deadAt, GamePipeline, readXMatch, rng, type XMatch } from './exam-lib.ts';
import { auc, sigmoid, trainLR, seededShuffle, type W } from './lr.ts';
import { trainGBDT } from './gbdt.ts';
import { dangerRisk, type DangerTrees } from '../../src/core/coach/danger-model.ts';
import { realData } from './coach-sim.ts';

const root = join(import.meta.dirname, '../..');
// Метка «смерть через 8–20 с» — окно, в котором предупреждение успевает помочь (docs/WARNING_WINDOW.md)
const LEAD = 8, HOR = 20, STEP = 3;
const TRAIN_MAX = process.env.DANGER2_TRAIN_MAX ? Number(process.env.DANGER2_TRAIN_MAX) : 800;
const VAL_MAX = process.env.DANGER2_VAL_MAX ? Number(process.env.DANGER2_VAL_MAX) : 120;
const split = (id: number) => {
  const h = (id * 2654435761) % 100;
  return h < 70 ? 'train' : h < 80 ? 'val' : 'test';
};
const files = (dir: string) => (existsSync(join(root, '.tmp', dir)) ? readdirSync(join(root, '.tmp', dir)).filter((f) => f.endsWith('.json.gz')).map((f) => join(root, '.tmp', dir, f)) : []);
const examIds = new Set(readdirSync(join(root, '.tmp'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('exam')).flatMap((d) => files(d.name).map((f) => f.split(/[\\/]/).pop()!)));
const idOf = (f: string) => Number(/(\d+)\.json\.gz$/.exec(f)![1]);
const pick = (dir: string, sp: string) => files(dir).filter((f) => !examIds.has(f.split(/[\\/]/).pop()!) && split(idOf(f)) === sp);
const deathsOf = (m: XMatch, i: number) => m.players[i]!.playbackData.deathEvents.map((d) => d.time).filter((t) => t > 0);
const soon = (deaths: number[], t: number) => deaths.some((d) => d >= t + LEAD && d <= t + HOR);

describe.runIf(process.env.DOTACOACH_DANGER2)('модель опасности v2: обучение (8–20 с)', () => {
  it('All Pick → Турбо, порог и пауза на отложенной части', () => {
    const base = realData();
    const ranked = parseStatsRanked(JSON.parse(readFileSync(join(root, 'resources/data/kb/7.41f/stats-ranked.json'), 'utf8')), '7.41f');
    const data: CoachData = { ...base, statsRanked: ranked, dangerModel: null };
    const itemKey = new Map(base.items.map((i) => [i.id, i.key]));
    const cost = new Map(base.items.map((i) => [i.key, i.cost]));

    // Кэш прогонов героев: повторное обучение не гоняет стенд заново (feature-cache.ts)
    const cache = new FeatureCache('danger', featureVersion(DANGER_FEATURES, ['resources/data/kb/7.41f/stats-ranked.json']));
    /** Прогон героя: признаки (каждые STEP с или каждую секунду) и, для проверки, тревоги старых правил */
    function runHero(m: XMatch, i: number, turbo: boolean, every: number, withRules: boolean) {
      return cache.get(`${m.id}-${i}-${turbo ? 1 : 0}-${every}-${withRules ? 1 : 0}`, () => runHeroRaw(m, i, turbo, every, withRules));
    }
    function runHeroRaw(m: XMatch, i: number, turbo: boolean, every: number, withRules: boolean) {
      const pipe = new GamePipeline(m, i, turbo, itemKey, m.id * 13 + i);
      const mem = new CoachMemory();
      let now = 0;
      const engine = withRules ? new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), aiLive: false } }) : null;
      const rows: [number, number[]][] = [];
      const rules: number[] = [];
      let aliveSec = 0;
      for (let t = pipe.startClock; t <= m.durationSeconds; t++) {
        const input = pipe.tick(t);
        now = input.gsiWallMs!;
        const v = buildView(input.state, input.gsi, input.gsiWallMs);
        mem.ingest(v, GOLD_HIGH);
        const u = engine?.tick(input.state, input.gsi, input.gsiWallMs);
        if (t < 0 || deadAt(m.players[i]!, t)) continue;
        aliveSec++;
        if (u?.shown.some((h) => (RISK_RULES as readonly string[]).includes(h.id.split(':')[0]!))) rules.push(t);
        if (t % every) continue;
        const itemValue = v.me.itemsKnown ? itemValueOf(v.me.items.map((q) => q.key), (k) => cost.get(k) ?? null) : null;
        const x = dangerFeatures(v, { itemValue, turbo, history: mem.samples });
        if (x) rows.push([t, x]);
      }
      return { rows, rules, aliveSec, deaths: deathsOf(m, i) };
    }
    function trainSet(list: string[], turbo: boolean) {
      const X: number[][] = [], Y: number[] = [];
      for (const f of list) {
        const m = readXMatch(f);
        const r = rng(m.id);
        const heroes = [...new Set([0, 1, 2].map(() => Math.floor(r() * 10)))];
        for (const i of heroes) {
          const h = runHero(m, i, turbo, STEP, false);
          for (const [t, x] of h.rows) {
            // Смерть раньше чем через LEAD с — не «безопасно»: такие строки не учим (иначе модель выучивает, что
            // враги вплотную при малом здоровье — не опасность, и молчит в самый опасный момент)
            if (h.deaths.some((d) => d > t && d < t + LEAD)) continue;
            X.push(x);
            Y.push(soon(h.deaths, t) ? 1 : 0);
          }
        }
      }
      return { X, Y };
    }
    function valSet(list: string[], turbo: boolean) {
      return list.map((f) => {
        const m = readXMatch(f);
        return runHero(m, Math.floor(rng(m.id + 1)() * 10), turbo, 1, true);
      });
    }
    type V = ReturnType<typeof valSet>[number];
    type M = { weights: W; trees?: DangerTrees };
    const prob = (m: M, x: number[]) => dangerRisk(m, x);
    const alertsOf = (h: V, w: M, thr: number, cd: number) => {
      const out: number[] = [];
      let last = -Infinity;
      for (const [t, x] of h.rows)
        if (t - last >= cd && prob(w, x) >= thr) {
          out.push(t);
          last = t;
        }
      return out;
    };
    const score = (val: V[], alerts: (h: V) => number[]) => {
      let deaths = 0, warned = 0, n = 0, aliveSec = 0;
      for (const h of val) {
        const a = alerts(h);
        n += a.length;
        aliveSec += h.aliveSec;
        for (const d of h.deaths) {
          deaths++;
          if (a.some((t) => t >= d - HOR && t <= d - LEAD)) warned++;
        }
      }
      return { deaths, warned, recall: deaths ? warned / deaths : 0, alerts: n, perMin: n / Math.max(1, aliveSec / 60) };
    };

    const t0 = Date.now();
    const ap = trainSet(pick('danger', 'train').slice(0, TRAIN_MAX), false);
    console.log(`All Pick: строк ${ap.X.length}, смерть через ${LEAD}–${HOR} с: ${((100 * ap.Y.reduce((a, b) => a + b, 0)) / ap.X.length).toFixed(2)}% (${Math.round((Date.now() - t0) / 1000)} с)`);
    const wAP = trainLR(ap.X, ap.Y, DANGER_FEATURES.length);
    const tb = trainSet(pick('danger-turbo', 'train'), true);
    console.log(`Турбо: строк ${tb.X.length}`);
    const wTB = trainLR(tb.X, tb.Y, DANGER_FEATURES.length, wAP, 20, 3e-4, 0.02);
    // Деревья решений: All Pick (до 600 тыс. строк), затем дообучение на Турбо — продолжение бустинга
    const sub = (s: { X: number[][]; Y: number[] }, k: number) => {
      const idx = seededShuffle([...s.X.keys()], 5).slice(0, k);
      return { X: idx.map((i) => s.X[i]!), Y: idx.map((i) => s.Y[i]!) };
    };
    const t1 = Date.now();
    const apSub = sub(ap, 600_000);
    const trAP = trainGBDT(apSub.X, apSub.Y, { trees: 150, depth: 3, lr: 0.1 });
    const trTB = trainGBDT(tb.X, tb.Y, { trees: 60, depth: 3, lr: 0.05, init: trAP });
    console.log(`Деревья: ${trAP.trees.length} (All Pick) + ${trTB.trees.length - trAP.trees.length} (Турбо), ${Math.round((Date.now() - t1) / 1000)} с`);
    const result: Record<string, { enabled: boolean; threshold: number; cooldown: number; w: W; trees?: DangerTrees }> = {};
    const COOLDOWNS = [8, 10, 15, 20, 30];
    for (const [mode, dir, wl, tr, turbo] of [['normal', 'danger', wAP, trAP, false], ['turbo', 'danger-turbo', wTB, trTB, true]] as const) {
      const val = valSet(pick(dir, 'val').slice(0, VAL_MAX), turbo);
      const rules = score(val, (h) => h.rules);
      const y = val.flatMap((h) => h.rows.map(([t]) => (soon(h.deaths, t) ? 1 : 0)));
      console.log(`\n${mode}: героев проверки ${val.length}, смертей ${rules.deaths}; старые правила: предупреждено за ${LEAD}–${HOR} с ${(100 * rules.recall).toFixed(1)}%, тревог ${rules.alerts} (${rules.perMin.toFixed(2)}/мин)`);
      let chosen: { name: string; m: M; thr: number; cd: number; s: ReturnType<typeof score> } | null = null;
      const variants: [string, M][] = [['регрессия', { weights: wl }], ['деревья', { weights: wl, trees: tr }]];
      for (const [name, m] of variants) {
        const p = val.flatMap((h) => h.rows.map(([, x]) => prob(m, x)));
        let b = { thr: 0.99, cd: 20, s: score(val, (h) => alertsOf(h, m, 0.99, 20)) };
        for (const cd of COOLDOWNS)
          for (let thr = 0.02; thr < 0.9; thr += 0.01) {
            const s = score(val, (h) => alertsOf(h, m, thr, cd));
            if (s.alerts <= rules.alerts && s.recall > b.s.recall) b = { thr: Math.round(thr * 100) / 100, cd, s };
          }
        console.log(`  ${name}: AUC ${auc(p, y)?.toFixed(3)}; ${(100 * b.s.recall).toFixed(1)}%, тревог ${b.s.alerts} (${b.s.perMin.toFixed(2)}/мин), порог ${b.thr}, пауза ${b.cd} с`);
        if (!chosen || b.s.recall > chosen.s.recall) chosen = { name, m, thr: b.thr, cd: b.cd, s: b.s };
      }
      const best = chosen!;
      const w = best.m;
      result[mode] = { enabled: best.s.recall > rules.recall, threshold: best.thr, cooldown: best.cd, w: wl, ...(w.trees ? { trees: w.trees } : {}) };
      console.log(`  → ${best.name}`);
      for (const cd of COOLDOWNS) {
        // Сколько можно предупредить, если тревог можно в 2 и 3 раза больше (для понимания запаса)
        const lim = (k: number) => {
          let b = 0;
          for (let thr = 0.02; thr < 0.9; thr += 0.01) {
            const s = score(val, (h) => alertsOf(h, w, thr, cd));
            if (s.alerts <= rules.alerts * k) b = Math.max(b, s.recall);
          }
          return (100 * b).toFixed(0);
        };
        console.log(`    пауза ${cd} с: при тревогах ×1 — ${lim(1)}%, ×2 — ${lim(2)}%, ×3 — ${lim(3)}%`);
      }
    }
    console.log('\nВеса All Pick:', DANGER_FEATURES.map((f, i) => `${f}=${wAP.w[i]!.toFixed(2)}`).join(' '), `bias=${wAP.bias.toFixed(2)}`);
    if (process.env.DANGER2_WRITE === '1') {
      const r = (w: W) => ({ bias: Math.round(w.bias * 1e4) / 1e4, w: w.w.map((x) => Math.round(x * 1e4) / 1e4) });
      // Пауза — одна на файл: берём наибольшую из выбранных (не чаще, чем в обоих режимах)
      const cooldownSec = Math.max(result.normal!.cooldown, result.turbo!.cooldown);
      const mode = (k: string) => ({ enabled: result[k]!.enabled, threshold: result[k]!.threshold, replaces: [...RISK_RULES], weights: r(result[k]!.w), ...(result[k]!.trees ? { trees: result[k]!.trees } : {}) });
      writeFileSync(join(root, 'src/data/danger-model.json'), JSON.stringify({ schema: 'dota-coach.danger-model', version: 1, features: [...DANGER_FEATURES], horizonSec: HOR, leadSec: LEAD, cooldownSec, trainedAt: new Date().toISOString(), normal: mode('normal'), turbo: mode('turbo') }, null, 1) + '\n');
    }
    expect(ap.X.length).toBeGreaterThan(0);
  }, 24 * 3_600_000);
});
