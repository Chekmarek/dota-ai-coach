// Модель драк: старый файл (20 признаков, без калибровки) читается и считает как раньше; калибровка — линейно между
// точками; новые признаки лайнинга (DECISIONS.md п. 71–72).
import { describe, expect, it } from 'vitest';
import { calibrate, FIGHT_FEATURES, fightChance, fightProbability, parseFightModel } from '../../src/core/coach/fight-model.ts';
import { isotonic } from './lr.ts';

const OLD = FIGHT_FEATURES.slice(0, 20);
const w = (n: number) => ({ bias: -0.2, w: Array.from({ length: n }, (_, i) => (i % 3) * 0.1) });
const oldJson = { schema: 'dota-coach.fight-model', version: 1, features: [...OLD], trainedAt: 'x', normal: { weights: w(20) }, turbo: { weights: w(20) } };

describe('модель драк: совместимость и калибровка', () => {
  it('старый файл без калибровки и без признаков лайнинга разбирается и считает по своим признакам', () => {
    const m = parseFightModel(oldJson)!;
    expect(m).not.toBeNull();
    const full = FIGHT_FEATURES.map((_, i) => (i + 1) / 30);
    expect(fightChance(m, false, full)).toBeCloseTo(fightProbability(oldJson.normal.weights, full.slice(0, 20)), 10);
  });

  it('файл с неизвестным признаком или неверным числом весов — не модель', () => {
    expect(parseFightModel({ ...oldJson, features: [...OLD.slice(0, 19), 'xray'] })).toBeNull();
    expect(parseFightModel({ ...oldJson, normal: { weights: w(19) } })).toBeNull();
  });

  it('калибровка: линейно между точками, за краями — крайние; применяется к шансу', () => {
    const pts = [[0.2, 0.25], [0.5, 0.5], [0.7, 0.8]] as [number, number][];
    expect(calibrate(pts, 0.1)).toBe(0.25);
    expect(calibrate(pts, 0.6)).toBeCloseTo(0.65, 10);
    expect(calibrate(pts, 0.9)).toBe(0.8);
    expect(calibrate(undefined, 0.42)).toBe(0.42);
    const m = parseFightModel({ ...oldJson, normal: { weights: { bias: 0, w: Array(20).fill(0) }, calibration: { points: [[0.4, 0.3], [0.6, 0.7]] } } })!;
    expect(fightChance(m, false, FIGHT_FEATURES.map(() => 0))).toBeCloseTo(0.5, 10);
  });

  it('изотоническая калибровка: точки не убывают и исправляют заниженную уверенность', () => {
    const p: number[] = [], y: number[] = [];
    for (let i = 0; i < 4000; i++) {
      const q = i / 4000;
      p.push(q);
      // на деле исход «увереннее» прогноза: 0,3 → ~0,2, 0,7 → ~0,8
      y.push((i * 7919) % 1000 < 1000 * Math.min(1, Math.max(0, 0.5 + (q - 0.5) * 1.5)) ? 1 : 0);
    }
    const pts = isotonic(p, y);
    for (let i = 1; i < pts.length; i++) expect(pts[i]![1]).toBeGreaterThanOrEqual(pts[i - 1]![1]);
    expect(calibrate(pts, 0.7)).toBeGreaterThan(0.75);
    expect(calibrate(pts, 0.3)).toBeLessThan(0.25);
  });
});
