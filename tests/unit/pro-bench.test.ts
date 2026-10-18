// Этап 3 «понимания игры»: сравнение с сильными игроками на этом герое (кривые профи OpenDota по минутам)
// и предметы из сборки профи с поправкой на врагов. Данные кривых — заданы в тесте (не зависят от импорта).
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseStatsRanked } from '../../src/shared/types/stats-ranked.ts';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { defaultCoachSettings } from '../../src/core/coach/index.ts';
import { benchRule } from '../../src/core/coach/rules/laning.ts';
import { nextItem } from '../../src/core/coach/rules/economy.ts';
import { counterItemRule } from '../../src/core/coach/rules/draft.ts';
import type { GameModeInfo } from '../../src/core/gsi/mode.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const T0 = 1_000_000;
const TURBO: GameModeInfo = { mode: 'turbo', source: 'clock', raw: 'start -1:00' };

/** Данные с кривой профи для Anti-Mage: позиция 1 — 20 игроков, к 10:00 медиана 60 добиваний, 4800 золота */
function dataWithCurve(): CoachData {
  const d = structuredClone(realData());
  const am = d.stats!.heroes.find((h) => h.key === 'antimage')!;
  am.pro = {
    ...(am.pro ?? { games: 50, winrate: 0.5, build: [], startItems: [], skills: [], lhAt10: {} }),
    positions: [0.85, 0.15, 0, 0, 0],
    curves: {
      '1': { n: 20, at: { '5': [25, 32, 2000, 2300, 1800, 2100], '10': [60, 72, 4800, 5600, 5200, 6000], '15': [110, 130, 9000, 10500, 10000, 11500] } },
      all: { n: 24, at: { '5': [24, 31, 1950, 2250, 1780, 2080], '10': [58, 70, 4700, 5500, 5100, 5900] } },
    },
  };
  return d;
}

function ctxOf(data: CoachData, i: Partial<SimInput>, opts: { turbo?: boolean; position?: '1' | '5' } = {}) {
  const s = sim({ wallMs: T0, clock: 600, heroKey: 'antimage', ...i });
  const v = buildView(s.state, s.gsi, T0);
  const mem = new CoachMemory();
  const look = new CoachLookup(data);
  if (opts.turbo) look.setMode(TURBO);
  return { v, mem, ev: mem.ingest(v, 1800), look, settings: { ...defaultCoachSettings(), position: opts.position ?? '1' }, now: T0 } as never;
}

describe('кривые профи', () => {
  const look = new CoachLookup(dataWithCurve());
  it('точка на минуте и между минутами (линейно); позиция 1 — своя кривая', () => {
    expect(look.proAt('antimage', 1, 10)).toMatchObject({ lh50: 60, gold50: 4800, position: 1 });
    expect(look.proAt('antimage', 1, 7.5)).toMatchObject({ lh50: 43, lh75: 52 });
  });
  it('позиции нет в данных — кривая по всем позициям героя (если роль та же); вне кривой — null', () => {
    expect(look.proAt('antimage', 2, 10)).toMatchObject({ lh50: 58, position: null });
    // Anti-Mage почти всегда кор: «все позиции» — не ориентир для пятёрки
    expect(look.proAt('antimage', 5, 10)).toBeNull();
    expect(look.proAt('antimage', 1, 45)).toBeNull();
    expect(look.proAt('antimage', 1, 3)).toBeNull();
  });
  it('в Турбо норм профи нет — null', () => {
    const t = new CoachLookup(dataWithCurve());
    t.setMode(TURBO);
    expect(t.proAt('antimage', 1, 10)).toBeNull();
  });
});

describe('сравнение «у вас / у профи»', () => {
  const data = dataWithCurve();
  it('38 добиваний к 10:00, у профи ~60 → «Добивания 38 к 10:00, у профи ~60»', () => {
    const h = benchRule(ctxOf(data, { clock: 605, lastHits: 38, gpm: 480, xpm: 520 })) as { short: string } | null;
    expect(h?.short).toBe('Добивания 38 к 10:00, у профи ~60');
    expect((h as unknown as { detail: { normal: string } }).detail.normal).toContain('у профи на Anti-Mage (позиция 1) обычно ~60');
  });
  it('фарм лучше верхней четверти профи — похвала', () => {
    const h = benchRule(ctxOf(data, { clock: 605, lastHits: 80, gpm: 600, xpm: 620 })) as { short: string } | null;
    expect(h?.short).toBe('Отличный фарм: 80 добиваний к 10:00');
  });
  it('около медианы — молчит; не на минуте сравнения — молчит; в Турбо — молчит', () => {
    expect(benchRule(ctxOf(data, { clock: 605, lastHits: 58, gpm: 470, xpm: 510 }))).toBeNull();
    expect(benchRule(ctxOf(data, { clock: 480, lastHits: 10, gpm: 200, xpm: 200 }))).toBeNull();
    expect(benchRule(ctxOf(data, { clock: 605, lastHits: 10, gpm: 200, xpm: 200 }, { turbo: true }))).toBeNull();
  });
  it('саппорту добивания не в упрёк — сравнивается золото и опыт (с кривой саппортов)', () => {
    const d = dataWithCurve();
    d.stats!.heroes.find((h) => h.key === 'antimage')!.pro!.curves['5'] = { n: 14, at: { '10': [3, 6, 1800, 2000, 2000, 2300] } };
    const h = benchRule(ctxOf(d, { clock: 605, lastHits: 5, gpm: 180, xpm: 120 }, { position: '5' })) as { short: string } | null;
    expect(h?.short.startsWith('Опыт')).toBe(true);
  });
  it('настоящая статистика: Ogre Magi пятёркой — не сравнивается с «все позиции» (там и центр)', () => {
    const look = new CoachLookup(realData());
    const og = look.proAt('ogre_magi', 5, 10);
    expect(og === null || og.position === 5).toBe(true);
  });
});

describe('сильные игроки рейтинга (STRATZ, stats-ranked.json)', () => {
  const ranked = parseStatsRanked(JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/data/kb/7.41f/stats-ranked.json'), 'utf8')), '7.41f');
  const withRanked = (): CoachData => ({ ...dataWithCurve(), statsRanked: ranked });
  it('файл читается: все герои, у Anti-Mage позиции 1 — кривая и сборка', () => {
    expect(ranked?.heroes.length).toBeGreaterThan(120);
    const look = new CoachLookup(withRanked());
    const r = look.rankedAt('antimage', 1, 10)!;
    expect(r.position).toBe(1);
    expect(r.lh).toBeGreaterThan(25);
    expect(r.lh).toBeLessThan(80);
    expect(look.rankedBuild('antimage', 1).map((b) => b.key)).toContain('bfury');
  });
  it('своя позиция обязательна: позиция не известна или Турбо — нет ориентира рейтинга', () => {
    const look = new CoachLookup(withRanked());
    expect(look.rankedAt('antimage', null, 10)).toBeNull();
    look.setMode(TURBO);
    expect(look.rankedAt('antimage', 1, 10)).toBeNull();
  });
  it('сравнение — с сильными игроками рейтинга, если есть данные: «Добивания 15 к 10:00, у сильных игроков ~N»', () => {
    const h = benchRule(ctxOf(withRanked(), { clock: 605, lastHits: 15, gpm: 450, xpm: 500 })) as { short: string; detail: { normal: string } } | null;
    expect(h?.short).toMatch(/^Добивания 15 к 10:00, у сильных игроков ~\d+$/);
    expect(h?.detail.normal).toContain('на Anti-Mage (позиция 1)');
  });
  it('«Дальше» — по сборке сильных игроков рейтинга на позиции', () => {
    const n = nextItem(ctxOf(withRanked(), { clock: 500, items: [{ slot: 'inv0', key: 'power_treads' }, { slot: 'inv1', key: 'magic_wand' }], enemies: [{ slot: 5, hero: 'lina' }] }) as never);
    expect(n?.source).toBe('ranked');
    expect(n?.key).toBe('bfury');
  });
});

describe('предметы: сборка профи с поправкой на врагов', () => {
  /** Сборка: Power Treads → Battle Fury → Manta → Mjollnir → Abyssal */
  function dataWithBuild(): CoachData {
    const d = dataWithCurve();
    const am = d.stats!.heroes.find((h) => h.key === 'antimage')!;
    am.pro!.games = 60;
    am.pro!.build = [
      { key: 'power_treads', share: 0.8, medianMin: 9 },
      { key: 'bfury', share: 0.9, medianMin: 14 },
      { key: 'manta', share: 0.8, medianMin: 20 },
      { key: 'mjollnir', share: 0.25, medianMin: 26 },
      { key: 'abyssal_blade', share: 0.6, medianMin: 32 },
    ];
    return d;
  }
  const bought = [{ slot: 'inv0', key: 'power_treads' }, { slot: 'inv1', key: 'bfury' }];
  it('врагов без иллюзий — следующий по сборке (Manta Style)', () => {
    expect(nextItem(ctxOf(dataWithBuild(), { clock: 1000, items: bought, enemies: [{ slot: 5, hero: 'lina' }] }) as never)?.key).toBe('manta');
  });
  it('у врага Phantom Lancer (иллюзии) — Mjollnir из сборки профи вперёд, с объяснением', () => {
    const n = nextItem(ctxOf(dataWithBuild(), { clock: 1000, items: bought, enemies: [{ slot: 5, hero: 'phantom_lancer' }] }) as never);
    expect(n?.key).toBe('mjollnir');
    expect(n?.vs?.heroes).toEqual(['phantom_lancer']);
  });
  it('предмет против угрозы, которого профи на герое не собирают (Radiance), — не советуется', () => {
    const d = dataWithBuild();
    const c = ctxOf(d, { clock: 1000, gold: 6000, items: bought, enemies: [{ slot: 5, hero: 'phantom_lancer' }, { slot: 6, hero: 'lina' }, { slot: 7, hero: 'axe' }] });
    const h = counterItemRule(c) as { id: string } | null;
    expect(h?.id ?? null).not.toBe('draft.item:radiance');
  });
});
