// Сборка от положения в матче (DECISIONS.md п. 79): положение по счёту убийств, устойчивость, строгий отбор с поправкой
// и подтверждение на отложенных матчах; «запаздывает» в Турбо — только для пар с ≥ 40 матчами.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { defaultCoachSettings } from '../../src/core/coach/index.ts';
import { itemTimingRule, nextItem, situationTrackRule } from '../../src/core/coach/rules/economy.ts';
import { killSituation, parseItemSituations, type ItemSituations } from '../../src/core/coach/item-situation.ts';
import { parseItemTimings } from '../../src/core/coach/item-timings.ts';
import { parseStatsRanked } from '../../src/shared/types/stats-ranked.ts';
import type { GameModeInfo } from '../../src/core/gsi/mode.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';
// @ts-expect-error — .mjs без типов (скрипт разработчика)
import { bhSelect, confirmOnHoldout, z2 } from '../../scripts/items-data-lib.mjs';

const ROOT = join(import.meta.dirname, '../..');
const T0 = 1_000_000;
const ranked = parseStatsRanked(JSON.parse(readFileSync(join(ROOT, 'resources/data/kb/7.41f/stats-ranked.json'), 'utf8')), '7.41f');
/** Синтетическая подтверждённая находка: Anti-Mage, позиция 1, при отставании — Black King Bar */
const sitData: ItemSituations = parseItemSituations({
  schema: 'dota-coach.item-situations',
  version: 1,
  generatedAt: 'x',
  refMin: 15,
  windowMin: 20,
  items: { antimage: { '1': [{ key: 'black_king_bar', sit: 'behind', share: 0.42, other: 0.21, n: 120, nOther: 130, holdout: { share: 0.4, other: 0.22, n: 50, nOther: 55 }, measure: 'games' }] } },
})!;
const data: CoachData = { ...realData(), statsRanked: ranked, itemSituations: sitData };
const items = [{ slot: 'inv0', key: 'power_treads' }, { slot: 'inv1', key: 'bfury' }];

/** Прогон по секундам со счётом; возвращает следующий предмет в конце */
function after(sec: number, score: [number, number]) {
  const mem = new CoachMemory();
  let last: ReturnType<typeof nextItem> = null;
  for (let t = 0; t <= sec; t += 5) {
    const now = T0 + t * 1000;
    const s = sim({ wallMs: now, clock: 1500 + t, heroKey: 'antimage', heroId: 1, team: 'radiant', scoreRadiant: score[0], scoreDire: score[1], items });
    const v = buildView(s.state, s.gsi, now);
    const c = { v, mem, ev: mem.ingest(v, 1800), look: new CoachLookup(data), settings: { ...defaultCoachSettings(), position: '1' as const }, now } as never;
    situationTrackRule(c);
    last = nextItem(c);
  }
  return last;
}

describe('1. положение в матче', () => {
  it('одно убийство разницы → «ровно», ветка сборки не меняется', () => {
    expect(killSituation(10, 11)).toBe('even');
    expect(after(200, [10, 11])?.sit ?? null).toBeNull();
  });
  it('мало убийств → положение не оценивается', () => {
    expect(killSituation(1, 4)).toBeNull();
  });
  it('команда отстаёт, но меньше 90 с → ветка ещё не меняется (не скачет)', () => {
    expect(after(60, [5, 15])?.sit ?? null).toBeNull();
  });
  it('устойчиво отстаём → подтверждённый предмет вперёд, причина с цифрами', () => {
    const n = after(120, [5, 15]);
    expect(n?.key).toBe('black_king_bar');
    expect(n?.sit?.pick.share).toBe(0.42);
  });
  it('без подтверждённых данных (пустой файл) — сборка как раньше', () => {
    const mem = new CoachMemory();
    const s = sim({ wallMs: T0, clock: 1500, heroKey: 'antimage', heroId: 1, items });
    const v = buildView(s.state, s.gsi, T0);
    const c = { v, mem, ev: mem.ingest(v, 1800), look: new CoachLookup({ ...data, itemSituations: null }), settings: { ...defaultCoachSettings(), position: '1' as const }, now: T0 } as never;
    expect(nextItem(c)?.sit ?? null).toBeNull();
  });
});

describe('1. строгий отбор и отложенные матчи', () => {
  it('поправка на множественные сравнения: из 300 случайных проверок с z ≈ 2,5 не проходит ни одна', () => {
    const tests = Array.from({ length: 300 }, (_, i) => ({ id: i, z: 2.5 }));
    expect(bhSelect(tests, 0.05, 3)).toEqual([]);
  });
  it('настоящая сильная разница проходит отбор', () => {
    const r = z2(60, 120, 25, 130);
    expect(bhSelect([{ id: 1, ...r }, ...Array.from({ length: 50 }, (_, i) => ({ id: i + 2, z: 0.5 }))], 0.05, 3).map((x: { id: number }) => x.id)).toEqual([1]);
  });
  it('различие не подтвердилось на отложенных матчах → не используется', () => {
    const found = [{ id: 'bkb', ...z2(60, 120, 25, 130) }];
    expect(confirmOnHoldout(found, () => z2(20, 50, 19, 50))).toEqual([]);
    expect(confirmOnHoldout(found, () => z2(25, 50, 10, 50)).map((x: { id: string }) => x.id)).toEqual(['bkb']);
  });
});

describe('3. Турбо: «запаздывает» только для пар с ≥ 40 матчами', () => {
  const TURBO: GameModeInfo = { mode: 'turbo', source: 'clock', raw: 'start -1:00' };
  const timings = parseItemTimings(JSON.parse(readFileSync(join(ROOT, 'src/data/item-timings.json'), 'utf8')))!;
  const ctx = (t: typeof timings, i: Partial<SimInput>) => {
    const s = sim({ wallMs: T0, clock: 720, ...i });
    const v = buildView(s.state, s.gsi, T0);
    const mem = new CoachMemory();
    const look = new CoachLookup({ ...realData(), statsRanked: ranked, itemTimings: t });
    look.setMode(TURBO);
    return { v, mem, ev: mem.ingest(v, 1800), look, settings: { ...defaultCoachSettings(), position: '1' as const }, now: T0 } as never;
  };
  it('Турбо, пара с < 40 матчами → «запаздывает» молчит', () => {
    const few = { ...timings, turbo: { ...timings.turbo!, builds: { antimage: { '1': { n: 39, items: [{ key: 'bfury', share: 0.95, p50: 8, p80: 9 }] } } } } };
    expect(itemTimingRule(ctx(few, { clock: 720, heroKey: 'antimage', heroId: 1, items: [{ slot: 'inv0', key: 'power_treads' }] }))).toBeNull();
    const enough = { ...timings, turbo: { ...timings.turbo!, builds: { antimage: { '1': { n: 40, items: [{ key: 'bfury', share: 0.95, p50: 8, p80: 9 }] } } } } };
    expect(itemTimingRule(ctx(enough, { clock: 720, heroKey: 'antimage', heroId: 1, items: [{ slot: 'inv0', key: 'power_treads' }] }))).not.toBeNull();
  });
  it('сборки Турбо по рангу: в подсказке назван ранг игроков', () => {
    const r = { ...timings, turbo: { ...timings.turbo!, rank: { minSeasonRank: 71, label: 'Divine+', matches: 3000 }, builds: { antimage: { '1': { n: 60, items: [{ key: 'bfury', share: 0.95, p50: 8, p80: 9 }] } } } } };
    const h = itemTimingRule(ctx(r, { clock: 720, heroKey: 'antimage', heroId: 1, items: [{ slot: 'inv0', key: 'power_treads' }] })) as { detail: { normal: string } } | null;
    expect(h?.detail.normal).toMatch(/В Турбо \(игроки Divine\+\)/);
  });
});
