// Этап 2 «понимания игры»: стадия (лайнинг / мидгейм / лейт), позиция 1–5, герой — и правила, которые на них смотрят.
import { describe, expect, it } from 'vitest';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { buildGameContext, gameStage } from '../../src/core/coach/game-context.ts';
import { game } from '../../src/core/coach/rules/context.ts';
import { disengageRule } from '../../src/core/coach/rules/fight.ts';
import { helpRule, positionAskRule, runeForMe } from '../../src/core/coach/rules/macro.ts';
import { levelRule, regenRule } from '../../src/core/coach/rules/laning.ts';
import { smokeRule } from '../../src/core/coach/rules/danger.ts';
import type { GameModeInfo } from '../../src/core/gsi/mode.ts';
import { settingsSchema } from '../../src/shared/schemas/settings.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const data = realData();
const T0 = 1_000_000;
const TURBO: GameModeInfo = { mode: 'turbo', source: 'clock', raw: 'start -1:00' };

function view(i: Partial<SimInput>) {
  const s = sim({ wallMs: T0, clock: 600, ...i });
  return buildView(s.state, s.gsi, T0);
}
function ctxOf(i: Partial<SimInput>, opts: { turbo?: boolean; mem?: CoachMemory; now?: number; position?: '1' | '2' | '3' | '4' | '5' } = {}) {
  const now = opts.now ?? T0;
  const s = sim({ wallMs: now, clock: 600, ...i });
  const v = buildView(s.state, s.gsi, now);
  const mem = opts.mem ?? new CoachMemory();
  const look = new CoachLookup(data);
  if (opts.turbo) look.setMode(TURBO);
  return { v, mem, ev: mem.ingest(v, 1800), look, settings: { ...defaultCoachSettings(), position: opts.position ?? 'auto' }, now } as never;
}

describe('стадия игры', () => {
  it('обычная игра: 5 мин — лайнинг, 15 — мидгейм, 35 — лейт', () => {
    expect(gameStage(view({ clock: 300, level: 5 }), 1).stage).toBe('laning');
    expect(gameStage(view({ clock: 900, level: 11 }), 1).stage).toBe('mid');
    expect(gameStage(view({ clock: 2100, level: 18 }), 1).stage).toBe('late');
  });
  it('Турбо вдвое быстрее: 6 мин — мидгейм, 16 мин — лейт', () => {
    expect(gameStage(view({ clock: 240, level: 7 }), 0.5).stage).toBe('laning');
    expect(gameStage(view({ clock: 360, level: 9 }), 0.5).stage).toBe('mid');
    expect(gameStage(view({ clock: 960, level: 20 }), 0.5).stage).toBe('late');
  });
  it('уровень сдвигает стадию: 12-й на 7-й минуте — мидгейм, 22-й на 15-й — лейт', () => {
    expect(gameStage(view({ clock: 420, level: 12 }), 1).stage).toBe('mid');
    expect(gameStage(view({ clock: 900, level: 22 }), 1).stage).toBe('late');
  });
  it('потерянные здания: две башни 1-го уровня — мидгейм, казармы — лейт', () => {
    const full = ['tower1_top', 'tower1_mid', 'tower1_bot', 'tower2_top', 'tower2_mid', 'tower2_bot', 'tower3_top', 'tower3_mid', 'tower3_bot', 'rax_melee_top', 'rax_range_top', 'rax_melee_mid', 'rax_range_mid', 'rax_melee_bot', 'rax_range_bot'];
    const b = (gone: string[]) => full.filter((k) => !gone.includes(k)).map((key) => ({ key, health: 1000, maxHealth: 1000 }));
    expect(gameStage(view({ clock: 400, level: 8, buildings: b(['tower1_top', 'tower1_bot']) }), 1).stage).toBe('mid');
    expect(gameStage(view({ clock: 1200, level: 16, buildings: b(['tower1_top', 'tower2_top', 'tower3_top', 'rax_melee_top']) }), 1).stage).toBe('late');
  });
});

describe('позиция', () => {
  /** Память с позициями героя: минута на линии */
  function laneMem(team: 'radiant' | 'dire', pos: { x: number; y: number }, heroKey: string) {
    const mem = new CoachMemory();
    for (let t = 0; t < 80; t++) {
      const s = sim({ wallMs: T0 + t * 1000, clock: 50 + t, team, pos, heroKey });
      mem.ingest(buildView(s.state, s.gsi, T0 + t * 1000), 1800);
    }
    return mem;
  }
  const look = new CoachLookup(data);
  it('старый settings.json без позиции читается: позиция «auto»; мусор — тоже «auto»', () => {
    expect(settingsSchema.parse({ hints: { enabled: true } }).hints.position).toBe('auto');
    expect(settingsSchema.parse({ hints: { position: '7' } }).hints.position).toBe('auto');
    expect(settingsSchema.parse({ hints: { position: '4' } }).hints.position).toBe('4');
  });
  it('выбрана в настройках — она и берётся', () => {
    const g = buildGameContext(view({ clock: 30, heroKey: 'crystal_maiden' }), new CoachMemory(), look, '1');
    expect([g.position, g.positionSource, g.positionConfidence]).toEqual([1, 'settings', 1]);
  });
  it('центр с 1:00 — позиция 2', () => {
    const v = view({ clock: 130, pos: { x: 0, y: 0 }, heroKey: 'invoker' });
    expect(buildGameContext(v, laneMem('radiant', { x: 0, y: 0 }, 'invoker'), look).position).toBe(2);
  });
  it('лёгкая линия (Силы Тьмы — верх): керри — 1, саппорт — 5', () => {
    const top = { x: -6000, y: 5500 };
    expect(buildGameContext(view({ clock: 130, team: 'dire', pos: top, heroKey: 'antimage' }), laneMem('dire', top, 'antimage'), look).position).toBe(1);
    expect(buildGameContext(view({ clock: 130, team: 'dire', pos: top, heroKey: 'crystal_maiden' }), laneMem('dire', top, 'crystal_maiden'), look).position).toBe(5);
  });
  it('до линии позиция — по герою, если он почти всегда на одной (Crystal Maiden — саппорт)', () => {
    const g = buildGameContext(view({ clock: 10, heroKey: 'crystal_maiden' }), new CoachMemory(), look);
    expect(g.position === null || g.position >= 4).toBe(true);
  });
  it('позиция не известна к 2:00 — один раз просим выбрать в окне коуча', () => {
    const mem = new CoachMemory();
    const h = positionAskRule(ctxOf({ clock: 125, heroKey: 'pudge', pos: { x: 2000, y: 2000 } }, { mem })) as { short: string } | null;
    expect(h?.short).toBe('Какая у вас позиция? Выберите в окне коуча');
    expect(positionAskRule(ctxOf({ clock: 140, heroKey: 'pudge', pos: { x: 2000, y: 2000 } }, { mem }))).toBeNull();
    expect(positionAskRule(ctxOf({ clock: 125, heroKey: 'pudge' }, { position: '3' }))).toBeNull();
  });
});

describe('правила смотрят на стадию и позицию', () => {
  it('1-я минута, позиция 1 → нет «Фармить: лес» (ни совета ИИ, ни «Фармить: N%»)', () => {
    let now = T0;
    const e = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), position: '1' } });
    const shown: string[] = [];
    for (let t = 0; t < 120; t++) {
      now = T0 + t * 1000;
      const s = sim({ wallMs: now, clock: t, team: 'dire', level: 1 + Math.floor(t / 40), pos: { x: 3000, y: 3000 } });
      shown.push(...e.tick(s.state, s.gsi, now).shown.map((h) => `${h.id} ${h.short}`));
    }
    expect(shown.filter((x) => /лес|^fight\.action|^ai\.advice/.test(x))).toEqual([]);
  });
  it('в лайнинге драка союзников на другой линии — без «телепорт»', () => {
    const fight = { team: 'dire' as const, pos: { x: 6000, y: -5000 }, allies: [{ slot: 6, hero: 'lion', pos: { x: -6000, y: 5000 } }], enemies: [0, 1].map((slot) => ({ slot, hero: slot ? 'axe' : 'lina', pos: { x: -6000 + slot * 200, y: 5100 } })) };
    expect(helpRule(ctxOf({ ...fight, clock: 90, level: 3 }))).toBeNull();
    expect(helpRule(ctxOf({ ...fight, clock: 1200, level: 15 }))).not.toBeNull();
  });
  it('союзник погиб на другом конце карты — «Отходи: союзник погиб» не звучит', () => {
    const mem = new CoachMemory();
    const enemies = [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }];
    ctxOf({ clock: 1300, pos: { x: 0, y: 0 }, enemies, allies: [{ slot: 1, hero: 'lion', pos: { x: -6000, y: -6000 } }] }, { mem, now: T0 });
    mem.inFightSinceMs = T0;
    const c = ctxOf({ clock: 1301, pos: { x: 0, y: 0 }, enemies: [...enemies, { slot: 6, hero: 'axe', pos: { x: 350, y: 0 } }, { slot: 7, hero: 'zeus', pos: { x: 400, y: 0 } }], allies: [{ slot: 1, hero: 'lion', alive: false, pos: { x: -6000, y: -6000 } }] }, { mem, now: T0 + 1000 }) as { ev: { allyDied: number[] } };
    expect(c.ev.allyDied).toEqual([1]);
    expect((disengageRule(c as never) as { short: string } | null)?.short ?? null).not.toBe('Отходи: союзник погиб');
  });
  it('после лайнинга «съешьте Tango» и «выпейте Healing Salve» не звучат', () => {
    const items = [{ slot: 'inv0', key: 'tango', charges: 2 }, { slot: 'inv1', key: 'flask', charges: 1 }];
    expect(regenRule(ctxOf({ clock: 300, level: 5, hp: 300, maxHp: 1000, items, pos: { x: 0, y: 0 } }))).not.toEqual([]);
    expect(regenRule(ctxOf({ clock: 1500, level: 18, hp: 300, maxHp: 3000, items, pos: { x: 0, y: 0 } }))).toBeNull();
  });
  it('6-й уровень с пассивной ультой (Bristleback) — без «ищите убийство с ультой»', () => {
    const mem = new CoachMemory();
    const abil = (lvl: number) => [{ key: 'bristleback_bristleback', level: 1, passive: true }, { key: 'bristleback_warpath', level: lvl, ultimate: true, passive: true }];
    ctxOf({ clock: 400, level: 5, heroKey: 'bristleback', abilities: abil(0) }, { mem, now: T0 });
    const out = levelRule(ctxOf({ clock: 401, level: 6, heroKey: 'bristleback', abilities: abil(1) }, { mem, now: T0 + 1000 })) as { id: string }[];
    expect(out.map((h) => h.id)).not.toContain('laning.level6');
  });
  it('руны по роли в лайнинге: силы — центру и четвёрке, богатство — саппортам и центру; первая — всем', () => {
    expect(runeForMe('rune-power', 360, { stage: 'laning', position: 1 })).toBe(false);
    expect(runeForMe('rune-power', 360, { stage: 'laning', position: 2 })).toBe(true);
    expect(runeForMe('rune-bounty', 180, { stage: 'laning', position: 3 })).toBe(false);
    expect(runeForMe('rune-bounty', 180, { stage: 'laning', position: 5 })).toBe(true);
    expect(runeForMe('rune-bounty', 0, { stage: 'laning', position: 1 })).toBe(true);
    expect(runeForMe('rune-power', 1200, { stage: 'mid', position: 1 })).toBe(true);
    expect(runeForMe('rune-power', 360, { stage: 'laning', position: null })).toBe(true);
  });
  it('в лайнинге «трое пропали» — не смок', () => {
    const c = ctxOf({ clock: 200, level: 3 }) as { ev: { smoke: number[] | null } };
    c.ev.smoke = [5, 6, 7];
    expect(smokeRule(c as never)).toBeNull();
    const late = ctxOf({ clock: 1500, level: 16 }) as { ev: { smoke: number[] | null } };
    late.ev.smoke = [5, 6, 7];
    expect(smokeRule(late as never)).not.toBeNull();
  });
  it('контекст считается один раз и доступен правилам через game(c)', () => {
    const c = ctxOf({ clock: 200, level: 5 }, { turbo: true });
    expect(game(c).stage).toBe('laning');
    expect(game(c)).toBe(game(c));
  });
});
