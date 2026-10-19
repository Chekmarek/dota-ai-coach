// Модель опасности: признаки из снимка коуча (по стадии игры, режим — отдельный признак), разбор файла модели,
// включение по режимам (в режиме, где модель не лучше правил, работают правила), замена правил о риске.
import { describe, expect, it } from 'vitest';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { defaultCoachSettings } from '../../src/core/coach/index.ts';
import { DANGER_RULES, modelRule } from '../../src/core/coach/rules/danger.ts';
import { DANGER_FEATURES, dangerFeatures, dangerProbability, dangerRisk, itemValueOf, parseDangerModel, RISK_RULES, treesProbability, type DangerModel } from '../../src/core/coach/danger-model.ts';
import type { GameModeInfo } from '../../src/core/gsi/mode.ts';
import type { HintDraft } from '../../src/core/coach/types.ts';
import modelJson from '../../src/data/danger-model.json';
import { realData, sim, type SimInput } from './coach-sim.ts';

const T0 = 1_000_000;
const TURBO: GameModeInfo = { mode: 'turbo', source: 'clock', raw: 'start -1:00' };
const idx = (f: string) => DANGER_FEATURES.indexOf(f as never);

/** Модель для тестов: риск растёт от врагов вплотную и малого здоровья */
function testModel(normal: boolean, turbo: boolean): DangerModel {
  const w = DANGER_FEATURES.map(() => 0);
  w[idx('enemiesClose')] = 6;
  w[idx('lowHp')] = 4;
  return { schema: 'dota-coach.danger-model', version: 1, features: [...DANGER_FEATURES], horizonSec: 15, cooldownSec: 20, leadSec: 0, trainedAt: 'test', normal: { enabled: normal, threshold: 0.5, replaces: [...RISK_RULES], weights: { bias: -3, w } }, turbo: { enabled: turbo, threshold: 0.5, replaces: [...RISK_RULES], weights: { bias: -3, w } } };
}

function ctx(i: Partial<SimInput>, model: DangerModel | null, turbo = false) {
  const data: CoachData = { ...realData(), dangerModel: model };
  const s = sim({ wallMs: T0, clock: 900, ...i });
  const v = buildView(s.state, s.gsi, T0);
  const mem = new CoachMemory();
  const look = new CoachLookup(data);
  if (turbo) look.setMode(TURBO);
  return { c: { v, mem, ev: mem.ingest(v, 1800), look, settings: defaultCoachSettings(), now: T0 } as never, v };
}
const ids = (c: never) => DANGER_RULES.flatMap((r) => [r(c)].flat()).filter((h): h is HintDraft => !!h).map((h) => h.id);

/** Двое врагов вплотную, своего здоровья мало, предметов-регена нет */
const caughtEnemies: NonNullable<SimInput['enemies']> = [
  ...[5, 6].map((slot) => ({ slot, hero: 'axe', pos: { x: 3300, y: 2600 } })),
  ...[7, 8].map((slot) => ({ slot, hero: 'lion', pos: null, missingForSec: 20 })),
];
const caught: Partial<SimInput> = { pos: { x: 3000, y: 2500 }, hp: 150, maxHp: 1000, items: [], enemies: caughtEnemies };
const safe: Partial<SimInput> = { pos: { x: -6000, y: -6000 }, hp: 1000, maxHp: 1000, enemies: [5, 6].map((slot) => ({ slot, hero: 'axe', pos: { x: 5000, y: 5000 } })) };

describe('модель опасности', () => {
  it('признаки — по стадии игры, без минут: тот же герой в разное время → те же признаки; режим — отдельный признак', () => {
    const a = ctx({ ...caught, clock: 600, level: 12 }, null).v;
    const b = ctx({ ...caught, clock: 2400, level: 12 }, null).v;
    const fa = dangerFeatures(a, { itemValue: 5000, turbo: false })!;
    expect(fa).toHaveLength(DANGER_FEATURES.length);
    expect(dangerFeatures(b, { itemValue: 5000, turbo: false })).toEqual(fa);
    const ft = dangerFeatures(a, { itemValue: 5000, turbo: true })!;
    expect(ft[idx('turbo')]).toBe(1);
    expect(fa[idx('turbo')]).toBe(0);
    for (const x of fa) expect(Math.abs(x)).toBeLessThanOrEqual(1);
    // враги вплотную и мало здоровья — видно в признаках
    expect(fa[idx('enemiesClose')]).toBeCloseTo(2 / 5);
    expect(fa[idx('lowHp')]).toBeGreaterThan(0.5);
  });

  it('нет своего места или здоровья — признаков нет (модель молчит)', () => {
    // без GSI и без своего значка на мини-карте места нет
    expect(dangerFeatures(ctx({ ...caught, pos: undefined, noGsi: true }, null).v, { itemValue: null, turbo: false })).toBeNull();
  });

  it('стоимость предметов — без расходников', () => {
    const cost = (k: string) => ({ black_king_bar: 4050, tango: 90, tpscroll: 100, blink: 2250 })[k] ?? null;
    expect(itemValueOf(['black_king_bar', 'tango', 'tpscroll', 'blink'], cost)).toBe(6300);
  });

  it('файл модели в сборке разбирается; чужие признаки или испорченный файл — null (работают правила)', () => {
    const m = parseDangerModel(modelJson);
    expect(m).not.toBeNull();
    expect(m!.features).toEqual([...DANGER_FEATURES]);
    expect(parseDangerModel({ ...modelJson, features: ['hp'] })).toBeNull();
    expect(parseDangerModel({ ...modelJson, normal: { enabled: true } })).toBeNull();
    expect(parseDangerModel(null)).toBeNull();
  });

  it('модель включена в режиме — предупреждает о риске и заменяет правила о риске', () => {
    const { c } = ctx(caught, testModel(true, false));
    const p = dangerProbability(testModel(true, false).normal.weights, dangerFeatures(ctx(caught, null).v, { itemValue: null, turbo: false })!);
    expect(p).toBeGreaterThan(0.5);
    const shown = ids(c);
    expect(shown).toContain('danger.model');
    for (const r of RISK_RULES) expect(shown).not.toContain(r);
    // в безопасном месте — молчит
    expect(modelRule(ctx(safe, testModel(true, false)).c)).toBeNull();
  });

  it('модель выключена в режиме (не лучше правил) — работают правила, модели нет', () => {
    // Турбо: модель только для All Pick
    const turboCtx = ctx(caught, testModel(true, false), true).c;
    const t = ids(turboCtx);
    expect(t).not.toContain('danger.model');
    expect(t.some((id) => (RISK_RULES as readonly string[]).includes(id))).toBe(true);
    // без модели вовсе — то же, что раньше
    const none = ids(ctx(caught, null).c);
    expect(none).not.toContain('danger.model');
    expect(none.some((id) => (RISK_RULES as readonly string[]).includes(id))).toBe(true);
  });

  it('в Турбо — веса Турбо, если там модель включена', () => {
    const m = testModel(false, true);
    expect(ids(ctx(caught, m, true).c)).toContain('danger.model');
    expect(ids(ctx(caught, m, false).c)).not.toContain('danger.model');
  });

  it('гибрид: модель заменяет только «мало здоровья» — ранние правила (враги пропали, ганкер, чужой лес) остаются', () => {
    const m = testModel(true, true);
    m.normal.replaces = ['danger.low-hp'];
    const shown = ids(ctx(caught, m).c);
    expect(shown).toContain('danger.model');
    expect(shown).not.toContain('danger.low-hp');
    // трое врагов пропали на чужой стороне: «враги пропали» звучит, как без модели
    const missing3 = { ...caught, enemies: [5, 6, 7].map((slot) => ({ slot, hero: 'axe', pos: null, missingForSec: 20 })) };
    expect(ids(ctx(missing3, m).c)).toContain('danger.missing');
    // старый файл модели без поля replaces — заменяются все четыре
    expect(parseDangerModel({ ...modelJson, normal: { ...modelJson.normal, replaces: undefined } })!.normal.replaces).toEqual([...RISK_RULES]);
  });

  it('деревья решений: обход по порогам, сумма листьев, σ; при деревьях риск считают они, а не веса', () => {
    const f = DANGER_FEATURES.map(() => 0);
    const close = idx('enemiesClose');
    // глубина 2: корень — «враги вплотную ≤ 0,1», дальше — «мало здоровья ≤ 0,5»
    const trees = { depth: 2, bias: -2, trees: [{ f: [close, idx('lowHp'), idx('lowHp')], t: [0.1, 0.5, 0.5], v: [-1, 0, 1, 3] }] };
    expect(treesProbability(trees, f)).toBeCloseTo(1 / (1 + Math.exp(3)));
    f[close] = 0.4;
    f[idx('lowHp')] = 0.8;
    expect(treesProbability(trees, f)).toBeCloseTo(1 / (1 + Math.exp(-1)));
    const w = { bias: -10, w: DANGER_FEATURES.map(() => 0) };
    expect(dangerRisk({ weights: w, trees }, f)).toBeCloseTo(treesProbability(trees, f));
    expect(dangerRisk({ weights: w }, f)).toBeCloseTo(dangerProbability(w, f));
    // в файле модели деревья с неверным номером признака не принимаются
    const bad = { ...modelJson, normal: { ...modelJson.normal, trees: { depth: 1, bias: 0, trees: [{ f: [999], t: [0], v: [0, 0] }] } } };
    expect(parseDangerModel(bad)).toBeNull();
  });

  it('текст предупреждения: риск в процентах и причины', () => {
    const h = modelRule(ctx(caught, testModel(true, true)).c) as HintDraft;
    expect(h.priority).toBe('critical');
    expect(h.short).toBe('Высокий риск смерти — отходите');
    expect(h.detail.normal).toMatch(/мало здоровья|враг вплотную/);
    expect(h.facts.find((f) => f.key === 'risk')!.value).toBeGreaterThan(50);
  });
});
