// «Охота»: вражеский кор один — соберитесь и убейте. Срабатывает только при настоящем окне и молчит, когда это
// похоже на засаду, цель не кор, рядом с ней свои или нападать некому.
import { describe, expect, it } from 'vitest';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { buildView } from '../../src/core/coach/view.ts';
import { defaultCoachSettings } from '../../src/core/coach/types.ts';
import type { RuleContext } from '../../src/core/coach/rules/context.ts';
import { pickoffRule, isCore } from '../../src/core/coach/rules/pickoff.ts';
import { mapZone } from '../../src/core/match-state/map-zones.ts';
import { realData, sim, type SimInput, type SimPlayer } from './coach-sim.ts';

const data = realData();
const T0 = 1_000_000;

function ctx(i: Partial<SimInput>): RuleContext {
  const s = sim({ wallMs: T0, clock: 900, team: 'radiant', ...i });
  const v = buildView(s.state, s.gsi, T0);
  const mem = new CoachMemory();
  const ev = mem.ingest(v, 1800);
  return { v, mem, ev, look: new CoachLookup(data), settings: defaultCoachSettings(), now: T0 };
}

// Нижняя линия Сил Света: цель — Anti-Mage врага, рядом наши
const TARGET = { x: 4000, y: -6000 };
const far = (slot: number, hero: string): SimPlayer => ({ slot, hero, pos: { x: -6000 + slot * 100, y: 6000 } });
const enemies = (over: Partial<Record<number, SimPlayer>> = {}): SimPlayer[] =>
  [{ slot: 5, hero: 'antimage', pos: TARGET } as SimPlayer, far(6, 'lion'), far(7, 'crystal_maiden'), far(8, 'axe'), far(9, 'pudge')].map((p) => over[p.slot] ?? p);
const allies: SimPlayer[] = [
  { slot: 1, hero: 'sven', pos: { x: 2500, y: -5600 } },
  { slot: 2, hero: 'lina', pos: { x: 3000, y: -4500 } },
  { slot: 3, hero: 'bane', pos: { x: -5000, y: 5000 } },
];
const run = (i: Partial<SimInput>) => pickoffRule(ctx({ pos: { x: 1500, y: -6000 }, allies, enemies: enemies(), ...i }));

describe('охота на одинокого кора', () => {
  it('керри врага один на нижней линии, рядом двое наших и я — совет напасть', () => {
    expect(mapZone(TARGET.x, TARGET.y)).toBe('bot-lane');
    const d = run({}) as NonNullable<ReturnType<typeof pickoffRule>> & { id: string; short: string; detail: { normal: string } };
    expect(d.id).toBe('macro.pickoff:antimage');
    expect(d.short).toBe('Anti-Mage один — убить');
    expect(d.detail.normal).toMatch(/нижняя линия/);
    expect(d.detail.normal).toMatch(/вы и 2 союзника/);
  });

  it('рядом с целью другой враг — не зовём', () => {
    expect(run({ enemies: enemies({ 6: { slot: 6, hero: 'lion', pos: { x: 4500, y: -5600 } } }) })).toBeNull();
  });

  it('двое врагов пропали с карты — может быть засада, не зовём', () => {
    expect(run({ enemies: enemies({ 6: { slot: 6, hero: 'lion', pos: null, missingForSec: 10 }, 7: { slot: 7, hero: 'crystal_maiden', pos: null, missingForSec: 10 } }) })).toBeNull();
    // один пропавший — зовём, но уверенность ниже
    const d = run({ enemies: enemies({ 6: { slot: 6, hero: 'lion', pos: null, missingForSec: 10 } }) }) as { confidence: number } | null;
    expect(d?.confidence).toBeLessThan(0.75);
  });

  it('одинокий саппорт — не цель «охоты»', () => {
    expect(isCore(ctx({}), 'crystal_maiden')).toBeNull();
    expect(isCore(ctx({}), 'antimage')).toBe('carry');
    expect(run({ enemies: enemies({ 5: { slot: 5, hero: 'crystal_maiden', pos: TARGET }, 7: far(7, 'antimage') }) })).toBeNull();
  });

  it('нападать некому: союзники далеко, я далеко и без ТП — молчим; с ТП — зовём', () => {
    const farAllies = allies.map((a) => ({ ...a, pos: { x: -6000, y: 5000 } }));
    const noTp = [{ slot: 'inv1', key: 'flask' }];
    expect(run({ allies: farAllies, pos: { x: -5000, y: -2000 }, items: noTp })).toBeNull();
    // я далеко, но ТП готов, а рядом с целью двое союзников
    expect(run({ pos: { x: -5000, y: -2000 } })).not.toBeNull();
  });

  it('раньше 6-й минуты, мало здоровья или идёт драка — молчим', () => {
    expect(run({ clock: 300 })).toBeNull();
    expect(run({ hp: 300, maxHp: 1000 })).toBeNull();
  });

  it('цель у себя на базе — не зовём', () => {
    expect(run({ enemies: enemies({ 5: { slot: 5, hero: 'antimage', pos: { x: 6500, y: 6000 } } }) })).toBeNull();
  });
});
