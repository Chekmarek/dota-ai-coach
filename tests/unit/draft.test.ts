// Драфт: подбор героя по врагам и союзникам, угрозы врагов и предметы против них, подсказки в матче.
import { describe, expect, it } from 'vitest';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { buildView } from '../../src/core/coach/view.ts';
import { defaultCoachSettings } from '../../src/core/coach/types.ts';
import type { RuleContext } from '../../src/core/coach/rules/context.ts';
import { DRAFT_RULES } from '../../src/core/coach/rules/draft.ts';
import { TIMING_RULES } from '../../src/core/coach/rules/timings.ts';
import { counterItems, enemyThreats, itemRole, suggestHeroes, worstMatchups } from '../../src/core/draft/index.ts';
import { DraftService } from '../../src/main/coach/draft.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const data = realData();

/** Маленькая база: 4 героя, статистика задана руками */
function tiny(): CoachLookup {
  const hero = (id: number, key: string, roles: string[]) => ({ id, key, name: key.toUpperCase(), roles, abilities: [], talents: [] }) as never;
  const st = (id: number, key: string, wr: number, matchups: Record<string, [number, number]>, synergy: Record<string, [number, number]> = {}) => ({
    id,
    key,
    pub: { games: 100_000, winrate: wr },
    matchups,
    synergy,
    pro: null,
    popular: null,
    bench: null,
  });
  const d: CoachData = {
    patch: 'x',
    heroes: [hero(1, 'aaa', ['Carry']), hero(2, 'bbb', ['Support']), hero(3, 'ccc', ['Carry']), hero(4, 'enemy', ['Nuker'])],
    items: [],
    mechanics: [],
    stats: {
      schema: 'dota-coach.kb-stats',
      version: 1,
      patch: 'x',
      patchStart: '',
      generatedAt: '',
      verification: 'imported-unverified',
      heroes: [
        // aaa сильно контрит enemy, ccc — проигрывает ему; bbb хорош в паре с aaa
        st(1, 'aaa', 0.5, { 4: [20_000, 0.56] }, { 2: [20_000, 0.55] }),
        st(2, 'bbb', 0.5, { 4: [20_000, 0.5] }, { 1: [20_000, 0.55] }),
        st(3, 'ccc', 0.5, { 4: [20_000, 0.44] }),
        st(4, 'enemy', 0.5, {}),
      ],
    } as never,
    kbVerified: false,
  };
  return new CoachLookup(d);
}

describe('подбор героя', () => {
  it('контрпик врага — первым, проигрывающий матчап — последним', () => {
    const r = suggestHeroes(tiny(), { allies: [], enemies: ['enemy'] });
    expect(r[0]!.hero).toBe('aaa');
    expect(r[0]!.score).toBeGreaterThan(0.05);
    expect(r[r.length - 1]!.hero).toBe('ccc');
    expect(r.map((c) => c.hero)).not.toContain('enemy');
  });

  it('связка с союзником добавляет очки; баны не предлагаются', () => {
    const r = suggestHeroes(tiny(), { allies: ['aaa'], enemies: [], bans: ['ccc'] });
    expect(r[0]!.hero).toBe('bbb');
    expect(r[0]!.withAllies[0]!.hero).toBe('aaa');
    expect(r.map((c) => c.hero)).not.toContain('ccc');
  });

  it('позиция по ролям базы, когда профи героя не берут', () => {
    const r = suggestHeroes(tiny(), { allies: [], enemies: ['enemy'], position: 5 });
    expect(r.map((c) => c.hero)).toEqual(['bbb']);
  });

  it('слабые матчапы моего героя', () => {
    expect(worstMatchups(tiny(), 'ccc', ['enemy'])[0]!.hero).toBe('enemy');
    expect(worstMatchups(tiny(), 'aaa', ['enemy'])).toEqual([]);
  });

  it('настоящая статистика патча: 12 кандидатов без врагов и союзников в списке', () => {
    const look = new CoachLookup(data);
    const r = suggestHeroes(look, { allies: ['crystal_maiden'], enemies: ['riki', 'phantom_assassin'], limit: 12 });
    expect(r).toHaveLength(12);
    for (const c of r) expect(['crystal_maiden', 'riki', 'phantom_assassin']).not.toContain(c.hero);
    // оценка — проценты в разумных пределах
    for (const c of r) expect(Math.abs(c.score)).toBeLessThan(0.3);
  });
});

describe('угрозы и предметы', () => {
  it('Рики: невидимость срочно — пыль; саппорту — сентри не раньше пыли', () => {
    const look = new CoachLookup(data);
    const t = enemyThreats(['riki', 'lion'], look.invisHeroes);
    expect(t[0]!.threat.id).toBe('invis');
    expect(counterItems(t, 'support')[0]!.key).toBe('dust');
    expect(counterItems(t, 'core').map((c) => c.key)).toContain('black_king_bar');
  });

  it('купленное не советуем; роль по позициям', () => {
    const t = enemyThreats(['phantom_lancer']);
    expect(counterItems(t, 'core', new Set(['bfury']))[0]!.key).toBe('mjollnir');
    expect(itemRole([0, 0, 0.1, 0.5, 0.4], [])).toBe('support');
    expect(itemRole(null, ['Carry', 'Support'])).toBe('core');
  });

  it('все предметы таблицы есть в базе знаний', () => {
    const look = new CoachLookup(data);
    const all = enemyThreats(['riki', 'phantom_lancer', 'necrolyte', 'phantom_assassin', 'lion', 'bane', 'ursa', 'broodmother', 'bristleback', 'antimage']);
    expect(all.length).toBe(10);
    for (const r of all) for (const i of r.threat.items) expect(look.itemByKey.has(i.key), i.key).toBe(true);
  });
});

describe('страница «Драфт» в main', () => {
  const kb = () => ({ meta: { patch: '7.41f', verification: 'imported-unverified' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics }) as never;
  const svc = new DraftService({ get: kb, stats: () => data.stats });

  it('без моего героя — кандидаты и угрозы', () => {
    const r = svc.suggest({ allies: [], enemies: ['riki'], bans: [], position: null, me: null });
    expect(r.error).toBeNull();
    expect(r.candidates.length).toBeGreaterThan(0);
    expect(r.threats[0]!.id).toBe('invis');
    expect(r.threats[0]!.items[0]!.name).toBeTruthy();
  });

  it('с моим героем — матчапы и предметы под роль', () => {
    const r = svc.suggest({ allies: [], enemies: ['riki', 'lion'], bans: [], position: null, me: 'crystal_maiden' });
    expect(r.candidates).toEqual([]);
    expect(r.me?.role).toBe('support');
  });

  it('без статистики — честная ошибка', () => {
    const r = new DraftService({ get: kb, stats: () => null }).suggest({ allies: [], enemies: [], bans: [], position: null, me: null });
    expect(r.error).toMatch(/статистики/);
  });
});

function ctx(i: Partial<SimInput>, prep?: (mem: CoachMemory) => void): RuleContext {
  const s = sim({ wallMs: 1_000_000, clock: 900, ...i });
  const v = buildView(s.state, s.gsi, 1_000_000);
  const mem = new CoachMemory();
  prep?.(mem);
  const ev = mem.ingest(v, 1800);
  return { v, mem, ev, look: new CoachLookup(data), settings: defaultCoachSettings(), now: 1_000_000 };
}
const run = (rules: typeof DRAFT_RULES, c: RuleContext) => rules.flatMap((r) => [r(c)].flat().filter((x) => x !== null));

describe('подсказки драфта в матче', () => {
  const enemies = [5, 6, 7].map((slot, i) => ({ slot, hero: ['riki', 'lion', 'phantom_assassin'][i]! }));

  it('начало матча: обзор угроз один раз', () => {
    const c = ctx({ clock: 30, enemies });
    const first = run(DRAFT_RULES, c).map((d) => d!.id);
    expect(first).toContain('draft.overview');
    expect(run(DRAFT_RULES, c).map((d) => d!.id)).not.toContain('draft.overview');
  });

  it('пыль против Рики, когда хватает золота; без врагов — молчит', () => {
    const ids = run(DRAFT_RULES, ctx({ clock: 120, gold: 500, enemies })).map((d) => d!.id);
    expect(ids).toContain('draft.item:dust');
    expect(run(DRAFT_RULES, ctx({ clock: 120, gold: 500 })).map((d) => d!.id)).not.toContain('draft.item:dust');
  });
});

describe('тайминги', () => {
  it('лотос за 15 с до появления', () => {
    const ids = run(TIMING_RULES, ctx({ clock: 170 })).map((d) => d!.id);
    expect(ids).toContain('timing.lotus');
  });

  it('нейтральные 2-го уровня в 15:00, один раз', () => {
    const c = ctx({ clock: 905 });
    expect(run(TIMING_RULES, c).map((d) => d!.id)).toContain('timing.neutral-tier:2');
    expect(run(TIMING_RULES, c).map((d) => d!.id)).not.toContain('timing.neutral-tier:2');
  });

  it('наш Аегис кончается — предупреждение за 30 с', () => {
    const c = ctx({ clock: 1000 }, (m) => {
      m.aegisAt = 720;
      m.aegisOurs = true;
    });
    expect(run(TIMING_RULES, c).map((d) => d!.id)).toContain('timing.aegis-end');
  });
});
