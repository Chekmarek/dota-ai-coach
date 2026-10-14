import type { KbAudit, KbItem } from '../../shared/types/kb.ts';

/** Предмет участвует в самопроверке, только если его можно купить или собрать в магазине */
export const isShopItem = (it: KbItem): boolean => (it.availability ?? 'shop') === 'shop';

/**
 * Самопроверка предметов: цена собранного предмета должна равняться сумме частей и рецепта.
 * Расхождение не исправляется автоматически — оно показывается как «требует проверки».
 * Предметы не из магазина (нейтральные, убранные из игры, добыча) не проверяются: у них цена 0 по определению.
 */
export function auditItems(items: KbItem[]): KbAudit {
  const byKey = new Map(items.map((i) => [i.key, i]));
  const audit: KbAudit = { costMismatches: [], unknownComponents: [] };
  for (const it of items) {
    if (!it.components.length || it.cost === null || !isShopItem(it)) continue;
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
    if (complete && sum !== it.cost) {
      audit.costMismatches.push({ key: it.key, name: it.name, cost: it.cost, computed: sum, ...(it.priceNote ? { reason: it.priceNote } : {}) });
    }
  }
  return audit;
}
