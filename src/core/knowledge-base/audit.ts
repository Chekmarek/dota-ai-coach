import type { KbAudit, KbItem } from '../../shared/types/kb.ts';

/**
 * Самопроверка предметов: цена собранного предмета должна равняться сумме частей и рецепта.
 * Расхождение не исправляется автоматически — оно показывается как «требует проверки».
 */
export function auditItems(items: KbItem[]): KbAudit {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const audit: KbAudit = { costMismatches: [], unknownComponents: [] };
  for (const it of items) {
    if (!it.components.length || it.cost === null) continue;
    let sum = it.recipeCost ?? 0;
    let complete = true;
    for (const c of it.components) {
      const part = byKey.get(c);
      if (!part || part.cost === null) {
        audit.unknownComponents.push({ key: it.key, component: c });
        complete = false;
        continue;
      }
      sum += part.cost;
    }
    if (complete && sum !== it.cost) audit.costMismatches.push({ key: it.key, name: it.name, cost: it.cost, computed: sum });
  }
  return audit;
}
