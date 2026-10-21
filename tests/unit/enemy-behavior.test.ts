// Советы о поведении против Blink Dagger и Linken's Sphere у врага (rules/enemy-items.ts, DECISIONS.md п. 80):
// механики — из базы знаний патча, тип цели — Valve datafeed (src/data/targeting.json).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { defaultCoachSettings } from '../../src/core/coach/index.ts';
import { blinkFightRule, blinkSeenRule, linkenRule } from '../../src/core/coach/rules/enemy-items.ts';
import { massControl, parseTargeting } from '../../src/core/coach/targeting.ts';
import type { HintDraft } from '../../src/core/coach/types.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const T0 = 1_000_000;
const targeting = parseTargeting(JSON.parse(readFileSync(join(import.meta.dirname, '../../src/data/targeting.json'), 'utf8')));
const data: CoachData = { ...realData(), targeting };
const look0 = new CoachLookup(data);
const idOf = (k: string) => look0.heroByKey.get(k)!.id;

function ctxOf(i: Partial<SimInput>, seen: { hero: string; key: string; ageSec?: number }[], opts: { mem?: CoachMemory; inFight?: boolean; highRisk?: boolean; engageGo?: boolean } = {}) {
  const s = sim({ wallMs: T0, clock: 1500, ...i });
  const v = buildView(s.state, s.gsi, T0);
  v.enemyItems = seen.map((x) => ({ heroId: idOf(x.hero), key: x.key, ageSec: x.ageSec ?? 10 }));
  const mem = opts.mem ?? new CoachMemory();
  const ev = mem.ingest(v, 1800);
  mem.inFightSinceMs = opts.inFight ? T0 : null;
  return { v, mem, ev, look: new CoachLookup(data), settings: defaultCoachSettings(), now: T0, highRisk: opts.highRisk, engageGo: opts.engageGo } as never;
}
const short = (h: unknown) => (h as HintDraft | null)?.short ?? null;
const text = (h: unknown) => (h as HintDraft | null)?.detail.normal ?? null;

describe('Blink Dagger у врага', () => {
  it('механики подтверждены базой знаний патча: дальность 1200, после урона от героя 3 с не работает; Linken\'s — раз в 14 с', () => {
    expect(look0.itemAttr('blink', 'blink_range')).toBe(1200);
    expect(look0.itemAttr('blink', 'blink_damage_cooldown')).toBe(3);
    expect(look0.itemAttr('sphere', 'block_cooldown')).toBe(14);
    expect(look0.itemByKey.get('blink')!.abilities[0]!.description).toMatch(/cannot be used for 3 seconds after taking damage from an enemy hero/);
  });
  it('массовый контроль — у Tidehunter (Ravage), Enigma, Magnus; Legion Commander прыгает на одну цель', () => {
    expect(massControl(look0.heroByKey.get('tidehunter'), targeting).map((a) => a.key)).toContain('tidehunter_ravage');
    expect(massControl(look0.heroByKey.get('enigma'), targeting).map((a) => a.key)).toContain('enigma_black_hole');
    expect(massControl(look0.heroByKey.get('magnataur'), targeting).map((a) => a.key)).toContain('magnataur_reverse_polarity');
    expect(massControl(look0.heroByKey.get('legion_commander'), targeting)).toEqual([]);
    // «Лучи не оглушают» (Luna, Eclipse) — отрицание, не контроль; парирование одной атаки (Kez) — не массовый
    expect(massControl(look0.heroByKey.get('luna'), targeting)).toEqual([]);
    expect(massControl(look0.heroByKey.get('kez'), targeting)).toEqual([]);
  });
  it('Blink у Tidehunter → «не стойте кучей», с названием его контроля', () => {
    const h = blinkSeenRule(ctxOf({ heroKey: 'lina', heroId: idOf('lina') }, [{ hero: 'tidehunter', key: 'blink' }]));
    expect(short(h)).toBe('У Tidehunter Blink Dagger: не стойте кучей');
    expect(text(h)).toMatch(/Ravage/);
  });
  it('Blink у Legion Commander → «ждите прыжка», ваш спасительный предмет назван', () => {
    const h = blinkSeenRule(ctxOf({ heroKey: 'lina', heroId: idOf('lina'), items: [{ slot: 'inv0', key: 'glimmer_cape' }] }, [{ hero: 'legion_commander', key: 'blink' }]));
    expect(short(h)).toBe('У Legion Commander Blink Dagger: ждите прыжка');
    expect(text(h)).toMatch(/Держите Glimmer Cape наготове/);
  });
  it('дальнобойный герой — подсказка «под уроном Blink 3 с не работает»; ближний — без неё', () => {
    expect(text(blinkSeenRule(ctxOf({ heroKey: 'lina', heroId: idOf('lina') }, [{ hero: 'legion_commander', key: 'blink' }])))).toMatch(/Blink Dagger 3 с не работает/);
    expect(text(blinkSeenRule(ctxOf({ heroKey: 'axe', heroId: idOf('axe') }, [{ hero: 'legion_commander', key: 'blink' }])))).not.toMatch(/не работает/);
  });
  it('у врага Blink, мой герой не видит его больше 3 мин → совет не даётся', () => {
    expect(blinkSeenRule(ctxOf({ heroKey: 'lina', heroId: idOf('lina') }, [{ hero: 'tidehunter', key: 'blink', ageSec: 200 }]))).toBeNull();
  });
  it('перед дракой («Вступать»), враг с Blink только что ушёл в туман → напоминание; без «Вступать» или давно пропал — нет', () => {
    const enemies = [{ slot: 5, hero: 'tidehunter', pos: null, missingForSec: 5 }];
    expect(blinkFightRule(ctxOf({ heroKey: 'lina', heroId: idOf('lina'), enemies: [{ slot: 5, hero: 'tidehunter', pos: null, missingForSec: 90 }] }, [{ hero: 'tidehunter', key: 'blink' }], { engageGo: true }))).toBeNull();
    expect(short(blinkFightRule(ctxOf({ heroKey: 'lina', heroId: idOf('lina'), enemies }, [{ hero: 'tidehunter', key: 'blink' }], { engageGo: true })))).toBe('Осторожно: у Tidehunter Blink Dagger');
    expect(blinkFightRule(ctxOf({ heroKey: 'lina', heroId: idOf('lina'), enemies }, [{ hero: 'tidehunter', key: 'blink' }]))).toBeNull();
  });
});

describe('Linken\'s Sphere у врага', () => {
  const lion = (abilities: SimInput['abilities'], items: SimInput['items'] = []) => ({ heroKey: 'lion', heroId: idOf('lion'), abilities, items });
  it('у врага Linken\'s, у меня нет целевых способностей и предметов → молчит', () => {
    expect(linkenRule(ctxOf(lion([{ key: 'lion_impale', level: 0, state: 'unlearned' }]), [{ hero: 'medusa', key: 'sphere' }]))).toBeNull();
  });
  it('у врага Linken\'s, есть дешёвая целевая способность → совет назвать её, главное — потом', () => {
    const h = linkenRule(ctxOf(lion([{ key: 'lion_impale', level: 2 }, { key: 'lion_voodoo', level: 2 }, { key: 'lion_finger_of_death', level: 1, ultimate: true }]), [{ hero: 'medusa', key: 'sphere' }]));
    expect(text(h)).toMatch(/сначала снимите сферу — (Earth Spike|Hex) \(перезарядка \d+ с\), потом Finger of Death/);
    expect(text(h)).toMatch(/раз в 14 с/);
  });
  it('предмет на одну цель тоже в счёт (Orchid Malevolence)', () => {
    const h = linkenRule(ctxOf(lion([{ key: 'lion_finger_of_death', level: 1, ultimate: true }], [{ slot: 'inv0', key: 'orchid' }]), [{ hero: 'medusa', key: 'sphere' }]));
    expect(text(h)).toMatch(/сначала снимите сферу — Orchid Malevolence/);
  });
  it('совет о поведении во время драки или при «Отходите» → ждёт и не теряется', () => {
    const mem = new CoachMemory();
    const a = [{ key: 'lion_impale', level: 2 }, { key: 'lion_finger_of_death', level: 1, ultimate: true }];
    expect(linkenRule(ctxOf(lion(a), [{ hero: 'medusa', key: 'sphere' }], { mem, inFight: true }))).toBeNull();
    expect(linkenRule(ctxOf(lion(a), [{ hero: 'medusa', key: 'sphere' }], { mem, highRisk: true }))).toBeNull();
    expect(blinkSeenRule(ctxOf(lion(a), [{ hero: 'tidehunter', key: 'blink' }], { mem, highRisk: true }))).toBeNull();
    expect(short(linkenRule(ctxOf(lion(a), [{ hero: 'medusa', key: 'sphere' }], { mem })))).toMatch(/Linken's Sphere: сначала Earth Spike/);
  });
});
