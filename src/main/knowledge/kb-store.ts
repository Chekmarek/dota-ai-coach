import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KbHero, KbItem, KbMeta, KnowledgeBase } from '@shared/types/kb';
import { auditItems } from '@core/knowledge-base/audit.ts';
import { resourcePath } from '../application/paths';

/** Загружает базу знаний текущего патча из resources/data/kb (один раз, лениво) */
export class KbStore {
  private cache: KnowledgeBase | null = null;
  private error: string | null = null;

  get(): KnowledgeBase | { error: string } {
    if (this.cache) return this.cache;
    if (this.error) return { error: this.error };
    try {
      const base = resourcePath('data', 'kb');
      const current = JSON.parse(readFileSync(join(base, 'current.json'), 'utf8')) as { patch: string };
      if (!/^[\w.]+$/.test(current.patch)) throw new Error('Некорректное имя патча');
      const dir = join(base, current.patch);
      if (!existsSync(dir)) throw new Error(`Нет данных патча ${current.patch}`);
      const read = <T>(f: string) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as T;
      const items = read<KbItem[]>('items.json');
      this.cache = { meta: read<KbMeta>('meta.json'), heroes: read<KbHero[]>('heroes.json'), items, audit: auditItems(items) };
      return this.cache;
    } catch (e) {
      this.error = `База знаний не загружена: ${(e as Error).message}`;
      return { error: this.error };
    }
  }
}
