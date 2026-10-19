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
import { FIGHT_FEATURES, fightFeatures } from '../../src/core/coach/fight-model.ts';
import { dangerFeatures, dangerProbability, itemValueOf, parseDangerModel } from '../../src/core/coach/danger-model.ts';
import dangerJson from '../../src/data/danger-model.json';
import { fightsOf, GamePipeline, readXMatch } from './exam-lib.ts';
import { auc, calibrationTable, sigmoid, trainLR, type W } from './lr.ts';
import { realData } from './coach-sim.ts';

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

    function samples(list: string[], turbo: boolean) {
      const X: number[][] = [], Y: number[] = [];
      for (const f of list) {
        const m = readXMatch(f);
        for (const fight of fightsOf(m)) {
          if (!fight.winner || fight.tp < 30) continue;
          for (const pi of [...fight.radiant, ...fight.dire]) {
            const pipe = new GamePipeline(m, pi, turbo, itemKey, idOf(f) + pi);
            let input = null;
            for (let t = fight.tp - WARMUP; t <= fight.tp; t++) input = pipe.tick(t);
            const v = buildView(input!.state, input!.gsi, input!.gsiWallMs);
            const itemValue = v.me.itemsKnown ? itemValueOf(v.me.items.map((i) => i.key), (k) => cost.get(k) ?? null) : null;
            const df = dm ? dangerFeatures(v, { itemValue, turbo }) : null;
            const risk = dm && df ? dangerProbability((turbo ? dm.turbo : dm.normal).weights, df) : null;
            const x = fightFeatures(v, { itemValue, turbo, risk });
            if (!x) continue;
            X.push(x);
            Y.push(fight.winner === (m.players[pi]!.isRadiant ? 'radiant' : 'dire') ? 1 : 0);
          }
        }
      }
      return { X, Y };
    }

    const t0 = Date.now();
    const apTrain = samples(pick('danger', 'train').slice(0, MAX), false);
    const apVal = samples(pick('danger', 'val').slice(0, Math.ceil(MAX / 5)), false);
    console.log(`All Pick: обучение ${apTrain.X.length} прогнозов, проверка ${apVal.X.length} (${Math.round((Date.now() - t0) / 1000)} с)`);
    const wAP = trainLR(apTrain.X, apTrain.Y, FIGHT_FEATURES.length);
    const tbTrain = samples(pick('danger-turbo', 'train'), true);
    const tbVal = samples(pick('danger-turbo', 'val'), true);
    console.log(`Турбо: обучение ${tbTrain.X.length}, проверка ${tbVal.X.length}`);
    const wTB = tbTrain.X.length ? trainLR(tbTrain.X, tbTrain.Y, FIGHT_FEATURES.length, wAP, 25, 3e-4, 0.02) : wAP;
    const rep = (name: string, w: W, s: { X: number[][]; Y: number[] }) => {
      const p = s.X.map((x) => sigmoid(w, x));
      const acc = p.filter((q, i) => (q >= 0.5 ? 1 : 0) === s.Y[i]).length / Math.max(1, p.length);
      const cal = calibrationTable(p, s.Y);
      console.log(`${name}: AUC ${auc(p, s.Y)?.toFixed(3)}, угадано ${(100 * acc).toFixed(1)}%, отклонение процентов ${cal.ece.toFixed(1)} п.п. (${p.length})`);
    };
    rep('All Pick (отложенная часть обучения)', wAP, apVal);
    rep('Турбо (отложенная часть обучения)', wTB, tbVal);
    rep('Турбо с весами All Pick', wAP, tbVal);
    console.log('Веса All Pick:', FIGHT_FEATURES.map((f, i) => `${f}=${wAP.w[i]!.toFixed(2)}`).join(' '), `bias=${wAP.bias.toFixed(2)}`);
    if (process.env.FIGHT_WRITE === '1') {
      const r = (w: W) => ({ bias: Math.round(w.bias * 1e4) / 1e4, w: w.w.map((x) => Math.round(x * 1e4) / 1e4) });
      writeFileSync(join(root, 'src/data/fight-model.json'), JSON.stringify({ schema: 'dota-coach.fight-model', version: 1, features: [...FIGHT_FEATURES], trainedAt: new Date().toISOString(), normal: { weights: r(wAP) }, turbo: { weights: r(wTB) } }, null, 1) + '\n');
    }
    void readFileSync;
    expect(apTrain.X.length).toBeGreaterThan(0);
  }, 24 * 3_600_000);
});
