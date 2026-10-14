import { app } from 'electron';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KbHero, KbItem, KbMeta, KnowledgeBase } from '@shared/types/kb';
import { auditItems } from '@core/knowledge-base/audit.ts';
import { selectKbCopy, type KbCopyOrigin } from '@core/knowledge-base/select.ts';

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

  get(): KnowledgeBase | { error: string } {
    if (this.cache) return this.cache;
    if (this.error) return { error: this.error };
    try {
      const copy = selectKbCopy(copyLocations().map((l) => probe(l.origin, l.base)));
      if (!copy || !copy.patch) throw new Error('нет ни одной читаемой копии');
      const dir = join(copy.base, copy.patch);
      if (!existsSync(dir)) throw new Error(`Нет данных патча ${copy.patch}`);
      const read = <T>(f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
      const items = read<KbItem[]>('items.json');
      this.cache = {
        meta: read<KbMeta>('meta.json'),
        heroes: read<KbHero[]>('heroes.json'),
        items,
        audit: auditItems(items),
        copy: copy.origin,
      };
      return this.cache;
    } catch (e) {
      this.error = `База знаний не загружена: ${(e as Error).message}`;
      return { error: this.error };
    }
  }
}
