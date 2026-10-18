import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KbHero, KbItem, KbMeta, KnowledgeBase } from '@shared/types/kb';
import { auditItems } from '@core/knowledge-base/audit.ts';
import { selectKbCopy, type KbCopyOrigin } from '@core/knowledge-base/select.ts';
import { parseMechanics } from '@shared/types/mechanics';
import { parseKbStats, type KbStats } from '@shared/types/stats';
import { parseStatsRanked, type StatsRanked } from '@shared/types/stats-ranked';

interface KbCopy {
  origin: KbCopyOrigin;
  base: string;
  patch: string | null;
  generatedAt: string | null;
}

/**
 * Где лежат копии базы знаний:
 *  - asar — внутри app.asar (resources/data/kb): приходит с автообновлением, которое заменяет только app.asar;
 *  - external — рядом с программой (resources\data\kb): кладёт установщик/zip.
 * В режиме разработки обе — одна папка проекта. DOTACOACH_KB_EXTERNAL_DIR подменяет внешнюю копию (для тестов).
 */
function copyLocations(): { origin: KbCopyOrigin; base: string }[] {
  const asar = join(app.getAppPath(), 'resources', 'data', 'kb');
  const external = process.env.DOTACOACH_KB_EXTERNAL_DIR || (app.isPackaged ? join(process.resourcesPath, 'data', 'kb') : null);
  return [{ origin: 'asar', base: asar }, ...(external && external !== asar ? [{ origin: 'external' as const, base: external }] : [])];
}

/** Читает current.json и meta.json копии; ошибка — копия без даты (не будет выбрана) */
function probe(origin: KbCopyOrigin, base: string): KbCopy {
  try {
    const current = JSON.parse(readFileSync(join(base, 'current.json'), 'utf8')) as { patch: string };
    if (!/^[\w.]+$/.test(current.patch)) throw new Error('Некорректное имя патча');
    const meta = JSON.parse(readFileSync(join(base, current.patch, 'meta.json'), 'utf8')) as KbMeta;
    return { origin, base, patch: current.patch, generatedAt: typeof meta.generatedAt === 'string' ? meta.generatedAt : null };
  } catch {
    return { origin, base, patch: null, generatedAt: null };
  }
}

/** Загружает базу знаний текущего патча (один раз, лениво) из более новой из двух копий */
export class KbStore {
  private cache: KnowledgeBase | null = null;
  private error: string | null = null;
  private dir: string | null = null;
  private statsCache: KbStats | null | undefined = undefined;
  private statsTurboCache: KbStats | null | undefined = undefined;

  /**
   * Статистика патча (stats.json) из той же копии базы; null — нет файла или он для другого патча.
   * В интерфейс не отдаётся (≈ 0,5 МБ) — нужна только движку подсказок в main.
   */
  stats(): KbStats | null {
    if (this.statsCache === undefined) this.statsCache = this.readStats('stats.json', 'normal');
    return this.statsCache;
  }

  /** Статистика Турбо (stats-turbo.json) той же копии базы; null — нет файла или он для другого патча */
  statsTurbo(): KbStats | null {
    if (this.statsTurboCache === undefined) this.statsTurboCache = this.readStats('stats-turbo.json', 'turbo');
    return this.statsTurboCache;
  }

  /** Как играют сильные игроки в рейтинге (stats-ranked.json, STRATZ); null — нет файла или он для другого патча */
  statsRanked(): StatsRanked | null {
    if (this.statsRankedCache !== undefined) return this.statsRankedCache;
    const kb = this.get();
    this.statsRankedCache = null;
    if ('error' in kb || !this.dir) return null;
    const file = join(this.dir, 'stats-ranked.json');
    if (!existsSync(file)) return null;
    try {
      this.statsRankedCache = parseStatsRanked(JSON.parse(readFileSync(file, 'utf8')), kb.meta.patch);
    } catch (e) {
      console.warn(`[kb] stats-ranked.json не читается: ${(e as Error).message}`);
    }
    return this.statsRankedCache;
  }
  private statsRankedCache: StatsRanked | null | undefined = undefined;

  private readStats(name: string, mode: 'normal' | 'turbo'): KbStats | null {
    const kb = this.get();
    if ('error' in kb || !this.dir) return null;
    const file = join(this.dir, name);
    if (!existsSync(file)) return null;
    try {
      return parseKbStats(JSON.parse(readFileSync(file, 'utf8')), kb.meta.patch, mode);
    } catch (e) {
      console.warn(`[kb] ${name} не читается: ${(e as Error).message}`);
      return null;
    }
  }

  get(): KnowledgeBase | { error: string } {
    if (this.cache) return this.cache;
    if (this.error) return { error: this.error };
    try {
      const copy = selectKbCopy(copyLocations().map((l) => probe(l.origin, l.base)));
      if (!copy || !copy.patch) throw new Error('нет ни одной читаемой копии');
      const dir = join(copy.base, copy.patch);
      if (!existsSync(dir)) throw new Error(`Нет данных патча ${copy.patch}`);
      const read = <T>(f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
      this.dir = dir;
      const items = read<KbItem[]>('items.json');
      // Механика необязательна: без файла или с плохими записями база всё равно работает
      let mech: ReturnType<typeof parseMechanics> = { file: null, warnings: ['mechanics.json нет в этой копии базы'] };
      if (existsSync(join(dir, 'mechanics.json'))) {
        try {
          mech = parseMechanics(read<unknown>('mechanics.json'));
        } catch (e) {
          mech = { file: null, warnings: [`mechanics.json не читается: ${(e as Error).message}`] };
        }
      }
      for (const w of mech.warnings) console.warn(`[kb] ${w}`);
      this.cache = {
        meta: read<KbMeta>('meta.json'),
        heroes: read<KbHero[]>('heroes.json'),
        items,
        audit: auditItems(items),
        copy: copy.origin,
        mechanics: mech.file?.entries ?? [],
        mechanicsWarnings: mech.warnings,
      };
      return this.cache;
    } catch (e) {
      this.error = `База знаний не загружена: ${(e as Error).message}`;
      return { error: this.error };
    }
  }
}
