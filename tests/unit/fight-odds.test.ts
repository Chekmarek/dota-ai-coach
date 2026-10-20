// Шанс в драке на экране — по модели драк, постоянно, пока враги рядом, с подписью «кто рядом»: свои против врагов
// вплотную и враги на мини-карте рядом, но не на экране («+1 рядом») — они тоже снижают шанс.
import { describe, expect, it } from 'vitest';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { defaultCoachSettings } from '../../src/core/coach/index.ts';
import { engageRule } from '../../src/core/coach/rules/fight.ts';
import { parseFightModel } from '../../src/core/coach/fight-model.ts';
import { parseDangerModel } from '../../src/core/coach/danger-model.ts';
import type { HintDraft } from '../../src/core/coach/types.ts';
import fightJson from '../../src/data/fight-model.json';
import dangerJson from '../../src/data/danger-model.json';
import { realData, sim, type SimInput } from './coach-sim.ts';

const T0 = 1_000_000;
const withModel = { ...realData(), fightModel: parseFightModel(fightJson), dangerModel: parseDangerModel(dangerJson) };
const ENEMY = ['lina', 'rubick', 'nevermore', 'dark_willow', 'disruptor'];
const ALLY = ['axe', 'lion', 'pudge', 'zeus'];

function engage(i: Partial<SimInput>, data = withModel): HintDraft | null {
  const s = sim({ wallMs: T0, clock: 1500, level: 14, pos: { x: 0, y: 0 }, ...i });
  const v = buildView(s.state, s.gsi, T0);
  const mem = new CoachMemory();
  return engageRule({ v, mem, ev: mem.ingest(v, 1800), look: new CoachLookup(data), settings: defaultCoachSettings(), now: T0 } as never) as HintDraft | null;
}
/** n врагов вплотную (на экране) и far — на мини-карте в 2 000 ед., но не вплотную */
const enemies = (n: number, far = 0) => [
  ...Array.from({ length: n }, (_, k) => ({ slot: 5 + k, hero: ENEMY[k]!, pos: { x: 300 + k * 80, y: 0 } })),
  ...Array.from({ length: far }, (_, k) => ({ slot: 5 + n + k, hero: ENEMY[n + k]!, pos: { x: 2000, y: 300 * k } })),
];
const allies = (n: number) => Array.from({ length: n }, (_, k) => ({ slot: 1 + k, hero: ALLY[k]!, pos: { x: -250 - k * 80, y: 0 } }));
const pct = (h: HintDraft | null) => h?.percent?.estimate.value ?? NaN;

describe('шанс в драке по модели', () => {
  it('модели в сборке разбираются', () => {
    expect(withModel.fightModel).not.toBeNull();
    expect(withModel.dangerModel).not.toBeNull();
  });

  it('подпись — кто рядом: 2 на 2', () => {
    const h = engage({ enemies: enemies(2), allies: allies(1) });
    expect(h?.short).toMatch(/2 на 2$/);
  });

  it('враг на мини-карте рядом, но не на экране: «(+1 рядом)» и шанс ниже', () => {
    const plain = engage({ enemies: enemies(2), allies: allies(1) });
    const more = engage({ enemies: enemies(2, 1), allies: allies(1) });
    expect(more?.short).toMatch(/2 на 2 \(\+1 рядом\)$/);
    expect(pct(more)).toBeLessThan(pct(plain));
  });

  it('разные расклады: чем больше своих против врагов, тем выше шанс', () => {
    const v13 = pct(engage({ enemies: enemies(3), allies: allies(0) }));
    const v33 = pct(engage({ enemies: enemies(3), allies: allies(2) }));
    const v31 = pct(engage({ enemies: enemies(1), allies: allies(2) }));
    expect(v13).toBeLessThan(v33);
    expect(v33).toBeLessThan(v31);
    expect(engage({ enemies: enemies(3), allies: allies(0) })?.short).toMatch(/1 на 3/);
    expect(engage({ enemies: enemies(4, 1), allies: allies(3) })?.short).toMatch(/4 на 4 \(\+1 рядом\)/);
  });

  it('на экране постоянно, пока враги рядом: короткая жизнь и пауза — подсказка обновляется каждый тик', () => {
    const h = engage({ enemies: enemies(2), allies: allies(1) })!;
    expect(h.ttlMs).toBe(4000);
    expect(h.cooldownMs).toBe(3000);
  });

  it('без модели — прежняя оценка правил, без подписи и раз в 30 с', () => {
    const h = engage({ enemies: enemies(2), allies: allies(1) }, { ...realData(), fightModel: null, dangerModel: null });
    expect(h?.short ?? '').not.toMatch(/ на /);
    if (h) expect(h.cooldownMs).toBe(30_000);
  });
});
