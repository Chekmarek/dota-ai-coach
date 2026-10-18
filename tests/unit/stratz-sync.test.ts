// Слой STRATZ (ночная задача, этап 2): обновление кэша с токеном владельца — без токена, без сети и в матче ничего
// не ломается; токен не попадает в кэш; коуч работает из кэша без интернета.
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StratzSync, readStratzCache, STRATZ_CACHE_FILE } from '../../src/main/knowledge/stratz-sync';
import { stratzRankedQuery, toRankedHero } from '../../src/core/knowledge-base/stratz-ranked';
import { CoachLookup } from '../../src/core/coach/data';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index';
import { realData, sim } from './coach-sim';

const TOKEN = 'eyJ.test-token-must-not-leak.sig';
const heroes = [{ id: 1, key: 'antimage' }, { id: 2, key: 'axe' }];
const items = [{ id: 145, key: 'bfury' }, { id: 63, key: 'power_treads' }];
const heroStats = {
  stats: [0, 5, 10].flatMap((time) => [{ time, position: 'POSITION_1', matchCount: 5000, cs: time * 4, networth: 600 + time * 300, xp: time * 280, level: time / 2 }]),
  // покупки — по позиции отдельно (p1…p5): метка position в ответе STRATZ всегда POSITION_1
  p1: [{ itemId: 145, time: 14, matchCount: 4000, winCount: 2100 }, { itemId: 63, time: 9, matchCount: 4500, winCount: 2300 }],
};

function okFetch(calls: string[] = []): typeof fetch {
  return (async (_url: string, init?: RequestInit) => {
    const q = JSON.parse(String(init?.body)).query as string;
    calls.push(q);
    const data = q.includes('gameVersions') ? { constants: { gameVersions: [{ id: 190, name: '7.41f' }] } } : { heroStats };
    return new Response(JSON.stringify({ data }), { status: 200 });
  }) as typeof fetch;
}
const deps = (dir: string, over: Partial<ConstructorParameters<typeof StratzSync>[0]> = {}) =>
  new StratzSync({ cacheDir: dir, patch: () => '7.41f', heroes: () => heroes, items: () => items, inMatch: () => false, log: () => {}, readToken: () => TOKEN, sleep: async () => {}, fetch: okFetch(), ...over });

describe('STRATZ: кэш и обновление', () => {
  it('без токена — ничего не делает', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratz-'));
    expect(await deps(dir, { readToken: () => null }).refreshIfStale()).toBe('no-token');
    expect(existsSync(join(dir, STRATZ_CACHE_FILE))).toBe(false);
  });
  it('обновляет кэш: все герои, токена в файле нет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratz-'));
    const calls: string[] = [];
    expect(await deps(dir, { fetch: okFetch(calls) }).refreshIfStale()).toBe('updated');
    const raw = readFileSync(join(dir, STRATZ_CACHE_FILE), 'utf8');
    expect(raw).not.toContain(TOKEN);
    const c = readStratzCache(dir, '7.41f')!;
    expect(c.heroes.map((h) => h.key)).toEqual(['antimage', 'axe']);
    expect(c.heroes[0]!.items['1']!.map((i) => i.key)).toEqual(['power_treads', 'bfury']);
    expect(calls.length).toBe(3);
  });
  it('свежий кэш — не обновляет; старше 3 дней — обновляет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratz-'));
    await deps(dir).refreshIfStale();
    expect(await deps(dir).refreshIfStale()).toBe('fresh');
    const old = (Date.now() - 4 * 24 * 3600_000) / 1000;
    utimesSync(join(dir, STRATZ_CACHE_FILE), old, old);
    expect(await deps(dir).refreshIfStale()).toBe('updated');
  });
  it('нет интернета — «offline», старый кэш цел', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratz-'));
    await deps(dir).refreshIfStale();
    const before = readFileSync(join(dir, STRATZ_CACHE_FILE), 'utf8');
    const old = (Date.now() - 4 * 24 * 3600_000) / 1000;
    utimesSync(join(dir, STRATZ_CACHE_FILE), old, old);
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await deps(dir, { fetch: offline }).refreshIfStale()).toBe('offline');
    expect(readFileSync(join(dir, STRATZ_CACHE_FILE), 'utf8')).toBe(before);
  });
  it('во время матча — не ходит в сеть', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratz-'));
    const calls: string[] = [];
    expect(await deps(dir, { inMatch: () => true, fetch: okFetch(calls) }).refreshIfStale()).toBe('in-match');
    expect(calls).toEqual([]);
  });
  it('лимит (429) — ждёт и повторяет', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratz-'));
    let n = 0;
    const waits: number[] = [];
    const flaky = (async (url: string, init?: RequestInit) => (++n === 2 ? new Response('', { status: 429 }) : okFetch()(url, init))) as typeof fetch;
    expect(await deps(dir, { fetch: flaky, sleep: async (ms) => void waits.push(ms) }).refreshIfStale()).toBe('updated');
    expect(waits).toContain(30_000);
  });
  it('запрос: покупки по каждой позиции отдельно и с matchLimit (иначе STRATZ режет сборку до 1–6 предметов)', () => {
    const q = stratzRankedQuery(84);
    for (const p of [1, 2, 3, 4, 5]) expect(q).toContain(`p${p}: itemFullPurchase(heroId: 84, bracketBasicIds: [DIVINE_IMMORTAL], positionIds: [POSITION_${p}], matchLimit: 10)`);
  });
  it('кэш другого патча не читается', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'stratz-'));
    await deps(dir).refreshIfStale();
    expect(readStratzCache(dir, '7.42')).toBeNull();
    writeFileSync(join(dir, STRATZ_CACHE_FILE), '{испорчен');
    expect(readStratzCache(dir, '7.41f')).toBeNull();
  });
});

describe('нет интернета → коуч работает из кэша', () => {
  it('данные рейтинга из кэша — сравнение и сборка работают, в сеть никто не ходит', () => {
    const fetchBefore = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error('нет сети');
    }) as typeof fetch;
    try {
      const cached = { schema: 'dota-coach.stats-ranked' as const, version: 1 as const, patch: '7.41f', bracket: 'DIVINE_IMMORTAL', generatedAt: '2026-10-19T00:00:00Z', heroes: [toRankedHero({ id: 1, key: 'antimage' }, heroStats, new Map(items.map((i) => [i.id, i.key])))] };
      const data = { ...realData(), statsRanked: cached };
      expect(new CoachLookup(data).rankedAt('antimage', 1, 10)?.lh).toBe(40);
      const e = new CoachEngine({ data, now: () => 1_000_000, settings: { ...defaultCoachSettings(), position: '1' } });
      const s = sim({ wallMs: 1_000_000, clock: 605, heroKey: 'antimage', lastHits: 10, gpm: 300, xpm: 300 });
      const u = e.tick(s.state, s.gsi, 1_000_000);
      expect(u.shown.some((h) => h.id === 'laning.bench')).toBe(true);
    } finally {
      globalThis.fetch = fetchBefore;
    }
  });
});
