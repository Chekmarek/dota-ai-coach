// Драфт и матчапы в Турбо: статистика публичных матчей Турбо (stats-turbo.json, OpenDota lobby_type 0, game_mode 23)
// — отдельный файл в том же формате; обычная статистика в Турбо не подставляется; угрозы и предметы от режима не зависят.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { counterDelta } from '../../src/core/draft/index.ts';
import { DraftService } from '../../src/main/coach/draft.ts';
import { parseKbStats, statsMatches } from '../../src/shared/types/stats.ts';
import { realData } from './coach-sim.ts';

const KB = join(import.meta.dirname, '../../resources/data/kb/7.41f');
const rawTurbo = JSON.parse(readFileSync(join(KB, 'stats-turbo.json'), 'utf8'));
const rawNormal = JSON.parse(readFileSync(join(KB, 'stats.json'), 'utf8'));
const turbo = parseKbStats(rawTurbo, '7.41f', 'turbo')!;
const real = realData();
const data: CoachData = { ...real, statsTurbo: turbo };
const service = (d: CoachData) =>
  new DraftService({
    get: () => ({ meta: { patch: d.patch, verification: 'imported-unverified' }, heroes: d.heroes, items: d.items, mechanics: d.mechanics }) as never,
    stats: () => d.stats,
    statsTurbo: () => d.statsTurbo ?? null,
  });
const req = { allies: ['lion'], enemies: ['bristleback', 'riki', 'zuus'], bans: [], position: null, me: null };

describe('статистика Турбо (stats-turbo.json)', () => {
  it('режим «turbo», тот же патч, что база знаний; все герои с матчапами; больше 100 тыс. матчей', () => {
    expect(turbo).not.toBeNull();
    expect(turbo.mode).toBe('turbo');
    expect(turbo.heroes.length).toBeGreaterThanOrEqual(120);
    expect(turbo.heroes.filter((h) => Object.keys(h.matchups).length >= 100).length).toBeGreaterThanOrEqual(120);
    expect(statsMatches(turbo)!).toBeGreaterThan(100_000);
    // профи, ориентиры и популярные сборки в Турбо не собираются
    expect(turbo.heroes.every((h) => h.pro === null && h.bench === null && h.popular === null)).toBe(true);
  });
  it('файлы не путаются: Турбо не читается как обычная статистика и наоборот', () => {
    expect(parseKbStats(rawTurbo, '7.41f')).toBeNull();
    expect(parseKbStats(rawNormal, '7.41f', 'turbo')).toBeNull();
    expect(parseKbStats(rawTurbo, '7.40', 'turbo')).toBeNull();
  });
});

describe('драфт по режиму', () => {
  it('Турбо: подпись «Турбо», число матчей Турбо; проценты — из статистики Турбо', () => {
    const r = service(data).suggest({ ...req, mode: 'turbo' });
    expect(r.error).toBeNull();
    expect(r.mode).toBe('turbo');
    expect(r.statsMatches).toBe(statsMatches(turbo));
    const c = r.candidates[0]!;
    const vs = c.vsEnemies[0]!;
    const hero = real.heroes.find((h) => h.key === c.hero)!;
    const enemy = real.heroes.find((h) => h.key === vs.hero)!;
    expect(vs.games).toBe(turbo.heroes.find((h) => h.id === hero.id)!.matchups[String(enemy.id)]![0]);
  });
  it('обычный режим — прежняя статистика; подбор в Турбо другой', () => {
    const n = service(data).suggest(req);
    const t = service(data).suggest({ ...req, mode: 'turbo' });
    expect(n.mode).toBe('normal');
    expect(n.statsMatches).toBe(statsMatches(real.stats));
    expect(t.candidates.map((c) => c.hero)).not.toEqual(n.candidates.map((c) => c.hero));
  });
  it('угрозы врагов и предметы против них от режима не зависят', () => {
    const n = service(data).suggest({ ...req, me: 'axe' });
    const t = service(data).suggest({ ...req, me: 'axe', mode: 'turbo' });
    expect(t.threats).toEqual(n.threats);
    expect(t.me!.role).toBe(n.me!.role);
  });
  it('нет статистики Турбо — честная ошибка, обычная не подставляется', () => {
    const r = service({ ...real, statsTurbo: null }).suggest({ ...req, mode: 'turbo' });
    expect(r.candidates).toEqual([]);
    expect(r.error).toMatch(/Нет статистики Турбо/);
  });
  it('матчапы в матче (оценка драки): в Турбо — из статистики Турбо; пары меньше порога не влияют', () => {
    const look = new CoachLookup(data);
    const normal = look.matchup('axe', 'bristleback');
    look.setMode({ mode: 'turbo', source: 'clock', raw: 'start -1:00' });
    const t = look.matchup('axe', 'bristleback')!;
    const axe = real.heroes.find((h) => h.key === 'axe')!;
    const bb = real.heroes.find((h) => h.key === 'bristleback')!;
    expect(t.games).toBe(turbo.heroes.find((h) => h.id === axe.id)!.matchups[String(bb.id)]![0]);
    expect(t.games).not.toBe(normal!.games);
    // редкая пара (меньше 100 игр) в Турбо даёт нулевой вклад, как и в обычной статистике
    let rare: [string, string] | null = null;
    for (const h of turbo.heroes) {
      const e = Object.entries(h.matchups).find(([, m]) => m[0] < 100);
      if (e) {
        rare = [real.heroes.find((x) => x.id === h.id)!.key, real.heroes.find((x) => x.id === Number(e[0]))!.key];
        break;
      }
    }
    if (rare) expect(counterDelta(look, rare[0], rare[1])?.delta ?? 0).toBe(0);
  });
});
