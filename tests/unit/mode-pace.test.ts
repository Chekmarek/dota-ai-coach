// Режим посреди матча (DECISIONS.md п. 68): коуч подключился после начала игры и подготовки не видел — режим по темпу
// (уровень своего героя к минуте). Пока не решено — «неизвестен», и коуч работает по правилам и моделям обычной игры.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameModeTracker, paceVote } from '../../src/core/gsi/mode.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { realData } from './coach-sim.ts';

const FIX = join(import.meta.dirname, '../fixtures/gsi');
const laning = () => JSON.parse(readFileSync(join(FIX, 'laning.json'), 'utf8')) as { map: Record<string, unknown>; hero: Record<string, unknown> } & Record<string, unknown>;
/** Тело середины матча: часы и уровень героя; режима в GSI нет (как у настоящей Dota) */
function body(clock: number, level: number, matchid = '777') {
  const b = laning();
  b.map = { ...b.map, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', clock_time: clock, matchid };
  delete b.map.game_mode;
  b.hero = { ...b.hero, level };
  return b;
}
/** Поток тел раз в секунду с часов from до to; уровень — по темпу perMin уровней в минуту */
function run(t: GameModeTracker, from: number, to: number, perMin: number, matchid = '777') {
  let m = null;
  for (let c = from; c <= to; c++) m = t.feed(body(c, Math.max(1, Math.min(30, Math.floor((c / 60) * perMin))), matchid), 1_000_000 + c * 1000);
  return m;
}

describe('режим по темпу игры (подключились посреди матча)', () => {
  it('голос замера: Турбо ≥ 1 уровня в минуту, обычный ≤ 0,8; до 9-й и после 25-й минуты — не решает', () => {
    expect(paceVote(12, 600)).toBe('turbo');
    expect(paceVote(7, 600)).toBe('all-pick');
    expect(paceVote(9, 600)).toBeNull();
    expect(paceVote(8, 300)).toBeNull();
    expect(paceVote(20, 1800)).toBeNull();
  });

  it('середина Турбо (с 12-й минуты, ~1,2 уровня в минуту) → Турбо по темпу; середина All Pick (~0,6) → обычный', () => {
    const turbo = run(new GameModeTracker(), 720, 800, 1.2)!;
    expect(turbo).toMatchObject({ mode: 'turbo', source: 'pace' });
    const normal = run(new GameModeTracker(), 720, 800, 0.6)!;
    expect(normal).toMatchObject({ mode: 'all-pick', source: 'pace' });
  });

  it('решение — только после 30 с согласных замеров; пограничный темп не решает', () => {
    expect(run(new GameModeTracker(), 720, 740, 1.2)!.mode).toBe('unknown');
    expect(run(new GameModeTracker(), 720, 900, 0.9)!.mode).toBe('unknown');
  });

  it('не переключается туда-обратно: короткий выброс темпа решение не меняет, а новый матч сбрасывает', () => {
    const t = new GameModeTracker();
    run(t, 720, 800, 0.6);
    expect(run(t, 801, 860, 1.2)!.mode).toBe('all-pick');
    expect(run(t, 600, 700, 1.3, '778')!.mode).toBe('turbo');
  });

  it('до подключения посреди матча: подготовку видели — режим по часам, темп его не перебивает', () => {
    const t = new GameModeTracker();
    const pre = laning();
    pre.map = { ...pre.map, game_state: 'DOTA_GAMERULES_STATE_STRATEGY_TIME', clock_time: -70, matchid: '9' };
    t.feed(pre, 1000);
    const pg = laning();
    pg.map = { ...pg.map, game_state: 'DOTA_GAMERULES_STATE_PRE_GAME', clock_time: -60, matchid: '9' };
    expect(t.feed(pg, 2000)).toMatchObject({ mode: 'turbo', source: 'clock' });
    expect(run(t, 720, 800, 0.6, '9')).toMatchObject({ mode: 'turbo', source: 'clock' });
  });

  it('при «неизвестен» — правила и модели обычной игры', () => {
    const look = new CoachLookup(realData());
    look.setMode({ mode: 'unknown', source: 'none', raw: null });
    expect(look.isTurbo).toBe(false);
    look.setMode({ mode: 'turbo', source: 'pace', raw: 'level 12 at 10:00' });
    expect(look.isTurbo).toBe(true);
  });
});
