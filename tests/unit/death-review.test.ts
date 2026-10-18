// Этап 4 «понимания игры»: разбор смерти — причины по порядку важности, одна главная и не больше одной дополнительной;
// расходники — только в лайнинге и при медленном падении здоровья; не уверен — так и говорит.
import { describe, expect, it } from 'vitest';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { deathCauses } from '../../src/core/coach/reviews.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import type { DeathRecord } from '../../src/core/coach/memory.ts';
import { realData, sim } from './coach-sim.ts';

const look = new CoachLookup(realData());

function death(p: Partial<DeathRecord>): DeathRecord {
  return {
    clock: 1500, wallMs: 0, zone: 'mid-lane', side: 'own', night: false, hpBefore: 90, dropSec: 6, enemiesNear: 1, alliesNear: 0, enemiesMissing: 0,
    ultReady: null, keyItemsReady: [], readyActives: [], tpReady: false, hadRegen: false, buybackReady: null, gold: 1000, buybackCost: 2000, respawnSec: 40,
    engageAtEntry: null, myLevel: 20, enemyLevels: [20], regenItems: [], ...p,
  };
}
const ids = (d: DeathRecord, stage: 'laning' | 'mid' | 'late') => deathCauses(d, stage, look).map((c) => c.id);

describe('причины смерти по важности', () => {
  it('смерть в лейте с Tango в инвентаре и медленным падением здоровья — причина не Tango', () => {
    const d = death({ regenItems: ['tango', 'flask'], dropSec: 12, side: 'enemy', alliesNear: 0, enemiesMissing: 3 });
    const causes = deathCauses(d, 'late', look);
    expect(causes.map((c) => c.id)).not.toContain('regen');
    expect(causes.map((c) => c.why).join(' ')).not.toMatch(/Tango|Healing Salve/);
    expect(causes[0]!.id).toBe('position');
  });
  it('в лайнинге с Tango и медленным падением здоровья — «можно было подлечиться»; быстрым — нет', () => {
    expect(ids(death({ clock: 240, regenItems: ['tango'], dropSec: 10 }), 'laning')).toContain('regen');
    expect(ids(death({ clock: 240, regenItems: ['tango'], dropSec: 3 }), 'laning')).not.toContain('regen');
  });
  it('меньшинство — первая причина: 4 врага против вас и одного союзника', () => {
    const c = deathCauses(death({ enemiesNear: 4, alliesNear: 1, readyActives: [{ kind: 'item', key: 'blade_mail' }] }), 'mid', look);
    expect(c[0]!.why).toBe('Вы были в меньшинстве: 4 врага против вас и 1 союзника');
    expect(c[1]!.id).toBe('unused');
  });
  it('в лейте позиция важнее меньшинства', () => {
    expect(ids(death({ enemiesNear: 3, alliesNear: 0, side: 'enemy', enemiesMissing: 2 }), 'late')[0]).toBe('position');
    expect(ids(death({ enemiesNear: 3, alliesNear: 0, side: 'enemy', enemiesMissing: 2 }), 'mid')[0]).toBe('outnumbered');
  });
  it('мог уйти: Town Portal Scroll готов, здоровье падало 8 с', () => {
    const c = deathCauses(death({ tpReady: true, dropSec: 8 }), 'mid', look);
    expect(c.map((x) => x.why)).toContain('Можно было уйти: Town Portal Scroll был готов, а здоровье падало 8 с');
    expect(ids(death({ tpReady: true, dropSec: 2 }), 'mid')).not.toContain('escape');
  });
  it('разница в силе: враги на 3 уровня выше', () => {
    expect(deathCauses(death({ myLevel: 9, enemyLevels: [12, 12] }), 'mid', look).map((x) => x.why)).toContain('Враги были сильнее: уровень 12 против вашего 9');
  });
});

describe('разбор смерти в матче', () => {
  /** Матч: 6 с здоровье падает, затем смерть */
  function die(i: Parameters<typeof sim>[0] extends infer S ? Partial<S> : never, clock0: number) {
    const e = new CoachEngine({ data: realData(), now: () => 0, settings: defaultCoachSettings() });
    for (let t = 0; t < 8; t++) {
      const w = 1_000_000 + t * 1000;
      const s = sim({ wallMs: w, clock: clock0 + t, hp: Math.max(1, 3000 - t * 450), maxHp: 3000, alive: t < 7, pos: { x: 0, y: 0 }, ...i });
      e.tick(s.state, s.gsi, w);
    }
    return e.deathReviewNow!;
  }
  it('не больше двух причин; Tango в лейте не упоминается', () => {
    const r = die({ level: 25, items: [{ slot: 'inv0', key: 'tango', charges: 3 }, { slot: 'inv1', key: 'blade_mail', canCast: true, passive: false }], enemies: [5, 6, 7, 8].map((slot) => ({ slot, hero: 'lina', pos: { x: 200, y: 50 * slot } })) }, 2000);
    expect(r.why.length).toBeLessThanOrEqual(2);
    expect(r.why.join(' ')).not.toContain('Tango');
    expect(r.why[0]).toMatch(/^Вы были в меньшинстве/);
    expect(r.tips.length).toBe(1);
  });
  it('ничего не известно (враги не видны) — честно «коуч не уверен»', () => {
    const r = die({ level: 18, items: [], abilities: [{ key: 'antimage_mana_void', level: 3, ultimate: true, state: 'cooldown', cooldownSec: 50 }] }, 1500);
    expect(r.why).toEqual(['Коуч не уверен в причине: не было видно, кто и сколько врагов было рядом']);
  });
});
