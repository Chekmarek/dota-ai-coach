// Мета патча: топ героев по позициям (OpenDota heroStats + позиции STRATZ), тренды, изменения из описаний Valve,
// скачивание и кэш (сеть подменена — тест в интернет не ходит).
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildMeta, cleanNote, currentPatchFamily, heroNotes, snapshotOf, trendBase, MIN_PICKS, TREND_MIN_AGE_MS, type OdHeroStat } from '../../src/core/meta/meta.ts';
import { MetaService } from '../../src/main/knowledge/meta-sync.ts';
import type { KbHero } from '../../src/shared/types/kb.ts';
import type { StatsRanked } from '../../src/shared/types/stats-ranked.ts';

const KB = join(import.meta.dirname, '../../resources/data/kb/7.41f');
const heroes = JSON.parse(readFileSync(join(KB, 'heroes.json'), 'utf8')) as KbHero[];

/** heroStats: id → [игр, побед] поровну во всех рангах 6–8 и столько же в 1–5 */
function od(list: [number, number, number][]): OdHeroStat[] {
  return list.map(([id, picks, wins]) => {
    const o: OdHeroStat = { id };
    for (let b = 1; b <= 8; b++) {
      o[`${b}_pick`] = b >= 6 ? Math.round(picks / 3) : picks;
      o[`${b}_win`] = b >= 6 ? Math.round(wins / 3) : Math.round(picks / 2);
    }
    return o;
  });
}
const ranked = (m: Record<number, Record<string, number>>): StatsRanked =>
  ({ schema: 'dota-coach.stats-ranked', version: 1, patch: '7.41f', bracket: 'DIVINE_IMMORTAL', generatedAt: '', heroes: Object.entries(m).map(([id, matches]) => ({ id: Number(id), key: '', matches, curves: {}, items: {} })) }) as StatsRanked;

describe('топ героев', () => {
  // 1 Anti-Mage (керри, 56 %), 5 Crystal Maiden (поз. 5, 54 %), 8 Juggernaut (керри, 51 %), 2 Axe (оффлейн, 56,5 % на малом числе игр)
  const stats = od([
    [1, 30_000, 16_800],
    [5, 30_000, 16_200],
    [8, 30_000, 15_300],
    [2, MIN_PICKS + 300, Math.round((MIN_PICKS + 300) * 0.565)],
  ]);
  const r = ranked({ 1: { 1: 1000 }, 5: { 5: 900, 4: 100 }, 8: { 1: 1000 }, 2: { 3: 1000 } });

  it('по позициям: керри — только керри, сортировка по доле побед, позиция из STRATZ', () => {
    const m = buildMeta({ stats, heroes, ranked: r, bracket: 'high', base: null, changedInLatest: new Set([8]) });
    expect(m.positionsFrom).toBe('stratz');
    expect(m.positions['1']!.map((x) => x.hero)).toEqual(['antimage', 'juggernaut']);
    expect(m.positions['5']!.map((x) => x.hero)).toEqual(['crystal_maiden']);
    expect(m.positions['1']![1]!.changedInLatest).toBe(true);
    expect(m.positions['5']![0]!.positionShare).toBe(0.9);
  });

  it('редкий герой с чуть большей долей побед уступает частому (оценка сжата к средней)', () => {
    // у Axe доля побед выше (56,5 % против 56 %), но игр в 17 раз меньше — первое место у Anti-Mage
    const m = buildMeta({ stats, heroes, ranked: r, bracket: 'high', base: null, changedInLatest: new Set(), top: 1 });
    expect(m.positions['0']!.map((x) => x.hero)).toEqual(['antimage']);
  });

  it('мало игр — героя нет вовсе; ранги считаются отдельно', () => {
    const few = od([[1, MIN_PICKS - 300, 900]]);
    expect(buildMeta({ stats: few, heroes, ranked: r, bracket: 'high', base: null, changedInLatest: new Set() }).positions['0']).toEqual([]);
    // в рангах 1–5 у всех ровно 50 %
    const all = buildMeta({ stats, heroes, ranked: r, bracket: 'mid', base: null, changedInLatest: new Set() });
    expect(all.positions['0']!.every((x) => x.winrate === 0.5)).toBe(true);
  });

  it('тренд — от замера не моложе 3 дней и только заметный', () => {
    const now = 100 * 24 * 3600_000;
    const old = snapshotOf(od([[1, 30_000, 15_000], [5, 30_000, 16_150]]), now - TREND_MIN_AGE_MS - 1);
    const fresh = snapshotOf(od([[1, 30_000, 10_000]]), now - 3600_000);
    const base = trendBase([old, fresh], now);
    expect(base).toBe(old);
    const m = buildMeta({ stats, heroes, ranked: r, bracket: 'high', base, changedInLatest: new Set() });
    const am = m.positions['0']!.find((x) => x.hero === 'antimage')!;
    expect(am.trend).toBeCloseTo(6, 0);
    // у Crystal Maiden разница меньше 0,5 п.п. — без стрелки
    expect(m.positions['0']!.find((x) => x.hero === 'crystal_maiden')!.trend).toBeNull();
  });

  it('без статистики позиций — по главной роли базы знаний', () => {
    const m = buildMeta({ stats, heroes, ranked: null, bracket: 'high', base: null, changedInLatest: new Set() });
    expect(m.positionsFrom).toBe('roles');
    expect(m.positions['5']!.map((x) => x.hero)).toContain('crystal_maiden');
    expect(m.positions['5']![0]!.positionShare).toBeNull();
  });
});

describe('изменения героев (описания Valve)', () => {
  it('способности по названиям базы знаний, разметка убрана, порядок: герой, способности, таланты', () => {
    const am = heroes.find((h) => h.key === 'antimage')!;
    const blink = am.abilities.find((a) => a.key === 'antimage_blink')!;
    const notes = heroNotes(
      {
        heroes: [
          {
            hero_id: 1,
            hero_notes: [{ note: 'Базовая броня увеличена на 1', indent_level: 1 }],
            talent_notes: [{ note: 'Талант 25 уровня изменён', indent_level: 1 }],
            abilities: [{ ability_id: blink.id, ability_notes: [{ note: 'Перезарядка <b>уменьшена</b>&nbsp;с 12 до 10', indent_level: 1 }, { note: 'Подробность', indent_level: 2 }] }],
          },
        ],
      },
      heroes,
    ).get(1)!;
    expect(notes.map((n) => n.title)).toEqual(['Герой', blink.name, blink.name, 'Таланты']);
    expect(notes[1]!.text).toBe('Перезарядка уменьшена с 12 до 10');
    expect(notes[2]!.indent).toBe(1);
  });

  it('версии текущего патча — от новых к старым, прежний патч не входит', () => {
    const f = currentPatchFamily([
      { patch_number: '7.40c', patch_timestamp: 1 },
      { patch_number: '7.41', patch_timestamp: 10 },
      { patch_number: '7.41b', patch_timestamp: 30 },
      { patch_number: '7.41a', patch_timestamp: 20 },
    ]);
    expect(f.map((p) => p.version)).toEqual(['7.41b', '7.41a', '7.41']);
    expect(cleanNote('a<br>b')).toBe('a b');
  });
});

describe('скачивание и кэш', () => {
  const statsBody = od(heroes.slice(0, 120).map((h, i) => [h.id, 20_000, 10_000 + i * 20]));
  function fakeFetch(fail = false) {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(url);
      if (fail) throw new Error('offline');
      const body = url.includes('heroStats')
        ? statsBody
        : url.includes('patchnoteslist')
          ? { patches: [{ patch_number: '7.41', patch_timestamp: 10 }, { patch_number: '7.41a', patch_timestamp: 20 }] }
          : { patch_number: url.includes('7.41a') ? '7.41a' : '7.41', heroes: url.includes('7.41a') ? [{ hero_id: 1, hero_notes: [{ note: 'Изменение', indent_level: 1 }] }] : [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  it('скачивает, строит топ и изменения; патч скачивается один раз; в матче — не обновляет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotacoach-meta-'));
    let t = 1_000_000;
    const { f, calls } = fakeFetch();
    const svc = new MetaService({ cacheDir: dir, heroes: () => heroes, ranked: () => null, inMatch: () => false, log: () => {}, fetch: f, now: () => t });
    expect(svc.state('high').note).toMatch(/ещё нет/);
    expect(await svc.refreshIfStale()).toBe('updated');
    const s = svc.state('high');
    expect(s.positions['0']!.length).toBe(10);
    expect(s.patches.map((p) => p.version)).toEqual(['7.41a', '7.41']);
    expect(svc.heroChanges('antimage', 'high')!.patches[0]!.notes[0]!.text).toBe('Изменение');
    expect(s.positions['0']!.find((r) => r.hero === 'antimage')?.changedInLatest ?? true).toBe(true);
    // свежий кэш — в сеть не ходим
    const n = calls.length;
    expect(await svc.refreshIfStale()).toBe('fresh');
    expect(calls.length).toBe(n);
    // принудительно — статистика заново, описания патчей — нет
    t += 1000;
    expect(await svc.refreshIfStale(true)).toBe('updated');
    expect(calls.slice(n).filter((u) => u.includes('patchnotes?'))).toEqual([]);
    // в матче — ничего
    const inMatch = new MetaService({ cacheDir: dir, heroes: () => heroes, ranked: () => null, inMatch: () => true, log: () => {}, fetch: f, now: () => t + 10 * 3600_000 });
    expect(await inMatch.refreshIfStale()).toBe('in-match');
  });

  it('без сети — честная причина, кэш не портится', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dotacoach-meta-'));
    const svc = new MetaService({ cacheDir: dir, heroes: () => heroes, ranked: () => null, inMatch: () => false, log: () => {}, fetch: fakeFetch(true).f });
    expect(await svc.refreshIfStale()).toBe('offline');
    expect(svc.state('all').note).toMatch(/Нет связи/);
  });
});
