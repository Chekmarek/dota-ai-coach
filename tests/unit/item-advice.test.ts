// Советы по предметам 0.16.1: выкуп, ответ на увиденный предмет врага, умная продажа, «запаздывает» в Турбо по
// реальным матчам Турбо, тишина о покупках в драке и при высоком риске смерти. Данные — src/data/item-timings.json.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { goldRule, itemTimingRule, nextItem, sellRule } from '../../src/core/coach/rules/economy.ts';
import { counterItemRule, enemyItemRule } from '../../src/core/coach/rules/draft.ts';
import { HintQueue } from '../../src/core/coach/queue.ts';
import { parseItemTimings, timedBuild } from '../../src/core/coach/item-timings.ts';
import { ENEMY_ITEM_ANSWERS } from '../../src/core/draft/index.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import { parseStatsRanked } from '../../src/shared/types/stats-ranked.ts';
import type { HintDraft } from '../../src/core/coach/types.ts';
import type { GameModeInfo } from '../../src/core/gsi/mode.ts';
import type { HudReading } from '../../src/core/vision/recognize-hud.ts';
import type { Observed } from '../../src/shared/types/observation.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const ROOT = join(import.meta.dirname, '../..');
const T0 = 1_000_000;
const TURBO: GameModeInfo = { mode: 'turbo', source: 'clock', raw: 'start -1:00' };
const ranked = parseStatsRanked(JSON.parse(readFileSync(join(ROOT, 'resources/data/kb/7.41f/stats-ranked.json'), 'utf8')), '7.41f');
const timings = parseItemTimings(JSON.parse(readFileSync(join(ROOT, 'src/data/item-timings.json'), 'utf8')));
const data: CoachData = { ...realData(), statsRanked: ranked, itemTimings: timings };
const noTimings: CoachData = { ...realData(), statsRanked: ranked, itemTimings: null };

type Pos = '1' | '2' | '3' | '4' | '5';
function ctxOf(i: Partial<SimInput>, opts: { turbo?: boolean; position?: Pos; data?: CoachData; mem?: CoachMemory; prep?: (v: ReturnType<typeof buildView>, mem: CoachMemory) => void } = {}) {
  const s = sim({ wallMs: T0, clock: 600, ...i });
  const v = buildView(s.state, s.gsi, T0);
  const mem = opts.mem ?? new CoachMemory();
  const look = new CoachLookup(opts.data ?? data);
  if (opts.turbo) look.setMode(TURBO);
  const ev = mem.ingest(v, 1800);
  opts.prep?.(v, mem);
  return { v, mem, ev, look, settings: { ...defaultCoachSettings(), position: opts.position ?? 'auto' }, now: T0 } as never;
}
const shortOf = (h: unknown) => (h as HintDraft | null)?.short ?? null;
const normalOf = (h: unknown) => (h as HintDraft | null)?.detail.normal ?? null;

describe('данные таймингов (item-timings.json)', () => {
  it('файл разбирается; сборки Турбо есть, у Magic Wand — минута ухода из инвентаря', () => {
    expect(timings).not.toBeNull();
    expect(timings!.turbo!.matches).toBeGreaterThan(500);
    expect(timedBuild(timings!.turbo, 'antimage', '1')?.items.some((x) => x.key === 'bfury')).toBe(true);
    expect(timings!.normal!.leaves['magic_wand']!.p50).toBeGreaterThan(30);
  });
  it('чужой или испорченный файл — null (советы как раньше), неверный раздел режима — пустой', () => {
    expect(parseItemTimings({ schema: 'x' })).toBeNull();
    expect(parseItemTimings({ schema: 'dota-coach.item-timings', version: 1, patch: '7.41f', generatedAt: 'x', normal: 5, turbo: null })?.normal).toBeNull();
  });
});

describe('1. сборка от положения в матче', () => {
  it('проигрываем по счёту — без надёжных ситуативных данных сборка не выдумывается (та же, что при перевесе)', () => {
    // Проверено на 1337 матчах (scripts/build-item-timings.mjs): «ветки выживания» данные не показывают — сборка остаётся
    const items = [{ slot: 'inv0', key: 'power_treads' }];
    const behind = nextItem(ctxOf({ heroKey: 'antimage', heroId: 1, clock: 1500, scoreRadiant: 5, scoreDire: 20, items }, { position: '1' }));
    const ahead = nextItem(ctxOf({ heroKey: 'antimage', heroId: 1, clock: 1500, scoreRadiant: 20, scoreDire: 5, items }, { position: '1' }));
    expect(behind?.key).toBe(ahead?.key);
  });
  it('предмет против угрозы врагов — с долей матчей и долей побед сильных игроков на вашей позиции', () => {
    const h = counterItemRule(
      ctxOf(
        {
          heroKey: 'antimage',
          heroId: 1,
          clock: 1500,
          gold: 6000,
          items: [{ slot: 'inv0', key: 'power_treads' }, { slot: 'inv1', key: 'bfury' }, { slot: 'inv2', key: 'manta' }],
          enemies: [{ slot: 5, hero: 'lina' }, { slot: 6, hero: 'zuus' }, { slot: 7, hero: 'lion' }],
        },
        { position: '1' },
      ),
    );
    expect(normalOf(h)).toMatch(/в \d+% матчей, доля побед купивших \d+%/);
  });
});

describe('2. ответ на предмет врага, который коуч увидел', () => {
  const seen = (key: string, ageSec = 10) => (v: ReturnType<typeof buildView>) => {
    v.enemyItems = [{ heroId: 25, key, ageSec }];
  };
  const amItems = [{ slot: 'inv0', key: 'power_treads' }, { slot: 'inv1', key: 'bfury' }, { slot: 'inv2', key: 'manta' }];
  it('у врага увиден BKB → Abyssal Blade, если его собирают на моём герое (Anti-Mage, позиция 1)', () => {
    const h = enemyItemRule(ctxOf({ heroKey: 'antimage', heroId: 1, clock: 1800, gold: 3000, items: amItems }, { position: '1', prep: seen('black_king_bar') }));
    expect(shortOf(h)).toBe('У Lina Black King Bar — ответ: Abyssal Blade');
    expect(normalOf(h)).toMatch(/в \d+% матчей/);
  });
  it('саппорту Abyssal Blade не советуется (нет в его сборке и не его роль)', () => {
    const h = enemyItemRule(ctxOf({ heroKey: 'crystal_maiden', heroId: 5, clock: 1800, gold: 3000, items: [{ slot: 'inv0', key: 'tranquil_boots' }] }, { position: '5', prep: seen('black_king_bar') }));
    expect(h).toBeNull();
  });
  it('давно увиденный предмет (больше 3 минут) — не повод для совета', () => {
    expect(enemyItemRule(ctxOf({ heroKey: 'antimage', heroId: 1, clock: 1800, items: amItems }, { position: '1', prep: seen('black_king_bar', 400) }))).toBeNull();
  });
  it('ответ уже куплен — молчим', () => {
    expect(enemyItemRule(ctxOf({ heroKey: 'antimage', heroId: 1, clock: 1800, items: [...amItems, { slot: 'inv3', key: 'abyssal_blade' }] }, { position: '1', prep: seen('black_king_bar') }))).toBeNull();
  });
  it('все предметы таблицы ответов есть в базе знаний патча', () => {
    const keys = new Set(realData().items.map((i) => i.key));
    for (const [enemy, a] of Object.entries(ENEMY_ITEM_ANSWERS)) {
      expect(keys.has(enemy)).toBe(true);
      for (const it of a.items) expect(keys.has(it.key)).toBe(true);
    }
  });

  // Модель матча: предметы врага с его панели — после двух уверенных чтений за 10 с
  const obs = <T,>(value: T | null, confidence = 0.95): Observed<T> => ({
    value,
    confidence: value === null ? 0 : confidence,
    observedAt: 0,
    sourceRegion: { layoutId: 't', regionId: 't', rect: { x: 0, y: 0, w: 0, h: 0 }, frameSize: { w: 1920, h: 1080 } },
    validity: value === null ? 'absent' : 'valid',
    schemaVersion: '1',
    raw: '',
  });
  const enemyPanel = (key: string, confidence = 0.95): HudReading => ({
    layoutId: 't',
    frameSize: { w: 1920, h: 1080 },
    supported: true,
    fields: { gameClock: obs(900), scoreRadiant: obs<never>(null), scoreDire: obs<never>(null), gold: obs<never>(null), health: obs<never>(null), mana: obs<never>(null), level: obs<never>(null), kda: obs<never>(null), farm: obs<never>(null) },
    selectedUnit: obs('enemy' as const),
    heroName: obs({ id: 44, name: 'Phantom Assassin' }, 0.9),
    dayNight: obs<never>(null),
    abilities: null,
    items: [{ slot: 'inv1', item: { key, name: key }, empty: false, distance: 0.1, confidence }],
    heroNameCandidates: [],
    durationMs: 0,
  });
  it('модель матча: два уверенных чтения панели врага → предмет запомнен; одно или неуверенное — нет', () => {
    const m = new MatchStateModel();
    m.ingest(enemyPanel('butterfly'), 1000);
    expect(m.snapshot(1000).enemyItems ?? []).toEqual([]);
    m.ingest(enemyPanel('butterfly'), 1500);
    expect(m.snapshot(1500).enemyItems).toEqual([{ heroId: 44, items: [{ key: 'butterfly', firstWallMs: 1500, lastWallMs: 1500, clock: expect.any(Number) }] }]);
    const low = new MatchStateModel();
    low.ingest(enemyPanel('butterfly', 0.6), 1000);
    low.ingest(enemyPanel('butterfly', 0.6), 1500);
    expect(low.snapshot(1500).enemyItems ?? []).toEqual([]);
  });
});

describe('3. «не трать на выкуп»', () => {
  const late = { heroKey: 'antimage', heroId: 1, clock: 2700, level: 25, buybackCost: 3000, items: [{ slot: 'inv0', key: 'power_treads' }, { slot: 'inv1', key: 'bfury' }, { slot: 'inv2', key: 'manta' }] };
  const goldHigh = (_v: unknown, mem: CoachMemory) => {
    mem.goldHighSince = 2600;
  };
  it('поздняя игра, покупка оставит золото меньше выкупа → предупреждение, а не «купите»', () => {
    const h = goldRule(ctxOf({ ...late, gold: 5000 }, { position: '1', prep: goldHigh }));
    expect((h as HintDraft).id).toBe('economy.buyback');
    expect(normalOf(h)).toMatch(/останется \d+, а выкуп 3000/);
  });
  it('выкуп на перезарядке или середина игры — обычный совет', () => {
    expect((goldRule(ctxOf({ ...late, gold: 5000, buybackCooldown: 200 }, { position: '1', prep: goldHigh })) as HintDraft).id).toBe('economy.gold');
    expect((goldRule(ctxOf({ ...late, clock: 1200, level: 15, gold: 5000 }, { position: '1', prep: (_v, mem) => (mem.goldHighSince = 1100) })) as HintDraft).id).toBe('economy.gold');
  });
  it('после покупки золота меньше выкупа → одно предупреждение; вторая покупка через минуту — без повтора', () => {
    let now = T0;
    const e = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), position: '1' } });
    const said: string[] = [];
    const tick = (t: number, gold: number, extra: { slot: string; key: string }[]) => {
      now = T0 + t * 1000;
      const s = sim({ ...late, wallMs: now, clock: 2700 + t, gold, items: [...late.items, ...extra] });
      said.push(...e.tick(s.state, s.gsi, now).shown.map((h) => h.id));
    };
    for (let t = 0; t < 5; t++) tick(t, 6000, []);
    tick(5, 1800, [{ slot: 'inv3', key: 'butterfly' }]);
    for (let t = 6; t < 70; t++) tick(t, 1800 + t, [{ slot: 'inv3', key: 'butterfly' }]);
    tick(70, 3500, [{ slot: 'inv3', key: 'butterfly' }]);
    tick(71, 1000, [{ slot: 'inv3', key: 'butterfly' }, { slot: 'inv4', key: 'basher' }]);
    expect(said.filter((id) => id === 'economy.buyback')).toHaveLength(1);
  });
});

describe('4. лишние предметы', () => {
  const full = (extra: { slot: string; key: string }[]) => [
    { slot: 'inv0', key: 'arcane_boots' },
    { slot: 'inv1', key: 'glimmer_cape' },
    { slot: 'inv2', key: 'force_staff' },
    { slot: 'inv3', key: 'blink' },
    ...extra,
  ];
  it('продать Magic Wand, когда он — компонент следующего предмета (Holy Locket у Dazzle) → не советуется', () => {
    const h = sellRule(ctxOf({ heroKey: 'dazzle', heroId: 50, clock: 3000, items: full([{ slot: 'inv4', key: 'magic_wand' }]) }, { position: '5' }));
    expect(h === null || !/Magic Wand/.test(shortOf(h) ?? '')).toBe(true);
  });
  it('Holy Locket уже есть → Magic Wand к 50-й минуте лишний, причина — минута сильных игроков', () => {
    const h = sellRule(ctxOf({ heroKey: 'dazzle', heroId: 50, clock: 3000, items: full([{ slot: 'inv4', key: 'magic_wand' }, { slot: 'inv5', key: 'holy_locket' }]) }, { position: '5' }));
    expect(shortOf(h)).toMatch(/Magic Wand/);
    expect(normalOf(h)).toMatch(/обычно убирают Magic Wand к \d+-й минуте/);
  });
  it('рюкзак: устаревший Bracer там — совет продать даже при неполном инвентаре', () => {
    const h = sellRule(ctxOf({ heroKey: 'axe', heroId: 2, clock: 2700, items: [{ slot: 'inv0', key: 'blink' }, { slot: 'bp1', key: 'bracer' }] }, { position: '3' }));
    expect(shortOf(h)).toBe('В рюкзаке лишнее: Bracer — продайте');
  });
  it('4 предмета: Bracer сильно устарел по данным (на 10+ минут позже обычного) → советуем; чуть позже обычного — нет', () => {
    const four = (clock: number) => sellRule(ctxOf({ heroKey: 'axe', heroId: 2, clock, items: [{ slot: 'inv0', key: 'blink' }, { slot: 'inv1', key: 'blade_mail' }, { slot: 'inv2', key: 'phase_boots' }, { slot: 'inv3', key: 'bracer' }] }, { position: '3' }));
    expect(shortOf(four(2820))).toMatch(/Bracer/);
    expect(four(2220)).toBeNull();
  });
});

describe('5. Турбо: «запаздывает» только по реальным матчам Турбо', () => {
  const am = { heroKey: 'antimage', heroId: 1, clock: 720, items: [{ slot: 'inv0', key: 'power_treads' }, { slot: 'inv1', key: 'pers' }] };
  it('Турбо без данных → нет «запаздывает»', () => {
    expect(itemTimingRule(ctxOf(am, { turbo: true, position: '1', data: noTimings }))).toBeNull();
  });
  it('Турбо с данными: Battle Fury к 12:00 нет, а в 8 из 10 матчей Турбо она уже есть → «запаздывает» с минутами Турбо', () => {
    const h = itemTimingRule(ctxOf(am, { turbo: true, position: '1' }));
    expect(shortOf(h)).toBe('Battle Fury запаздывает');
    expect(normalOf(h)).toMatch(/В Турбо на этой позиции Battle Fury берут к \d+ мин, в 8 из 10 матчей — к \d+/);
  });
  it('при высоком риске смерти «запаздывает» ждёт и не тратит разовый показ: риск прошёл — совет звучит', () => {
    const mem = new CoachMemory();
    const risky = ctxOf(am, { turbo: true, position: '1', mem }) as { highRisk?: boolean };
    risky.highRisk = true;
    expect(itemTimingRule(risky as never)).toBeNull();
    expect(shortOf(itemTimingRule(ctxOf(am, { turbo: true, position: '1', mem })))).toBe('Battle Fury запаздывает');
  });
  it('раньше 8 из 10 матчей Турбо — молчим (не «минуты обычной игры пополам»)', () => {
    expect(itemTimingRule(ctxOf({ ...am, clock: 480 }, { turbo: true, position: '1' }))).toBeNull();
  });
});

describe('6. в драке и при высоком риске смерти — ни слова о покупках', () => {
  const S = defaultCoachSettings();
  const d = (id: string, category: HintDraft['category'], priority: HintDraft['priority'] = 'info', short = id): HintDraft => ({
    id,
    ruleId: id,
    category,
    priority,
    confidence: 0.9,
    short,
    detail: { normal: short, detailed: short },
    facts: [],
    ttlMs: 10_000,
    cooldownMs: 0,
  }) as unknown as HintDraft;
  it('в драке → советы о покупках не показываются', () => {
    const q = new HintQueue();
    const r = q.push(d('economy.next', 'economy'), { now: T0, clock: 900, inFight: true, settings: S });
    expect(r.status).toBe('dropped');
  });
  it('на экране «Высокий риск смерти» → «Дальше: …» ждёт, а «Нет Town Portal Scroll» показывается', () => {
    const q = new HintQueue();
    q.push(d('danger.model', 'danger', 'critical', 'Высокий риск смерти — отходите'), { now: T0, clock: 900, inFight: false, settings: S });
    expect(q.push(d('economy.next', 'economy'), { now: T0 + 100, clock: 900, inFight: false, settings: S }).status).toBe('dropped');
    expect(q.push(d('economy.tp', 'economy', 'advice'), { now: T0 + 200, clock: 900, inFight: false, settings: S }).status).not.toBe('dropped');
  });
});
