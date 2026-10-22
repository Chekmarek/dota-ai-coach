// Сторож автопродолжения после докачки (scripts/after-items-fetch-lib.mjs, DECISIONS.md п. 85): когда докачка
// считается законченной, разбор вывода пересчёта и сравнение режима тени до/после.
import { describe, expect, it } from 'vitest';
// @ts-expect-error — .mjs без типов
import { buildReport, fetchStatus, modeDone, parseSituations, parseTimings, shadowDiff, targetsFromProgress } from '../../scripts/after-items-fetch-lib.mjs';

const progress = [
  'Обновлено: 2026-10-22T03:54:15.292Z',
  'Остаток запросов STRATZ в сутки: 11421',
  'All Pick: скачано новых 4134 (+ старых 2100), запросов сегодня 2518/9500, героев с ≥ 900 матчами: 16 из 127, меньше всего: 35, отклонено 1983',
  'Турбо: скачано новых 1550 (+ старых 860), запросов сегодня 1061/4000, героев с ≥ 500 матчами: 6 из 127, меньше всего: 13, отклонено 1051',
].join('\n');

describe('сторож: закончена ли докачка', () => {
  it('цели читаются из items-progress.txt, иначе — по умолчанию', () => {
    expect(targetsFromProgress(progress)).toEqual({ ap: 900, turbo: 500 });
    expect(targetsFromProgress(progress.replace('≥ 900', '≥ 1000'))).toEqual({ ap: 1000, turbo: 500 });
    expect(targetsFromProgress('')).toEqual({ ap: 900, turbo: 500 });
  });

  it('режим закончен, как в fetch-items-matches.mjs: все герои набрали цель или матчи кончились и очередь пуста', () => {
    expect(modeDone({ heroCounts: { 1: 900, 2: 950 }, queue: [1], exhausted: false }, 900)).toBe(true);
    expect(modeDone({ heroCounts: { 1: 900, 2: 35 }, queue: [], exhausted: false }, 900)).toBe(false);
    expect(modeDone({ heroCounts: { 1: 35 }, queue: [], exhausted: true }, 900)).toBe(true);
    expect(modeDone({ heroCounts: { 1: 35 }, queue: [{ id: 5 }], exhausted: true }, 900)).toBe(false);
    expect(modeDone(null, 900)).toBe(false);
    expect(modeDone({ heroCounts: {}, queue: [], exhausted: false }, 900)).toBe(false);
  });

  it('пересчёт — только когда закончены оба режима и процесса докачки нет', () => {
    const done = { heroCounts: { 1: 900 }, queue: [], exhausted: false };
    const notDone = { heroCounts: { 1: 10 }, queue: [], exhausted: false };
    const targets = { ap: 900, turbo: 500 };
    expect(fetchStatus({ ap: done, turbo: done, targets, fetcherAlive: false })).toBe('done');
    expect(fetchStatus({ ap: done, turbo: done, targets, fetcherAlive: true })).toBe('running');
    expect(fetchStatus({ ap: done, turbo: notDone, targets, fetcherAlive: false })).toBe('stopped');
    expect(fetchStatus({ ap: notDone, turbo: done, targets, fetcherAlive: true })).toBe('running');
  });
});

describe('сторож: отчёт', () => {
  const situationsOut = [
    'Матчей: 9000, не короче 35 мин: 4100 (поиск/отложено по номеру 70/30)',
    'Пар «герой — позиция» с ≥ 40 матчами в каждом положении (поиск): 85; с ≥ 300: 3',
    'Проверок: 2400; z ≥ 3 и поправка (FDR 5%): 7; подтвердилось на отложенных: 2',
    '  axe|3 отстаём: blink 61% против 48% (z 3.4; отложено 60% против 47%)',
    '  lina|2 ведём: aghanims_scepter 22% против 15% (z 3.1; отложено 21% против 16%)',
    'Не подтвердилось на отложенных: sven|1 bkb',
  ].join('\n');

  it('итоги build-item-situations разбираются из вывода', () => {
    const s = parseSituations(situationsOut);
    expect(s).toMatchObject({ matches: 9000, used: 4100, pairs40: 85, pairs300: 3, tests: 2400, found: 7, confirmed: 2 });
    expect(s.confirmedLines).toHaveLength(2);
    expect(parseSituations('')).toMatchObject({ matches: null, confirmed: null, confirmedLines: [] });
  });

  it('итоги build-item-timings: ранг сборок Турбо или публичные', () => {
    const ranked = parseTimings('Турбо (публичные): матчей 860, ранних предметов 9, сборок героя на позиции 300 (из них ≥ 40 матчей: 49)\nТурбо по рангу игрока Divine+: матчей 9000, игроков 30000, пар с ≥ 40 матчами 20 (нужно ≥ 49)\nТурбо по рангу игрока Ancient+: матчей 9000, игроков 60000, пар с ≥ 40 матчами 70 (нужно ≥ 49)\nСборки Турбо — по рангу игрока Ancient+ (70 пар с ≥ 40 матчами)');
    expect(ranked).toMatchObject({ turboRank: 'Ancient+', turboRankPairs: 70, publicPairs: 49 });
    expect(ranked.rankLines).toHaveLength(2);
    expect(parseTimings('Сборки Турбо по рангу: данных пока мало — остаются публичные')).toMatchObject({ turboRank: null });
  });

  it('режим тени: изменившиеся правила — по величине изменения', () => {
    const a = { checks: { total: 100 }, perMin: 3.6, byRule: { 'economy.next': 10, 'fight.engage': 50, 'danger.model': 5 }, itemAdvice: [] };
    const b = { checks: { total: 104 }, perMin: 3.7, byRule: { 'economy.next': 14, 'fight.engage': 50, 'economy.situation': 1 }, itemAdvice: [] };
    expect(shadowDiff(a, b)).toEqual({ lines: ['danger.model: 5 → 0', 'economy.next: 10 → 14', 'economy.situation: 0 → 1'], changed: 3 });
    expect(shadowDiff(null, b)).toEqual({ lines: [], changed: 0 });
  });

  it('отчёт содержит матчи, пары, отбор, проверки и режим тени', () => {
    const md = buildReport({
      finishedAt: '2026-11-20T10:00:00Z',
      branch: 'feature/items-situations',
      base: 'release/0.16.2',
      worktree: 'C:/x',
      progress,
      heroes: { ap: { reached: 127, total: 127, target: 900 }, turbo: { reached: 120, total: 127, target: 500 } },
      situations: parseSituations(situationsOut),
      timings: { turboRank: null, publicPairs: 49, rankLines: [] },
      checks: [{ name: 'unit', ok: true, summary: 'Tests 850 passed' }, { name: 'e2e', ok: false, summary: '1 failed' }],
      shadow: { ap: { before: { checks: { total: 1 }, byRule: {} }, after: { checks: { total: 1 }, byRule: {} } } },
      commit: 'abc1234',
    });
    expect(md).toContain('героев с ≥ 900 матчами — 127 из 127');
    expect(md).toContain('подтвердились на отложенных 30%: **2**');
    expect(md).toContain('axe|3 отстаём');
    expect(md).toContain('сборки Турбо остаются публичными');
    expect(md).toContain('❌ e2e');
    expect(md).toContain('по правилам без изменений');
    expect(md).toContain('Турбо: нет данных');
    expect(md).toContain('коммит abc1234');
  });
});
