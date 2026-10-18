// Режим игры по GSI (Турбо / All Pick / другое / неизвестен) и ручной выбор.
// Настоящая запись есть только у Hero Demo; тела Турбо, All Pick и бот-лобби — синтетические (laning.json с полем
// map.game_mode по перечислению Valve DOTA_GameMode), пока нет настоящих записей этих режимов.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectGameMode, gameModeRu, GameModeTracker, mapGsi, modeBannerText, modeFromClockStart, resolveGameMode, UNKNOWN_MODE } from '../../src/core/gsi/index.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';

const FIX = join(import.meta.dirname, '../fixtures/gsi');
const laning = () => JSON.parse(readFileSync(join(FIX, 'laning.json'), 'utf8')) as { map: Record<string, unknown> } & Record<string, unknown>;
const withMode = (gm: unknown, extra: Record<string, unknown> = {}) => {
  const b = laning();
  b.map = { ...b.map, game_mode: gm, ...extra };
  return b;
};
const recorded = readFileSync(join(FIX, 'recorded/demo-antimage.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => (JSON.parse(l) as { body: unknown }).body);

describe('режим игры по телу GSI', () => {
  it('настоящая запись Hero Demo: пользовательская игра, не Турбо', () => {
    const modes = new Set(recorded.map((b) => JSON.stringify(detectGameMode(b))));
    // первый запрос {"player":{}} — без map: о режиме ничего не говорит
    expect(detectGameMode(recorded[0])).toBeNull();
    expect([...modes].filter((m) => m !== 'null')).toEqual([JSON.stringify({ mode: 'other', source: 'custom-game', raw: 'hero_demo' })]);
    expect(gameModeRu(detectGameMode(recorded[1])!)).toBe('Hero Demo');
  });
  it('Турбо, All Pick (матчмейкинг и старое имя), другой режим', () => {
    expect(detectGameMode(withMode('DOTA_GAMEMODE_TURBO'))).toEqual({ mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' });
    expect(detectGameMode(withMode('DOTA_GAMEMODE_ALL_DRAFT'))!.mode).toBe('all-pick');
    expect(detectGameMode(withMode('DOTA_GAMEMODE_AP'))!.mode).toBe('all-pick');
    expect(detectGameMode(withMode('DOTA_GAMEMODE_CM'))).toEqual({ mode: 'other', source: 'gsi', raw: 'DOTA_GAMEMODE_CM' });
  });
  it('номер режима вместо имени — по тому же перечислению Valve', () => {
    expect(detectGameMode(withMode(23))!.mode).toBe('turbo');
    expect(detectGameMode(withMode(22))!.mode).toBe('all-pick');
    expect(detectGameMode(withMode(2))).toEqual({ mode: 'other', source: 'gsi', raw: 'DOTA_GAMEMODE_2' });
  });
  it('бот-лобби с режимом из матчмейкинга: режим берётся из game_mode, а не из лобби', () => {
    expect(detectGameMode(withMode('DOTA_GAMEMODE_TURBO', { matchid: '0', customgamename: '' }))!.mode).toBe('turbo');
  });
  it('пусто, NONE, мусор, нет поля — неизвестен', () => {
    expect(detectGameMode(laning())).toEqual(UNKNOWN_MODE);
    expect(detectGameMode(withMode(''))).toEqual(UNKNOWN_MODE);
    expect(detectGameMode(withMode('DOTA_GAMEMODE_NONE'))).toEqual(UNKNOWN_MODE);
    expect(detectGameMode(withMode(0))).toEqual(UNKNOWN_MODE);
    expect(detectGameMode(withMode(null))).toEqual(UNKNOWN_MODE);
    expect(detectGameMode(withMode({ x: 1 }))).toEqual(UNKNOWN_MODE);
    expect(detectGameMode(withMode(1.5))).toEqual(UNKNOWN_MODE);
    expect(gameModeRu(UNKNOWN_MODE)).toBe('режим неизвестен');
  });
  it('нет блока map или не объект — null', () => {
    expect(detectGameMode({ player: {} })).toBeNull();
    expect(detectGameMode(null)).toBeNull();
    expect(detectGameMode('x')).toBeNull();
  });
  it('странное поле game_mode не ломает разбор остального тела', () => {
    const r = mapGsi(withMode({ x: 1 }))!;
    expect(r).not.toBeNull();
    expect(r.hero.key).toBe('nevermore');
    expect(r.gameMode).toEqual(UNKNOWN_MODE);
    expect(mapGsi(withMode('DOTA_GAMEMODE_TURBO'))!.gameMode!.mode).toBe('turbo');
  });
});

describe('ручной выбор режима', () => {
  const turbo = { mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' } as const;
  it('auto — как в игре; нет данных — неизвестен', () => {
    expect(resolveGameMode(turbo, 'auto')).toEqual(turbo);
    expect(resolveGameMode(null, 'auto')).toEqual(UNKNOWN_MODE);
  });
  it('выбор пользователя важнее данных игры', () => {
    expect(resolveGameMode(turbo, 'normal')).toEqual({ mode: 'all-pick', source: 'manual', raw: 'DOTA_GAMEMODE_TURBO' });
    expect(resolveGameMode(UNKNOWN_MODE, 'turbo')).toEqual({ mode: 'turbo', source: 'manual', raw: null });
    expect(gameModeRu(resolveGameMode(null, 'turbo'))).toBe('Турбо (выбран вручную)');
    expect(gameModeRu(resolveGameMode(null, 'normal'))).toBe('Обычный режим (выбран вручную)');
  });
});

describe('режим в модели матча', () => {
  it('хранится, не сбрасывается телом без режима, сбрасывается с новым матчем', () => {
    const m = new MatchStateModel();
    expect(m.snapshot(0).match.mode).toEqual(UNKNOWN_MODE);
    m.ingestGsi(mapGsi(withMode('DOTA_GAMEMODE_TURBO'))!, 1000);
    expect(m.snapshot(1000).match.mode.mode).toBe('turbo');
    // тот же матч, режим в теле не пришёл (неизвестен) — так Dota могла бы прислать частичное тело
    const same = mapGsi(laning())!;
    m.ingestGsi({ ...same, gameMode: null }, 2000);
    expect(m.snapshot(2000).match.mode.mode).toBe('turbo');
    // новый матч (другой matchid) без режима — режим неизвестен
    const next = laning();
    next.map = { ...next.map, matchid: '8000000001' };
    m.ingestGsi(mapGsi(next)!, 3000);
    expect(m.snapshot(3000).match.mode).toEqual(UNKNOWN_MODE);
  });
  it('ручной сброс матча — режим неизвестен', () => {
    const m = new MatchStateModel();
    m.ingestGsi(mapGsi(withMode('DOTA_GAMEMODE_TURBO'))!, 1000);
    m.reset(2000);
    expect(m.snapshot(2000).match.mode).toEqual(UNKNOWN_MODE);
  });
});

// Настоящая запись лобби на обычной карте (2026-10-16): выбор героев → подготовка с −1:29 → начало игры.
// Турбо и игра против ботов — та же запись со сдвинутыми часами подготовки (синтетика: настоящих записей этих
// режимов пока нет; старт −1:00 и −1:15 — по Liquipedia «Time of Day»).
const lobby = readFileSync(join(FIX, 'recorded/lobby-normal.jsonl'), 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { t: number; body: { map?: Record<string, unknown> } & Record<string, unknown> });
const PRE = 'DOTA_GAMERULES_STATE_PRE_GAME';
/** Часы подготовки начинаются с start вместо настоящих −89 (тела подготовки до 0:00 укорачиваются) */
function shifted(start: number) {
  const from = -89;
  return lobby.flatMap((e) => {
    const m = e.body.map;
    if (!m || m.game_state !== PRE) return [e];
    const c = (m.clock_time as number) - from + start;
    return c > 0 ? [] : [{ ...e, body: { ...e.body, map: { ...m, clock_time: c } } }];
  });
}
const run = (entries: typeof lobby, tracker = new GameModeTracker()) => {
  let last = null;
  for (const e of entries) last = tracker.feed(e.body, e.t);
  return last;
};

describe('режим по часам в начале подготовки', () => {
  it('настоящая запись лобби: в теле нет game_mode, подготовка с −1:29 → обычный режим', () => {
    expect(lobby.some((e) => e.body.map && 'game_mode' in e.body.map)).toBe(false);
    const firstPre = lobby.find((e) => e.body.map?.game_state === PRE)!;
    expect(firstPre.body.map!.clock_time).toBe(-89);
    const m = run(lobby)!;
    expect(m).toEqual({ mode: 'all-pick', source: 'clock', raw: 'start -1:30' });
    expect(gameModeRu(m)).toBe('Обычный режим');
    expect(modeBannerText(m)).toEqual({ title: 'Обычный режим', text: 'По часам матча: подготовка с −1:30' });
  });
  it('до подготовки (выбор героев) — неизвестен', () => {
    const draft = lobby.filter((e) => e.body.map?.game_state === 'DOTA_GAMERULES_STATE_HERO_SELECTION');
    expect(run(draft)).toEqual(UNKNOWN_MODE);
  });
  it('та же запись с подготовкой с −1:00 → Турбо; с −1:15 → игра против ботов', () => {
    const turbo = run(shifted(-60))!;
    expect(turbo).toEqual({ mode: 'turbo', source: 'clock', raw: 'start -1:00' });
    expect(modeBannerText(turbo)).toEqual({ title: 'Турбо', text: 'По часам матча: подготовка с −1:00' });
    expect(run(shifted(-75))).toEqual({ mode: 'other', source: 'clock', raw: 'bots' });
  });
  it('коуч включили посреди подготовки: −1:29 видно → обычный; Турбо без начала подготовки — неизвестен', () => {
    const lateNormal = lobby.filter((e) => e.body.map?.game_state === PRE || e.body.map?.game_state === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS');
    expect(run(lateNormal)!.mode).toBe('all-pick');
    const lateTurbo = shifted(-60).filter((e) => e.body.map?.game_state === PRE && (e.body.map.clock_time as number) > -50);
    expect(run(lateTurbo)).toEqual(UNKNOWN_MODE);
  });
  it('пауза GSI на переходе к подготовке — по часам не определяем', () => {
    const gap = shifted(-60).map((e) => (e.body.map?.game_state === PRE ? { ...e, t: e.t + 60_000 } : e));
    expect(run(gap)).toEqual(UNKNOWN_MODE);
  });
  it('часы не подходят ни к одному старту — неизвестен', () => {
    expect(modeFromClockStart(-45)).toBeNull();
    expect(modeFromClockStart(-82)).toBeNull();
    expect(run(shifted(-45))).toEqual(UNKNOWN_MODE);
  });
  it('новый матч после Турбо: снова выбор героев сбрасывает режим, следующий определяется заново', () => {
    const t = new GameModeTracker();
    expect(run(shifted(-60), t)!.mode).toBe('turbo');
    const offset = 10 * 60_000;
    expect(run(lobby.map((e) => ({ ...e, t: e.t + offset })), t)!.mode).toBe('all-pick');
  });
  it('поле game_mode важнее часов; Hero Demo — пользовательская игра', () => {
    const t = new GameModeTracker();
    run(lobby, t);
    const body = { ...lobby.at(-1)!.body, map: { ...lobby.at(-1)!.body.map, game_mode: 'DOTA_GAMEMODE_TURBO' } };
    expect(t.feed(body, lobby.at(-1)!.t + 100)).toEqual({ mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' });
    expect(run(recorded.map((b, i) => ({ t: i * 100, body: b as never })))).toEqual({ mode: 'other', source: 'custom-game', raw: 'hero_demo' });
  });
  it('тела без map (меню) режим не меняют; мусор не ломает', () => {
    const t = new GameModeTracker();
    expect(t.feed({ player: {} }, 1)).toBeNull();
    run(lobby, t);
    expect(t.feed({ player: {} }, Date.now())!.mode).toBe('all-pick');
    expect(t.feed(null, 2)!.mode).toBe('all-pick');
    expect(t.feed({ map: { game_state: PRE, clock_time: 'x' } }, 3)!.mode).toBe('all-pick');
  });
});
