// Калькуляторы процентов: границы, монотонность, уверенность и скрытие процента при неизвестных данных.
import { describe, expect, it } from 'vitest';
import { estimate, engagePercent, matchupPercent, actionChoice, MIN_PCT, MAX_PCT, type FactorInput } from '../../src/core/coach/prob.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { buildView } from '../../src/core/coach/view.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const look = new CoachLookup(realData());
const view = (i: Partial<SimInput>) => {
  const s = sim({ wallMs: 100_000, clock: 900, ...i });
  return buildView(s.state, s.gsi, 100_000);
};
const ENEMY_NEAR = { slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 }, hpPercent: 60, barLevel: 8 };

describe('estimate: общая модель процента', () => {
  const f = (value: number | null, weight = 1, importance = 1): FactorInput => ({ id: 'x', label: 'x', value, weight, confidence: 1, importance });

  it('всегда в пределах 5…95, даже при крайних факторах', () => {
    expect(estimate(0.5, [f(1, 50), f(1, 50)], 0.5).value).toBe(MAX_PCT);
    expect(estimate(0.5, [f(-1, 50), f(-1, 50)], 0.5).value).toBe(MIN_PCT);
    for (let i = 0; i < 200; i++) {
      const inputs = Array.from({ length: 5 }, () => f(Math.random() * 2 - 1, Math.random() * 5));
      const e = estimate(Math.random() * 0.98 + 0.01, inputs, 0.5);
      expect(e.value).toBeGreaterThanOrEqual(MIN_PCT);
      expect(e.value).toBeLessThanOrEqual(MAX_PCT);
    }
  });

  it('монотонность: сильнее сигнал «за» — не меньше процент', () => {
    let prev = -1;
    for (let s = -1; s <= 1.0001; s += 0.1) {
      const v = estimate(0.5, [f(s, 1.2), f(0.3, 0.5)], 0.5).value;
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  it('неизвестный фактор не двигает процент, но снижает уверенность и скрывает процент ниже порога', () => {
    const all = estimate(0.5, [f(0.5, 1, 1), f(0.5, 1, 1)], 0.6);
    const half = estimate(0.5, [f(0.5, 1, 1), f(null, 1, 1)], 0.6);
    expect(all.confidence).toBe(1);
    expect(half.confidence).toBe(0.5);
    expect(half.showable).toBe(false);
    expect(all.showable).toBe(true);
    expect(half.factors.find((x) => !x.known)!.effect).toBe(0);
  });

  it('вклад факторов записан в процентных пунктах со знаком', () => {
    const e = estimate(0.5, [{ ...f(1, 1), id: 'good', label: 'за' }, { ...f(-1, 0.5), id: 'bad', label: 'против' }], 0.5);
    expect(e.factors.find((x) => x.id === 'good')!.effect).toBeGreaterThan(0);
    expect(e.factors.find((x) => x.id === 'bad')!.effect).toBeLessThan(0);
  });
});

describe('калькуляторы матча', () => {
  const mem = new CoachMemory();

  it('«вступать»: больше здоровья — выше шанс', () => {
    const lo = engagePercent(view({ hp: 150, enemies: [ENEMY_NEAR] }), mem, look, 0.5).value;
    const hi = engagePercent(view({ hp: 950, enemies: [ENEMY_NEAR] }), mem, look, 0.5).value;
    expect(hi).toBeGreaterThan(lo);
  });

  it('«вступать»: больше врагов рядом — ниже шанс', () => {
    const one = engagePercent(view({ enemies: [ENEMY_NEAR] }), mem, look, 0.5).value;
    const three = engagePercent(view({ enemies: [ENEMY_NEAR, { ...ENEMY_NEAR, slot: 6, hero: 'lion' }, { ...ENEMY_NEAR, slot: 7, hero: 'pudge' }] }), mem, look, 0.5).value;
    expect(three).toBeLessThan(one);
  });

  it('один против пятерых — шанс низкий', () => {
    const five = [5, 6, 7, 8, 9].map((slot) => ({ ...ENEMY_NEAR, slot, hpPercent: 100 }));
    expect(engagePercent(view({ hp: 1000, enemies: five }), mem, look, 0.5).value).toBeLessThan(30);
  });

  it('без мини-карты и без GSI — процент не показывается', () => {
    const e = engagePercent(view({ noGsi: true, enemies: [] }), mem, look, 0.6);
    expect(e.showable).toBe(false);
  });

  it('ценность героев врагов всегда неизвестна — уверенность меньше 1', () => {
    const e = engagePercent(view({ enemies: [ENEMY_NEAR] }), mem, look, 0.5);
    expect(e.factors.find((x) => x.id === 'networth')!.known).toBe(false);
    expect(e.confidence).toBeLessThan(1);
  });

  it('1×1: без здоровья и уровня врага (только портрет) — процент скрыт', () => {
    const v = view({ enemies: [{ slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 } }] });
    const e = matchupPercent(v, v.enemies[0]!, look, 0.6);
    expect(e.showable).toBe(false);
  });

  it('1×1: матчап из статистики патча учтён как фактор', () => {
    const v = view({ enemies: [ENEMY_NEAR] });
    const e = matchupPercent(v, v.enemies[0]!, look, 0.5);
    expect(e.factors.find((x) => x.id === 'matchup')!.known).toBe(true);
  });

  it('драка/фарм/пуш/отход: доли в сумме ~100, мало здоровья → отход', () => {
    const a = actionChoice(view({ hp: 80, enemies: [{ slot: 5, hero: 'axe', pos: null, missingForSec: 20 }] }), mem, look, 0.5);
    const sum = Object.values(a.percents).reduce((x, y) => x + y, 0);
    expect(sum).toBeGreaterThanOrEqual(98);
    expect(sum).toBeLessThanOrEqual(102);
    expect(a.best).toBe('retreat');
  });

  it('двое врагов мертвы — пуш выгоднее, чем при всех живых', () => {
    const dead = [5, 6].map((slot) => ({ slot, hero: 'axe', alive: false, respawnAt: 960 }));
    const live = [5, 6].map((slot) => ({ slot, hero: 'axe', pos: { x: 5000, y: 5000 } }));
    const p1 = actionChoice(view({ enemies: dead }), mem, look, 0.5).percents.push;
    const p0 = actionChoice(view({ enemies: live }), mem, look, 0.5).percents.push;
    expect(p1).toBeGreaterThan(p0);
  });
});
