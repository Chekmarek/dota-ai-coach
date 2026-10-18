// Ошибки двух матчей Турбо 2026-10-18 (9051402480 — Bristleback, 9051474634 — Ogre Magi), найденные по кадрам
// набора и истории коуча: иллюзии в счёте врагов, Tango как «неиспользованный», смерть с Aegis, «возрождение через
// 0 с», выкуп после выкупа, свой аванпост, «продайте Clarity» вместе с «выпейте Clarity», «Вступать» рядом с «Отходи».
import { describe, expect, it } from 'vitest';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory, nearEnemyCount, readyActives } from '../../src/core/coach/memory.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { buybackRule, disengageRule, engageRule } from '../../src/core/coach/rules/fight.ts';
import { sellRule } from '../../src/core/coach/rules/economy.ts';
import type { GameModeInfo } from '../../src/core/gsi/mode.ts';
import { HintQueue } from '../../src/core/coach/queue.ts';
import type { HintDraft } from '../../src/core/coach/types.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const TURBO: GameModeInfo = { mode: 'turbo', source: 'clock', raw: 'start -1:00' };
const data = realData();
const look = new CoachLookup(data);
const T0 = 1_000_000;

function ctxOf(i: Partial<SimInput>, opts: { turbo?: boolean; mem?: CoachMemory; now?: number } = {}) {
  const now = opts.now ?? T0;
  const s = sim({ wallMs: now, clock: 600, ...i });
  const v = buildView(s.state, s.gsi, now);
  const mem = opts.mem ?? new CoachMemory();
  const l = new CoachLookup(data);
  if (opts.turbo) l.setMode(TURBO);
  return { v, mem, ev: mem.ingest(v, 1800), look: l, settings: defaultCoachSettings(), now } as never;
}

describe('иллюзии: полосок больше, чем врагов', () => {
  const bars = (n: number) => Array.from({ length: n }, (_, k) => ({ team: 'dire' as const, side: 'enemy' as const, hpPercent: 50, level: 30, slot: null, x: 600 + k * 90, y: 300, confidence: 0.8 }));
  it('11 полосок (Phantom Lancer с иллюзиями, матч 9051402480, 31:54) → не больше 5 врагов', () => {
    const s = sim({ wallMs: T0, clock: 1914, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'phantom_lancer', pos: { x: 300, y: 0 } }] });
    s.state.healthBars = [{ team: 'radiant', side: 'ally', hpPercent: 17, level: 30, slot: s.gsi!.slot!, x: 900, y: 500, confidence: 0.9 }, ...bars(11)];
    expect(nearEnemyCount(buildView(s.state, s.gsi, T0))).toBe(5);
  });
  it('двое врагов мертвы → не больше 3', () => {
    const s = sim({
      wallMs: T0,
      clock: 1914,
      pos: { x: 0, y: 0 },
      enemies: [
        { slot: 5, hero: 'phantom_lancer', pos: { x: 300, y: 0 } },
        { slot: 6, hero: 'lina', alive: false },
        { slot: 7, hero: 'invoker', alive: false },
      ],
    });
    s.state.healthBars = [{ team: 'radiant', side: 'ally', hpPercent: 17, level: 30, slot: s.gsi!.slot!, x: 900, y: 500, confidence: 0.9 }, ...bars(8)];
    expect(nearEnemyCount(buildView(s.state, s.gsi, T0))).toBe(3);
  });
});

describe('разбор смерти', () => {
  /** 5 с здоровье падает, затем смерть */
  function die(i: Partial<SimInput>, deadFrames: Partial<SimInput>[] = [{}]) {
    const e = new CoachEngine({ data, now: () => 0 });
    for (let t = 0; t < 6; t++) {
      const w = T0 + t * 1000;
      const s = sim({ wallMs: w, clock: 300 + t, level: 7, hp: Math.max(1, 1100 - t * 200), maxHp: 1176, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 200, y: 0 } }], ...i });
      e.tick(s.state, s.gsi, w);
    }
    deadFrames.forEach((f, k) => {
      const w = T0 + (6 + k) * 1000;
      const s = sim({ wallMs: w, clock: 306 + k, level: 7, alive: false, maxHp: 1176, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 200, y: 0 } }], ...i, ...f });
      e.tick(s.state, s.gsi, w);
    });
    return e;
  }
  it('Tango, Healing Salve, Clarity — не «готов, но не использован» (матч 9051402480, 5:11 и 8:10)', () => {
    const items = [
      { slot: 'inv0', key: 'tango', charges: 1, canCast: true, passive: false },
      { slot: 'inv1', key: 'flask', charges: 1, canCast: true, passive: false },
      { slot: 'inv2', key: 'clarity', charges: 1, canCast: true, passive: false },
    ];
    const s = sim({ wallMs: T0, clock: 300, items });
    expect(readyActives(buildView(s.state, s.gsi, T0)).filter((a) => a.kind === 'item')).toEqual([]);
    const e = die({ items });
    expect(e.deathReviewNow!.why.join(' ')).not.toMatch(/Tango|Healing Salve|Clarity/);
    expect(e.mistakes.list.map((m) => m.text).join(' ')).not.toMatch(/Tango/);
  });
  it('смерть с Aegis — не смерть: ни разбора, ни ошибки (матч 9051402480, 27:01)', () => {
    const e = die({ items: [{ slot: 'inv0', key: 'aegis', passive: true }, { slot: 'tp', key: 'tpscroll', charges: 1 }] });
    expect(e.mem.deaths.length).toBe(0);
    expect(e.deathReviewNow).toBeNull();
    expect(e.mistakes.list.some((m) => m.type === 'died-unused')).toBe(false);
  });
  it('в миг смерти GSI присылает «возрождение 0», через секунду 73 → в разборе нет «через 0 с», время дописывается', () => {
    const e = die({ buybackCost: 500, gold: 3000 }, [{ respawnSec: 0 }, { respawnSec: 73 }]);
    expect(JSON.stringify(e.deathReviewNow)).not.toContain('через 0 с');
    expect(e.mem.deaths[0]!.respawnSec).toBe(73);
  });
  it('5 врагов на одного — главная причина: меньшинство, «5 врагов» (было «5 врага»)', () => {
    const enemies = [5, 6, 7, 8, 9].map((slot, k) => ({ slot, hero: ['lina', 'rubick', 'nevermore', 'dark_willow', 'disruptor'][k]!, pos: { x: 100 + k * 50, y: 0 } }));
    const e = die({ enemies });
    expect(e.deathReviewNow!.why[0]).toBe('Вы были в меньшинстве: 5 врагов против вас одного');
  });
  it('выкуп в Турбо: цена, золото и время возрождения — вместо «совет не проверен»', () => {
    const e = new CoachEngine({ data, now: () => 0, settings: { ...defaultCoachSettings(), gameMode: 'turbo' } });
    for (let t = 0; t < 8; t++) {
      const w = T0 + t * 1000;
      const s = sim({ wallMs: w, clock: 1900 + t, mode: TURBO, level: 30, hp: Math.max(1, 6000 - t * 1000), maxHp: 6664, alive: t < 6, respawnSec: t === 6 ? 0 : 67, gold: 13700, buybackCost: 8900, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 200, y: 0 } }] });
      e.tick(s.state, s.gsi, w);
    }
    const text = e.deathReviewNow!.buyback.text;
    // лейт, возрождение 67 с, база цела — «выкупайтесь, если команда дерётся», с ценой и золотом
    expect(text).toMatch(/^Выкуп 8900, у вас 13700: выкупайтесь, если команда/);
    expect(text).not.toContain('не проверен');
  });
});

describe('выкуп после выкупа', () => {
  it('выкуп на перезарядке (только что выкупились, матч 9051402480, 32:10) — «Выкуп 7534, у вас 4826» не пишется', () => {
    const fight = { clock: 1931, gold: 4826, buybackCost: 7534, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] };
    expect(buybackRule(ctxOf({ ...fight, buybackCooldown: 2582 }))).toBeNull();
    expect(buybackRule(ctxOf({ ...fight, buybackCooldown: 0 }))).not.toBeNull();
  });
});

describe('совет «продайте» и расходники', () => {
  const full = (k: string) => [
    { slot: 'inv0', key: 'blade_mail' },
    { slot: 'inv1', key: k, charges: 1 },
    { slot: 'inv2', key: 'heart' },
    { slot: 'inv3', key: 'power_treads' },
    { slot: 'inv4', key: 'reaver' },
  ];
  it('мало маны — Clarity не «лишняя» (матч 9051474634, 17:00 «продайте» и 17:05 «выпейте»)', () => {
    expect(sellRule(ctxOf({ clock: 1020, items: full('clarity'), mana: 400, maxMana: 2135 }, { turbo: true }))).toBeNull();
  });
  it('маны много — «Clarity — используйте или продайте», а не просто «продайте»', () => {
    const h = sellRule(ctxOf({ clock: 1020, items: full('clarity'), mana: 2000, maxMana: 2135 }, { turbo: true })) as { short: string } | null;
    expect(h?.short).toBe('Лишнее: Clarity — используйте или продайте');
  });
});

describe('совет «продайте» не повторяется при смене набора предметов', () => {
  it('«два Null Talisman», потом «Null Talisman + Tango» — один номер подсказки, перерыв 5 минут общий (матч 9051512826: 5 раз за 7 минут)', () => {
    const base = [
      { slot: 'inv0', key: 'blade_mail' },
      { slot: 'inv1', key: 'null_talisman' },
      { slot: 'inv2', key: 'heart' },
      { slot: 'inv3', key: 'power_treads' },
    ];
    const sets = [
      [...base, { slot: 'inv4', key: 'null_talisman' }],
      [...base, { slot: 'inv4', key: 'reaver' }],
      [...base, { slot: 'inv4', key: 'tango', charges: 1 }],
    ];
    const drafts = sets.map((items, k) => sellRule(ctxOf({ clock: 930 + k * 60, items, mana: 400, maxMana: 400, hp: 1000, maxHp: 1000 }, { turbo: true, now: T0 + k * 60_000 })) as HintDraft | null);
    expect(drafts.every((d) => d !== null)).toBe(true);
    expect(new Set(drafts.map((d) => d!.id)).size).toBe(1);
    // очередь подсказок: второй и третий совет в пределах 5 минут — на перерыве
    const q = new HintQueue();
    const settings = defaultCoachSettings();
    const statuses = drafts.map((d, k) => q.push(d!, { now: T0 + k * 60_000, clock: 930 + k * 60, inFight: false, settings }).status);
    expect(statuses[0]).toBe('shown');
    expect(statuses.slice(1).some((s) => s === 'shown')).toBe(false);
  });
});

describe('«Вступать» и «Отходи» не спорят', () => {
  const enemies = (n: number) => Array.from({ length: n }, (_, k) => ({ slot: 5 + k, hero: ['lina', 'rubick', 'nevermore', 'dark_willow', 'disruptor'][k]!, pos: { x: 200 + k * 60, y: 0 } }));
  const allies = (n: number) => Array.from({ length: n }, (_, k) => ({ slot: 1 + k, hero: ['axe', 'lion', 'pudge', 'zeus'][k]!, pos: { x: -200 - k * 60, y: 0 } }));
  function fightMem(before: number, alliesN: number) {
    const mem = new CoachMemory();
    for (let t = 0; t < 3; t++) ctxOf({ clock: 1300 + t, pos: { x: 0, y: 0 }, enemies: enemies(before), allies: allies(alliesN) }, { mem, now: T0 + t * 1000 });
    mem.inFightSinceMs = T0;
    return mem;
  }
  it('врагов стало 3 вместо 1, но вас с союзниками 4 — «Отходи» не звучит', () => {
    const mem = fightMem(1, 3);
    expect(disengageRule(ctxOf({ clock: 1303, pos: { x: 0, y: 0 }, enemies: enemies(3), allies: allies(3) }, { mem, now: T0 + 3000 }))).toBeNull();
  });
  it('врагов 4 вместо 1, вы вдвоём — «Отходи», и 10 с после него нет «Вступать»', () => {
    const mem = fightMem(1, 1);
    const off = disengageRule(ctxOf({ clock: 1303, pos: { x: 0, y: 0 }, enemies: enemies(4), allies: allies(1) }, { mem, now: T0 + 3000 })) as { short: string } | null;
    expect(off?.short).toBe('Отходи: пришли ещё враги');
    // сразу после: враги растаяли на экране (иллюзии ушли) — «Вступать» не советуем
    const strong = { clock: 1305, level: 30, hp: 7000, maxHp: 7300, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 200, y: 0 }, hpPercent: 10, barLevel: 10 }], allies: allies(1) };
    expect(engageRule(ctxOf(strong, { mem, now: T0 + 5000 }))).toBeNull();
    // та же обстановка без недавнего «Отходи» — «Вступать» есть (проверка, что тест не пустой)
    expect((engageRule(ctxOf(strong, { now: T0 + 5000 })) as { short: string } | null)?.short).toMatch(/^Вступать/);
    // через 10 с — снова можно
    expect(engageRule(ctxOf({ ...strong, clock: 1316 }, { mem, now: T0 + 16_000 }))).not.toBeNull();
  });
});
