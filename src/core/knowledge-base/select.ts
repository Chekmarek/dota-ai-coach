/**
 * Выбор копии базы знаний.
 * Копий две: внутри app.asar (приходит с обновлением приложения) и рядом с программой — resources\data
 * (кладёт установщик). Берём более новую по meta.generatedAt; при равенстве — копию из app.asar.
 * Копия, которую не удалось прочитать или у которой нет даты, не выбирается.
 */
export type KbCopyOrigin = 'asar' | 'external';

export interface KbCopyCandidate {
  origin: KbCopyOrigin;
  /** meta.generatedAt; null — копии нет или её не удалось прочитать */
  generatedAt: string | null;
}

export function selectKbCopy<T extends KbCopyCandidate>(candidates: readonly T[]): T | null {
  let best: { c: T; at: number } | null = null;
  for (const c of candidates) {
    if (!c.generatedAt) continue;
    const at = Date.parse(c.generatedAt);
    if (!Number.isFinite(at)) continue;
    if (!best || at > best.at || (at === best.at && c.origin === 'asar' && best.c.origin !== 'asar')) best = { c, at };
  }
  return best?.c ?? null;
}
