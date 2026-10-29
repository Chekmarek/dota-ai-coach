// Мета патча для главной: OpenDota heroStats (сила героев, свежие публичные матчи) и описания патчей Valve
// (изменения героев, на русском). Кэш — <папка данных>/kb-cache/meta: heroStats обновляется не чаще раза
// в META_STALE_MS и только вне матча; описание каждого патча скачивается один раз (оно не меняется).
// Без сети — работаем на кэше; кэша нет — честное «нет данных» с причиной. Ключи и вход не нужны.
// Dotabuff не используется: открытого API у него нет, а автоматический сбор его страниц запрещён его правилами.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildMeta, currentPatchFamily, heroNotes, snapshotOf, trendBase, bracketTotals, type MetaSnapshot, type OdHeroStat, type ValvePatchNotes } from '@core/meta/meta.ts';
import type { KbHero } from '@shared/types/kb';
import type { StatsRanked } from '@shared/types/stats-ranked';
import type { MetaBracket, MetaChangeNote, MetaHeroChanges, MetaPatchInfo, MetaState } from '@shared/types/meta';

export const META_STALE_MS = 6 * 3600_000;
/** Сколько замеров хранить для трендов (раз в 6 часов — около двух недель) */
const HISTORY_KEEP = 60;
const OD_HERO_STATS = 'https://api.opendota.com/api/heroStats';
const VALVE = 'https://www.dota2.com/datafeed';

export interface MetaSyncDeps {
  cacheDir: string;
  heroes: () => KbHero[];
  ranked: () => StatsRanked | null;
  inMatch: () => boolean;
  log: (...a: unknown[]) => void;
  fetch?: typeof fetch;
  now?: () => number;
  /** Сообщить интерфейсу, что данные обновились */
  onChange?: () => void;
}

interface StatsCache {
  at: number;
  stats: OdHeroStat[];
  history: MetaSnapshot[];
}

export class MetaService {
  private refreshing = false;
  private lastError: string | null = null;
  private notes = new Map<string, Map<number, MetaChangeNote[]>>();

  constructor(private readonly deps: MetaSyncDeps) {}

  private get now(): number {
    return (this.deps.now ?? Date.now)();
  }
  private get dir(): string {
    return join(this.deps.cacheDir, 'meta');
  }
  private read<T>(name: string): T | null {
    const f = join(this.dir, name);
    if (!existsSync(f)) return null;
    try {
      return JSON.parse(readFileSync(f, 'utf8')) as T;
    } catch {
      return null;
    }
  }
  private write(name: string, data: unknown): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = join(this.dir, `${name}.tmp`);
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, join(this.dir, name));
  }
  private async json<T>(url: string): Promise<T> {
    const res = await (this.deps.fetch ?? fetch)(url, { headers: { 'User-Agent': 'DotaAICoach-meta' }, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  /** Обновить, если кэш старый (или force); в матче — нет */
  async refreshIfStale(force = false): Promise<'fresh' | 'updated' | 'in-match' | 'offline' | 'busy'> {
    if (this.refreshing) return 'busy';
    const cache = this.read<StatsCache>('hero-stats.json');
    if (!force && cache && this.now - cache.at < META_STALE_MS && this.read('patches.json')) return 'fresh';
    if (this.deps.inMatch()) return 'in-match';
    this.refreshing = true;
    this.deps.onChange?.();
    try {
      const stats = await this.json<OdHeroStat[]>(OD_HERO_STATS);
      if (!Array.isArray(stats) || stats.length < 100) throw new Error('heroStats: мало героев');
      const history = [...(cache?.history ?? []), snapshotOf(stats, this.now)].slice(-HISTORY_KEEP);
      this.write('hero-stats.json', { at: this.now, stats: stats.map(slim), history } satisfies StatsCache);
      // Описания патчей: список версий — каждый раз; сам патч — один раз (не меняется)
      const list = await this.json<{ patches: { patch_number: string; patch_timestamp?: number }[] }>(`${VALVE}/patchnoteslist?language=russian`);
      const family = currentPatchFamily(list.patches ?? []);
      for (const p of family) {
        if (this.deps.inMatch()) break;
        if (this.read(`patch-${p.version}.json`)) continue;
        const notes = await this.json<ValvePatchNotes>(`${VALVE}/patchnotes?version=${encodeURIComponent(p.version)}&language=russian`);
        this.write(`patch-${p.version}.json`, { patch_number: notes.patch_number, patch_timestamp: notes.patch_timestamp, heroes: notes.heroes ?? [] });
      }
      this.write('patches.json', family);
      this.notes.clear();
      this.lastError = null;
      this.deps.log('meta: обновлено', { heroes: stats.length, patches: family.map((p) => p.version) });
      return 'updated';
    } catch (e) {
      this.lastError = (e as Error).message;
      this.deps.log('meta: нет связи', String(this.lastError).slice(0, 120));
      return 'offline';
    } finally {
      this.refreshing = false;
      this.deps.onChange?.();
    }
  }

  private patches(): MetaPatchInfo[] {
    return this.read<MetaPatchInfo[]>('patches.json') ?? [];
  }

  private notesFor(version: string): Map<number, MetaChangeNote[]> {
    let m = this.notes.get(version);
    if (!m) {
      const raw = this.read<ValvePatchNotes>(`patch-${version}.json`);
      m = raw ? heroNotes(raw, this.deps.heroes()) : new Map();
      this.notes.set(version, m);
    }
    return m;
  }

  state(bracket: MetaBracket): MetaState {
    const cache = this.read<StatsCache>('hero-stats.json');
    const patches = this.patches();
    const latest = patches[0]?.version;
    const changed = new Set(latest ? this.notesFor(latest).keys() : []);
    if (!cache) {
      return {
        positions: {},
        bracket,
        statsAt: null,
        positionsFrom: 'roles',
        patches,
        refreshing: this.refreshing,
        note: this.refreshing ? 'Скачиваю статистику героев…' : this.lastError ? `Нет связи с OpenDota (${this.lastError}). Статистика появится, когда будет интернет.` : 'Статистики ещё нет — она скачается в фоне.',
      };
    }
    const meta = buildMeta({ stats: cache.stats, heroes: this.deps.heroes(), ranked: this.deps.ranked(), bracket, base: trendBase(cache.history, this.now), changedInLatest: changed });
    const ageH = Math.round((this.now - cache.at) / 3600_000);
    return {
      positions: meta.positions,
      bracket,
      statsAt: new Date(cache.at).toISOString(),
      positionsFrom: meta.positionsFrom,
      patches,
      refreshing: this.refreshing,
      note: this.lastError && ageH >= 24 ? `Статистика от ${new Date(cache.at).toLocaleDateString('ru-RU')} — обновить не удалось (${this.lastError}).` : null,
    };
  }

  heroChanges(heroKey: string, bracket: MetaBracket): MetaHeroChanges | null {
    const hero = this.deps.heroes().find((h) => h.key === heroKey);
    if (!hero) return null;
    const patches = this.patches().map((p) => ({ ...p, notes: this.notesFor(p.version).get(hero.id) ?? [] }));
    const s = this.read<StatsCache>('hero-stats.json')?.stats.find((x) => x.id === hero.id);
    const [picks, wins] = s ? bracketTotals(s, bracket) : [0, 0];
    return { hero: hero.key, name: hero.name, patches, winrate: picks ? wins / picks : null, picks: picks || null };
  }
}

/** Из heroStats храним только нужное: id и игры/победы по рангам */
function slim(s: OdHeroStat): OdHeroStat {
  const o: OdHeroStat = { id: s.id };
  for (let b = 1; b <= 8; b++) {
    o[`${b}_pick`] = s[`${b}_pick`];
    o[`${b}_win`] = s[`${b}_win`];
  }
  return o;
}
