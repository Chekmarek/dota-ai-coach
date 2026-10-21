// Сборка от положения в матче (DECISIONS.md п. 79): src/data/item-situations.json (scripts/build-item-situations.mjs).
// В файле — только предметы, разница по которым прошла строгий отбор на одной части матчей и подтвердилась на
// отложенной. Положение — по счёту убийств: его коуч видит в игре, и тот же признак считается по матчам STRATZ.
import { z } from 'zod';

export type MatchSituation = 'behind' | 'ahead' | 'even';

/** Пока убийств меньше — положение не оцениваем (первые минуты решает линия, а не счёт) */
export const SITUATION_MIN_KILLS = 6;

/**
 * Положение команды по счёту убийств: отстаёт/ведёт, если разница не меньше 4 и не меньше 20% всех убийств
 * (10:14 — «ровно», 6:14 — «отстаём»); null — убийств мало или счёт неизвестен. Одно убийство разницы — всегда «ровно».
 */
export function killSituation(own: number | null, enemy: number | null): MatchSituation | null {
  if (own === null || enemy === null) return null;
  const total = own + enemy;
  if (total < SITUATION_MIN_KILLS) return null;
  const need = Math.max(4, 0.2 * total);
  const lead = own - enemy;
  return lead <= -need ? 'behind' : lead >= need ? 'ahead' : 'even';
}

const pick = z.object({
  key: z.string(),
  sit: z.enum(['behind', 'ahead']),
  /** Доля в своём положении и в противоположном (поиск), матчей в каждом */
  share: z.number(),
  other: z.number(),
  n: z.number(),
  nOther: z.number(),
  /** То же на отложенных матчах (подтверждение) */
  holdout: z.object({ share: z.number(), other: z.number(), n: z.number(), nOther: z.number() }),
  /** 'games' — доля матчей с покупкой; 'purchases' — доля среди всех покупок (для «ведём»: при перевесе больше золота) */
  measure: z.enum(['games', 'purchases']),
});
export type SituationPick = z.infer<typeof pick>;

export const itemSituationsSchema = z.object({
  schema: z.literal('dota-coach.item-situations'),
  version: z.literal(1),
  generatedAt: z.string(),
  refMin: z.number(),
  windowMin: z.number(),
  /** Герой → позиция '1'…'5' → подтверждённые предметы */
  items: z.record(z.string(), z.record(z.string(), z.array(pick))).catch({}),
});
export type ItemSituations = z.infer<typeof itemSituationsSchema>;

export function parseItemSituations(raw: unknown): ItemSituations | null {
  const r = itemSituationsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Положение должно держаться столько секунд, прежде чем сборка сменит ветку (не от одного убийства и не скачет) */
export const SITUATION_STABLE_SEC = 90;

/**
 * Устойчивое положение: то же значение killSituation не меньше SITUATION_STABLE_SEC. marks — память коуча на матч
 * (последнее положение и с какого момента). Возвращает положение, если оно устойчиво, иначе null.
 */
export function stableSituation(marks: Map<string, number>, now: number, sit: MatchSituation | null): MatchSituation | null {
  const code = sit === 'behind' ? 1 : sit === 'ahead' ? 2 : sit === 'even' ? 3 : 0;
  if (marks.get('sit') !== code) {
    marks.set('sit', code);
    marks.set('sit@', now);
    return null;
  }
  if (!code || now - (marks.get('sit@') ?? now) < SITUATION_STABLE_SEC * 1000) return null;
  return sit;
}

/** Подтверждённые предметы героя на позиции для положения (по убыванию разницы) */
export function situationPicks(data: ItemSituations | null | undefined, heroKey: string, position: string | null, sit: MatchSituation | null): SituationPick[] {
  if (!data || !position || (sit !== 'behind' && sit !== 'ahead')) return [];
  return (data.items[heroKey]?.[position] ?? []).filter((p) => p.sit === sit).sort((a, b) => b.share - b.other - (a.share - a.other));
}
