// Обновление «как играют сильные игроки рейтинга» из STRATZ (ночная задача, этап 2): кэш в <папка данных>/kb-cache.
// Только если на этом ПК есть личный токен STRATZ (%USERPROFILE%\.stratz-token(.txt) или STRATZ_TOKEN): токен читается
// здесь, не пишется ни в журнал, ни в кэш, в сборку не попадает. Без токена, без сети или во время матча — ничего
// не делает: коуч работает на кэше или на данных, вшитых в приложение. Лимиты STRATZ — 8 запросов/с, 150/мин:
// идём не быстрее 3 в секунду, на 429 ждём, на сетевой ошибке прекращаем (старый кэш не трогаем).
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { stratzRankedQuery, toRankedHero, STRATZ_BRACKET, type StratzHeroStatsResponse } from '@core/knowledge-base/stratz-ranked.ts';
import { parseStatsRanked, type StatsRanked } from '@shared/types/stats-ranked';

export const STRATZ_CACHE_FILE = 'stats-ranked.json';
/** Кэш старше — обновляем (данные STRATZ — за последнюю неделю) */
export const STRATZ_STALE_MS = 3 * 24 * 3600_000;
const GAP_MS = 350;

export type SyncResult = 'no-token' | 'fresh' | 'updated' | 'offline' | 'failed' | 'in-match' | 'patch-mismatch';

export interface StratzSyncDeps {
  cacheDir: string;
  patch: () => string | null;
  heroes: () => { id: number; key: string }[];
  items: () => { id: number; key: string }[];
  inMatch: () => boolean;
  log: (...a: unknown[]) => void;
  fetch?: typeof fetch;
  now?: () => number;
  readToken?: () => string | null;
  sleep?: (ms: number) => Promise<void>;
}

/** Токен владельца с этого ПК; null — нет */
export function readStratzToken(): string | null {
  if (process.env.STRATZ_TOKEN?.trim()) return process.env.STRATZ_TOKEN.trim();
  for (const f of ['.stratz-token', '.stratz-token.txt']) {
    const p = join(homedir(), f);
    if (!existsSync(p)) continue;
    const t = readFileSync(p, 'utf8').replace(/^﻿/, '').trim();
    if (t) return t;
  }
  return null;
}

/** Кэш, если он того же патча; иначе null */
export function readStratzCache(cacheDir: string, patch: string | null): StatsRanked | null {
  const f = join(cacheDir, STRATZ_CACHE_FILE);
  if (!existsSync(f)) return null;
  try {
    return parseStatsRanked(JSON.parse(readFileSync(f, 'utf8')), patch);
  } catch {
    return null;
  }
}

export class StratzSync {
  private running = false;
  constructor(private readonly deps: StratzSyncDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** Обновить кэш, если он старый; возвращает, что произошло (в журнал — без токена) */
  async refreshIfStale(): Promise<SyncResult> {
    if (this.running) return 'fresh';
    const token = (this.deps.readToken ?? readStratzToken)();
    if (!token) return 'no-token';
    const patch = this.deps.patch();
    const file = join(this.deps.cacheDir, STRATZ_CACHE_FILE);
    if (existsSync(file) && readStratzCache(this.deps.cacheDir, patch) && this.now - statSync(file).mtimeMs < STRATZ_STALE_MS) return 'fresh';
    if (this.deps.inMatch()) return 'in-match';
    this.running = true;
    try {
      return await this.refresh(token, patch);
    } finally {
      this.running = false;
    }
  }

  private async gql<T>(token: string, query: string): Promise<T> {
    const f = this.deps.fetch ?? fetch;
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    for (let attempt = 1; ; attempt++) {
      const res = await f('https://api.stratz.com/graphql', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' },
        body: JSON.stringify({ query }),
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) {
        const j = (await res.json()) as { data?: T; errors?: { message: string }[] };
        if (j.errors?.length || !j.data) throw new Error(`STRATZ: ${(j.errors?.[0]?.message ?? 'пустой ответ').replaceAll(token, '<token>')}`);
        return j.data;
      }
      if (attempt >= 3) throw new Error(`STRATZ HTTP ${res.status}`);
      await sleep(res.status === 429 ? 30_000 : 2000 * attempt);
    }
  }

  private async refresh(token: string, patch: string | null): Promise<SyncResult> {
    const sleep = this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
    try {
      const versions = (await this.gql<{ constants: { gameVersions: { name: string }[] } }>(token, '{ constants { gameVersions { id name } } }')).constants.gameVersions;
      if (!patch || versions[0]?.name !== patch) {
        this.deps.log('stratz: патч не совпадает', { stratz: versions[0]?.name ?? null, kb: patch });
        return 'patch-mismatch';
      }
    } catch (e) {
      this.deps.log('stratz: нет связи', String((e as Error).message).slice(0, 120));
      return 'offline';
    }
    const itemKeyById = new Map(this.deps.items().map((i) => [i.id, i.key]));
    const heroes = [];
    let failed = 0;
    for (const h of this.deps.heroes()) {
      // начался матч — останавливаемся: в матче сеть и процессор нужны игре
      if (this.deps.inMatch()) return 'in-match';
      try {
        const d = await this.gql<{ heroStats: StratzHeroStatsResponse }>(token, stratzRankedQuery(h.id));
        heroes.push(toRankedHero(h, d.heroStats, itemKeyById));
      } catch (e) {
        failed++;
        if (failed > 5) {
          this.deps.log('stratz: много ошибок, обновление прервано', String((e as Error).message).slice(0, 120));
          return 'failed';
        }
      }
      await sleep(GAP_MS);
    }
    const file = { schema: 'dota-coach.stats-ranked', version: 1, patch, bracket: STRATZ_BRACKET, generatedAt: new Date(this.now).toISOString(), verification: 'imported-unverified', note: 'Кэш коуча: STRATZ heroStats (рейтинг Divine–Immortal, последняя неделя).', heroes };
    mkdirSync(this.deps.cacheDir, { recursive: true });
    const tmp = join(this.deps.cacheDir, `${STRATZ_CACHE_FILE}.tmp`);
    writeFileSync(tmp, JSON.stringify(file));
    renameSync(tmp, join(this.deps.cacheDir, STRATZ_CACHE_FILE));
    this.deps.log('stratz: кэш обновлён', { heroes: heroes.length, failed });
    return 'updated';
  }
}
