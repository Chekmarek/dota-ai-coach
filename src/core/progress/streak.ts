// Серия: матчи подряд с выполненным фокусом. Один промах не обнуляет её, если есть щит: щит срабатывает не чаще
// раза в SHIELD_EVERY матчей с фокусом (промах «съедает» щит, серия сохраняется, но не растёт). Матчи без фокуса
// или где фокус не удалось измерить — пропускаются (не рвут и не продлевают). Чистое ядро.
import type { MatchRecord } from './types.ts';

export const SHIELD_EVERY = 5;

export interface StreakInfo {
  current: number;
  best: number;
  /** Щит готов (следующий промах серию не оборвёт) */
  shieldReady: boolean;
  /** Сколько матчей с фокусом осталось до нового щита (0 — готов) */
  shieldIn: number;
}

export function streakOf(records: readonly MatchRecord[]): StreakInfo {
  let current = 0;
  let best = 0;
  let n = 0;
  let shieldUsedAt = -Infinity;
  for (const r of records) {
    const a = r.focus?.achieved;
    if (a !== true && a !== false) continue;
    n++;
    if (a) current++;
    else if (current > 0 && n - shieldUsedAt >= SHIELD_EVERY) shieldUsedAt = n;
    else current = 0;
    best = Math.max(best, current);
  }
  // следующий матч будет n + 1: щит сработает, если с прошлого прошло не меньше SHIELD_EVERY
  const since = n + 1 - shieldUsedAt;
  return { current, best, shieldReady: since >= SHIELD_EVERY, shieldIn: since >= SHIELD_EVERY ? 0 : SHIELD_EVERY - since };
}
