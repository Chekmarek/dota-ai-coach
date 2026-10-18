// Режим игры по GSI (Турбо / All Pick / другое / неизвестен) и ручной выбор.
// Настоящая запись есть только у Hero Demo; тела Турбо, All Pick и бот-лобби — синтетические (laning.json с полем
// map.game_mode по перечислению Valve DOTA_GameMode), пока нет настоящих записей этих режимов.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { detectGameMode, gameModeRu, mapGsi, resolveGameMode, UNKNOWN_MODE } from '../../src/core/gsi/index.ts';
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
