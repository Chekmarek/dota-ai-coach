// Обучение прогноза драк (src/core/coach/fight-model.ts) — только на матчах обучения (.tmp/danger, .tmp/danger-turbo,
// часть «train» как у модели опасности), никогда на экзаменационных (.tmp/exam*). Признаки — тем же путём «как в
// игре», что и на экзамене (exam-lib.ts: GSI + зрение с туманом → MatchStateModel → снимок коуча), в момент прогноза
// (за 8 с до первой смерти драки), глазами каждого участника. Ответ — выиграла ли его команда (меньше потерь).
//   $env:DOTACOACH_FIGHT_TRAIN='1'; npx vitest run tests/unit/fight-train.test.ts
// FIGHT_TRAIN_MAX — матчей All Pick (600), FIGHT_WRITE=1 — записать src/data/fight-model.json.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { GOLD_HIGH } from '../../src/core/coach/rules/economy.ts';
import { FIGHT_FEATURES, fightChance, fightFeatures, parseFightModel, type FightModel } from '../../src/core/coach/fight-model.ts';
import fightJson from '../../src/data/fight-model.json';
import { dangerFeatures, dangerProbability, dangerRisk, itemValueOf, parseDangerModel } from '../../src/core/coach/danger-model.ts';
import dangerJson from '../../src/data/danger-model.json';
import { fightsOf, GamePipeline, readXMatch } from './exam-lib.ts';
import { auc, calibrationTable, isotonic, sigmoid, trainLR, type W } from './lr.ts';
import { realData } from './coach-sim.ts';
import { FeatureCache, featureVersion } from './feature-cache.ts';

const root = join(import.meta.dirname, '../..');
const MAX = process.env.FIGHT_TRAIN_MAX ? Number(process.env.FIGHT_TRAIN_MAX) : 600;
const WARMUP = 60;

const split = (id: number) => {
  const h = (id * 2654435761) % 100;
  return h < 70 ? 'train' : h < 80 ? 'val' : 'test';
};
const files = (dir: string) => (existsSync(join(root, '.tmp', dir)) ? readdirSync(join(root, '.tmp', dir)).filter((f) => f.endsWith('.json.gz')).map((f) => join(root, '.tmp', dir, f)) : []);
/** Номера экзаменационных матчей — в обучение не попадают никогда */
const examIds = new Set(readdirSync(join(root, '.tmp'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('exam')).map((d) => d.name).flatMap((d) => files(d).map((f) => f.split(/[\\/]/).pop()!)));

describe.runIf(process.env.DOTACOACH_FIGHT_TRAIN)('прогноз драк: обучение', () => {
  it('All Pick → Турбо, проверка на отложенной части обучающих матчей', () => {
    const data = realData();
    const itemKey = new Map(data.items.map((i) => [i.id, i.key]));
    const cost = new Map(data.items.map((i) => [i.key, i.cost]));
    const dm = parseDangerModel(dangerJson);
    const idOf = (f: string) => Number(/(\d+)\.json\.gz$/.exec(f)![1]);
    const pick = (dir: string, sp: string) => files(dir).filter((f) => !examIds.has(f.split(/[\\/]/).pop()!) && split(idOf(f)) === sp);

    // Кэш признаков драк по матчам (feature-cache.ts): риск в признаках — по модели опасности, она входит в версию
    const cache = new FeatureCache('fight', featureVersion(FIGHT_FEATURES, ['src/data/danger-model.json']));
    type S = { X: number[][]; Y: number[]; eq: boolean[] };
    function samples(list: string[], turbo: boolean): S {
      const out: S = { X: [], Y: [], eq: [] };
      for (const f of list) {
        const s = cache.get(`${idOf(f)}-${turbo ? 1 : 0}`, () => matchSamples(f, turbo));
        out.X.push(...s.X);
        out.Y.push(...s.Y);
        out.eq.push(...s.eq);
      }
      return out;
    }
    function matchSamples(f: string, turbo: boolean): S {
      const X: number[][] = [], Y: number[] = [], eq: boolean[] = [];
      {
        const m = readXMatch(f);
        for (const fight of fightsOf(m)) {
          if (!fight.winner || fight.tp < 30) continue;
          for (const pi of [...fight.radiant, ...fight.dire]) {
            const pipe = new GamePipeline(m, pi, turbo, itemKey, idOf(f) + pi);
            // Память коуча за разгон — для динамики в риске (как engine.forecast в приложении)
            const mem = new CoachMemory();
            let v: ReturnType<typeof buildView> | null = null;
            for (let t = fight.tp - WARMUP; t <= fight.tp; t++) {
              const input = pipe.tick(t);
              v = buildView(input.state, input.gsi, input.gsiWallMs);
              mem.ingest(v, GOLD_HIGH);
            }
            if (!v) continue;
            const itemValue = v.me.itemsKnown ? itemValueOf(v.me.items.map((i) => i.key), (k) => cost.get(k) ?? null) : null;
            const df = dm ? dangerFeatures(v, { itemValue, turbo, history: mem.samples }) : null;
            const risk = dm && df ? dangerRisk(turbo ? dm.turbo : dm.normal, df) : null;
            const x = fightFeatures(v, { itemValue, turbo, risk });
            if (!x) continue;
            X.push(x);
            Y.push(fight.winner === (m.players[pi]!.isRadiant ? 'radiant' : 'dire') ? 1 : 0);
            // Равная драка — поровну участников (как на экзамене)
            eq.push(fight.radiant.length === fight.dire.length);
          }
        }
      }
      return { X, Y, eq };
    }

    // Части (DECISIONS.md п. 72): train — обучение весов; val делится по матчам пополам: val-calib — калибровка
    // процентов, val-check — проверка и сравнение с прежней моделью. Экзаменационные матчи не трогаются
    const half = (f: string) => ((idOf(f) * 2654435761) % 100 < 75 ? 'calib' : 'check');
    const t0 = Date.now();
    const apTrain = samples(pick('danger', 'train').slice(0, MAX), false);
    const apVal = pick('danger', 'val');
    const apCalib = samples(apVal.filter((f) => half(f) === 'calib'), false);
    const apCheck = samples(apVal.filter((f) => half(f) === 'check'), false);
    console.log(`All Pick: обучение ${apTrain.X.length} прогнозов, val-calib ${apCalib.X.length}, val-check ${apCheck.X.length} (${Math.round((Date.now() - t0) / 1000)} с)`);
    const wAP = trainLR(apTrain.X, apTrain.Y, FIGHT_FEATURES.length);
    const tbTrain = samples(pick('danger-turbo', 'train'), true);
    const tbVal = pick('danger-turbo', 'val');
    const tbCalib = samples(tbVal.filter((f) => half(f) === 'calib'), true);
    const tbCheck = samples(tbVal.filter((f) => half(f) === 'check'), true);
    console.log(`Турбо: обучение ${tbTrain.X.length}, val-calib ${tbCalib.X.length}, val-check ${tbCheck.X.length}`);
    const wTB = tbTrain.X.length ? trainLR(tbTrain.X, tbTrain.Y, FIGHT_FEATURES.length, wAP, 25, 3e-4, 0.02) : wAP;
    const calAP = isotonic(apCalib.X.map((x) => sigmoid(wAP, x)), apCalib.Y);
    const calTB = isotonic(tbCalib.X.map((x) => sigmoid(wTB, x)), tbCalib.Y);
    const r4 = (x: number) => Math.round(x * 1e4) / 1e4;
    const rw = (w: W) => ({ bias: r4(w.bias), w: w.w.map(r4) });
    const next = parseFightModel({ schema: 'dota-coach.fight-model', version: 1, features: [...FIGHT_FEATURES], trainedAt: new Date().toISOString(), normal: { weights: rw(wAP), calibration: { points: calAP } }, turbo: { weights: rw(wTB), calibration: { points: calTB } } })!;
    const prev = parseFightModel(fightJson);
    const lvl = (x: number[]) => Math.round(x[FIGHT_FEATURES.indexOf('level')]! * 30);
    const size = (x: number[]) => Math.round(x[FIGHT_FEATURES.indexOf('allies')]! * 4) + 1 + Math.round(x[FIGHT_FEATURES.indexOf('enemies')]! * 5);
    const report = (name: string, m: FightModel, turbo: boolean, s: S) => {
      const p = s.X.map((x) => fightChance(m, turbo, x));
      const acc = (keep: (i: number) => boolean) => {
        const idx = p.map((_, i) => i).filter(keep);
        return idx.length ? (100 * idx.filter((i) => (p[i]! >= 0.5 ? 1 : 0) === s.Y[i]).length) / idx.length : NaN;
      };
      const cal = calibrationTable(p, s.Y);
      const badBins = cal.rows.filter((r) => r.n >= 100 && Math.abs(r.predicted! - r.actual!) > 5).map((r) => r.range);
      const out = { auc: auc(p, s.Y) ?? NaN, all: acc(() => true), equal: acc((i) => s.eq[i]!), lane: acc((i) => lvl(s.X[i]!) <= 6), mid: acc((i) => lvl(s.X[i]!) >= 7), small: acc((i) => size(s.X[i]!) <= 4), ece: cal.ece, badBins };
      console.log(`${name}: AUC ${out.auc.toFixed(3)}, угадано ${out.all.toFixed(1)}%, равные ${out.equal.toFixed(1)}%, уровни 1–6 ${out.lane.toFixed(1)}%, 7+ ${out.mid.toFixed(1)}%, драки 2–4 ${out.small.toFixed(1)}%, отклонение ${out.ece.toFixed(1)} п.п., корзин ≥100 с расхождением > 5 п.п.: ${badBins.join(', ') || 'нет'} (${p.length})`);
      return out;
    };
    const res: Record<string, ReturnType<typeof report>> = {};
    for (const [mode, turbo, chk] of [['normal', false, apCheck], ['turbo', true, tbCheck]] as const) {
      if (prev) res[`${mode}-prev`] = report(`${mode}, прежняя модель (val-check)`, prev, turbo, chk);
      res[`${mode}-raw`] = report(`${mode}, новая без калибровки (val-check)`, { ...next, [mode]: { weights: next[mode].weights } }, turbo, chk);
      res[`${mode}-new`] = report(`${mode}, новая с калибровкой (val-check)`, next, turbo, chk);
    }
    console.log('Веса All Pick:', FIGHT_FEATURES.map((f, i) => `${f}=${wAP.w[i]!.toFixed(2)}`).join(' '), `bias=${wAP.bias.toFixed(2)}`);
    console.log('Калибровка All Pick:', JSON.stringify(calAP));
    writeFileSync(join(root, '.tmp/fight-train-result.json'), JSON.stringify(res, null, 1));
    if (process.env.FIGHT_WRITE === '1') {
      const { idx: _idx, ...json } = next;
      void _idx;
      writeFileSync(join(root, 'src/data/fight-model.json'), JSON.stringify(json, null, 1) + '\n');
    }
    void readFileSync;
    expect(apTrain.X.length).toBeGreaterThan(0);
  }, 24 * 3_600_000);
});
