// Правила движка подсказок на синтетическом матче: каждое срабатывает в своей ситуации и молчит без данных.
import { describe, expect, it } from 'vitest';
import { CoachEngine, type CoachUpdate } from '../../src/core/coach/engine.ts';
import { ALL_RULES } from '../../src/core/coach/engine.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { buildView } from '../../src/core/coach/view.ts';
import { defaultCoachSettings, wordCount, type HintDraft } from '../../src/core/coach/types.ts';
import type { RuleContext } from '../../src/core/coach/rules/context.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const data = realData();
const T0 = 1_000_000;

/** Прогон движка по кадрам раз в секунду; возвращает все обновления */
function run(frames: (t: number) => Partial<SimInput>, seconds: number, startClock = 600, engine = new CoachEngine({ data, now: () => 0 })): { e: CoachEngine; ups: CoachUpdate[] } {
  const ups: CoachUpdate[] = [];
  for (let t = 0; t < seconds; t++) {
    const wallMs = T0 + t * 1000;
    const s = sim({ wallMs, clock: startClock + t, ...frames(t) });
    ups.push(engine.tick(s.state, s.gsi, wallMs));
  }
  return { e: engine, ups };
}
const shownIds = (ups: CoachUpdate[]) => ups.flatMap((u) => u.shown.map((h) => h.id));

/** Все черновики всех правил для одного снимка (без очереди) */
function drafts(i: Partial<SimInput>, prep?: (mem: CoachMemory) => void): HintDraft[] {
  const s = sim({ wallMs: T0, clock: 900, ...i });
  const v = buildView(s.state, s.gsi, T0);
  const mem = new CoachMemory();
  prep?.(mem);
  const ev = mem.ingest(v, 1800);
  const c: RuleContext = { v, mem, ev, look: new CoachLookup(data), settings: defaultCoachSettings(), now: T0 };
  return ALL_RULES.flatMap((r) => {
    const x = r(c);
    return Array.isArray(x) ? x : x ? [x] : [];
  });
}
const ids = (ds: HintDraft[]) => ds.map((d) => d.id);

describe('B. опасность', () => {
  it('мало здоровья, нет регена и ТП, враги пропали → критично «назад»', () => {
    const ds = drafts({ hp: 200, items: [{ slot: 'inv1', key: 'boots' }], enemies: [5, 6].map((slot) => ({ slot, hero: 'axe', pos: null, missingForSec: 15 })) });
    const h = ds.find((d) => d.id === 'danger.low-hp')!;
    expect(h.priority).toBe('critical');
  });

  it('есть фласка — «мало здоровья, нет регена» молчит', () => {
    const ds = drafts({ hp: 200, enemies: [5, 6].map((slot) => ({ slot, hero: 'axe', pos: null, missingForSec: 15 })) });
    expect(ids(ds)).not.toContain('danger.low-hp');
  });

  it('3 врага пропали, а вы на их половине → критично', () => {
    const ds = drafts({ pos: { x: 3000, y: 2500 }, enemies: [5, 6, 7].map((slot) => ({ slot, hero: 'axe', pos: null, missingForSec: 12 })) });
    expect(ds.find((d) => d.id === 'danger.missing')?.priority).toBe('critical');
  });

  it('позиции врагов неизвестны (мини-карта не читается) — «пропали» не говорим', () => {
    const ds = drafts({ pos: { x: 3000, y: 2500 }, enemies: [5, 6, 7].map((slot) => ({ slot, hero: 'axe' })) });
    expect(ids(ds)).not.toContain('danger.missing');
  });

  it('смок: три врага исчезли почти одновременно', () => {
    const { ups } = run((t) => ({ enemies: [5, 6, 7].map((slot) => (t < 5 ? { slot, hero: 'axe', pos: { x: 5000, y: 5000 } } : { slot, hero: 'axe', pos: null, missingForSec: t - 5 })) }), 12);
    expect(shownIds(ups)).toContain('danger.smoke');
  });

  it('здание под атакой, вы на другой линии', () => {
    const { ups } = run((t) => ({ pos: { x: -6500, y: 3000 }, buildings: [{ key: 'tower1_bot', health: 1800 - t * 60, maxHealth: 1800 }] }), 6);
    expect(shownIds(ups).some((id) => id.startsWith('danger.building:tower1_bot'))).toBe(true);
  });

  it('невидимый враг, а пыли нет', () => {
    const ds = drafts({ enemies: [{ slot: 5, hero: 'riki', pos: { x: 5000, y: 5000 } }] });
    expect(ids(ds)).toContain('danger.invis:riki');
  });
});

describe('A. драки', () => {
  it('враг рядом → карточка «вступать / не вступать» с процентом и факторами', () => {
    const ds = drafts({ enemies: [{ slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 }, hpPercent: 30, barLevel: 6 }] });
    const h = ds.find((d) => d.id === 'fight.engage')!;
    expect(h.percent!.estimate.factors.length).toBeGreaterThan(5);
    expect(h.short).toMatch(/\d+%/);
  });

  it('2 врага рядом с полосками здоровья → фокус на слабого', () => {
    const ds = drafts({ enemies: [{ slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 }, hpPercent: 70 }, { slot: 6, hero: 'lion', pos: { x: -3700, y: -3900 }, hpPercent: 20 }] });
    expect(ids(ds)).toContain('fight.target:lion');
  });

  it('пришли ещё враги во время драки → критично «отходи»', () => {
    const near = (slot: number) => ({ slot, hero: 'axe', pos: { x: -3900, y: -4000 } });
    const { ups } = run((t) => ({ enemies: t < 4 ? [near(5)] : [near(5), near(6), near(7)] }), 7);
    expect(shownIds(ups)).toContain('fight.disengage');
  });

  it('поздняя игра, нет золота на выкуп, враги рядом', () => {
    const ds = drafts({ clock: 30 * 60, gold: 200, buybackCost: 1500, enemies: [{ slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 } }] });
    expect(ids(ds)).toContain('fight.no-buyback');
  });
});

describe('C–E. линия, экономика, макро, тайминги', () => {
  it('руна силы объявляется один раз за 15 с до появления', () => {
    const { ups } = run(() => ({}), 30, 1065); // 17:45 → руна в 18:00
    expect(shownIds(ups).filter((id) => id === 'timing.rune-power')).toHaveLength(1);
  });

  it('простой 20+ с → «идите фармить»', () => {
    const { ups } = run(() => ({ pos: { x: -4000, y: -4000 }, commands: 10 }), 30);
    expect(shownIds(ups)).toContain('economy.idle');
  });

  it('много золота дольше 45 с → совет купить предмет из сборки профи патча', () => {
    const { ups } = run((t) => ({ gold: 4000, pos: { x: -4000 + t * 300, y: -4000 } }), 60);
    const h = ups.flatMap((u) => u.shown).find((x) => x.id === 'economy.gold')!;
    expect(h).toBeTruthy();
    expect(h.facts.some((f) => f.source === 'stats' && f.verified === false)).toBe(true);
  });

  it('нет ТП и есть золото → купить ТП', () => {
    const ds = drafts({ items: [{ slot: 'inv1', key: 'flask', charges: 1 }, { slot: 'tp', key: null }], gold: 400 });
    expect(ids(ds)).toContain('economy.tp');
  });

  it('свободное очко навыка дольше 10 с → совет из порядка навыков профи', () => {
    const { ups } = run(() => ({ level: 9, items: [{ slot: 'inv1', key: 'flask', charges: 1 }, { slot: 'tp', key: 'tpscroll', charges: 1 }, { slot: 'neutral', key: 'trusty_shovel' }], abilities: [{ key: 'antimage_mana_break', level: 4 }, { key: 'antimage_blink', level: 3 }, { key: 'antimage_mana_void', level: 1, ultimate: true }] }), 15);
    expect(shownIds(ups)).toContain('economy.skill');
  });

  it('2 врага мертвы — окно для пуша', () => {
    const ds = drafts({ enemies: [5, 6].map((slot) => ({ slot, hero: 'axe', alive: false, respawnAt: 900 + 40 })) });
    expect(ids(ds)).toContain('macro.push');
  });

  it('союзник с двумя врагами далеко → «помогите / ТП»', () => {
    const ds = drafts({
      pos: { x: -6000, y: -6000 },
      allies: [{ slot: 1, hero: 'lion', pos: { x: 3000, y: 3000 } }],
      enemies: [5, 6].map((slot) => ({ slot, hero: 'axe', pos: { x: 3200, y: 3100 } })),
    });
    expect(ids(ds).some((id) => id.startsWith('macro.help'))).toBe(true);
  });

  it('убит Рошан (событие GSI) → окно возрождения по базе знаний', () => {
    const { ups } = run((t) => ({ events: t >= 2 ? [{ type: 'roshan_killed', gameTime: 1290, team: 'dire' }] : [] }), 4, 1200);
    const h = ups.flatMap((u) => u.shown).find((x) => x.id === 'macro.roshan-killed')!;
    expect(h.short).toBe('Рошан вернётся 28:00–31:00');
  });
});

describe('тексты подсказок', () => {
  it('короткий текст не длиннее 8 слов во всех ситуациях', () => {
    const scenarios: Partial<SimInput>[] = [
      { hp: 200, items: [{ slot: 'inv1', key: 'boots' }], enemies: [5, 6, 7].map((slot) => ({ slot, hero: 'axe', pos: null, missingForSec: 15 })), pos: { x: 3000, y: 2500 } },
      { enemies: [{ slot: 5, hero: 'riki', pos: { x: -3800, y: -3900 }, hpPercent: 30, barLevel: 6 }, { slot: 6, hero: 'lion', pos: { x: -3700, y: -3900 }, hpPercent: 20 }] },
      { clock: 30 * 60, gold: 200, buybackCost: 1500, enemies: [{ slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 } }] },
      { enemies: [5, 6, 7].map((slot) => ({ slot, hero: 'axe', alive: false, respawnAt: 990 })), clock: 25 * 60 },
      { items: [{ slot: 'tp', key: null }], gold: 400, hp: 300, night: true, pos: { x: 2500, y: 3500 } },
    ];
    const all = scenarios.flatMap((s) => drafts(s));
    expect(all.length).toBeGreaterThan(10);
    for (const d of all) expect(wordCount(d.short), d.short).toBeLessThanOrEqual(8);
  });

  it('у каждого факта есть источник, возраст и уверенность', () => {
    const all = drafts({ hp: 200, items: [{ slot: 'inv1', key: 'boots' }], enemies: [5, 6, 7].map((slot) => ({ slot, hero: 'riki', pos: null, missingForSec: 15 })), pos: { x: 3000, y: 2500 } });
    for (const d of all)
      for (const f of d.facts) {
        expect(['gsi', 'screen', 'derived', 'kb', 'stats']).toContain(f.source);
        expect(f.confidence).toBeGreaterThanOrEqual(0);
        expect(typeof f.verified).toBe('boolean');
      }
  });
});

describe('F–G. ошибки и разборы', () => {
  const near = (slot: number) => ({ slot, hero: 'axe', pos: { x: 2900, y: 2500 } });

  it('смерть с готовой ультой на чужой стороне → ошибки и разбор с выкупом', () => {
    const { e, ups } = run(
      (t) =>
        t < 8
          ? { pos: { x: 3000, y: 2500 }, level: 12, hp: 1000 - t * 120, enemies: [near(5), near(6), { slot: 7, hero: 'lion', pos: null, missingForSec: 20 }, { slot: 8, hero: 'pudge', pos: null, missingForSec: 20 }] }
          : { pos: { x: 3000, y: 2500 }, level: 12, alive: false, respawnSec: 30, gold: 2000, buybackCost: 900, enemies: [near(5), near(6)] },
      12,
      1500,
    );
    const types = e.mistakes.list.map((m) => m.type);
    expect(types).toContain('died-unused');
    expect(types).toContain('overextended');
    const r = ups.find((u) => u.deathReview)!.deathReview!;
    expect(r.why.length).toBeGreaterThan(0);
    expect(r.tips.length).toBeGreaterThanOrEqual(1);
    expect(r.tips.length).toBeLessThanOrEqual(3);
    expect(r.buyback.advice).toBe('save');
    expect(ups.flatMap((u) => u.shown).some((h) => h.zone === 'review')).toBe(true);
    for (const m of e.mistakes.list) expect(m.clock).not.toBeNull();
  });

  it('разбор матча: результат, статистика против ориентиров, цели', () => {
    const { ups } = run((t) => (t < 70 ? { gpm: 300, xpm: 400 } : { phase: 'post-game', winTeam: 'dire', gpm: 300, xpm: 400 }), 75, 2400);
    const r = ups.find((u) => u.matchReview)!.matchReview!;
    expect(r.result).toBe('loss');
    expect(r.stats.find((s) => s.label === 'GPM')!.ref).toBeGreaterThan(0);
    expect(r.goals.length).toBeGreaterThan(0);
  });
});

describe('скорость правил', () => {
  it('тик правил быстрее 50 мс', () => {
    const { ups } = run((t) => ({ pos: { x: -4000 + t * 50, y: -4000 }, enemies: [5, 6, 7, 8, 9].map((slot) => ({ slot, hero: 'axe', pos: { x: -3000 + slot * 100, y: -3000 }, hpPercent: 50, barLevel: 10 })) }), 120);
    const times = ups.map((u) => u.rulesMs).sort((a, b) => a - b);
    expect(times[Math.floor(times.length * 0.95)]!).toBeLessThan(50);
  });
});
