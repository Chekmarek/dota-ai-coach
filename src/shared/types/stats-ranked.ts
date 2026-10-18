// Как играют сильные игроки в рейтинге (resources/data/kb/<патч>/stats-ranked.json, scripts/import-stratz.mjs):
// STRATZ, ранги Divine–Immortal, последняя неделя. Терпимая схема: испорченная запись героя отбрасывается.
import { z } from 'zod';

/** Порядок чисел в точке кривой рейтинга (средние по матчам) */
export const RANKED_FIELDS = ['lh', 'networth', 'xp', 'level'] as const;

const curve = z.object({ n: z.number(), at: z.record(z.string(), z.array(z.number()).length(RANKED_FIELDS.length)) });
const item = z.object({ key: z.string(), share: z.number(), medianMin: z.number(), winrate: z.number() });

export const rankedHeroSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  /** Позиция '1'…'5' → матчей на позиции за неделю */
  matches: z.record(z.string(), z.number()).catch({}),
  /** Позиция → кривая по минутам 5, 10 … 40 */
  curves: z.record(z.string(), curve).catch({}),
  /** Позиция → предметы по медианной минуте покупки */
  items: z.record(z.string(), z.array(item)).catch({}),
});
export type RankedHero = z.infer<typeof rankedHeroSchema>;

export const statsRankedSchema = z.object({
  schema: z.literal('dota-coach.stats-ranked'),
  version: z.literal(1),
  patch: z.string(),
  bracket: z.string(),
  generatedAt: z.string(),
  heroes: z.array(z.unknown()).transform((arr) =>
    arr.flatMap((h) => {
      const r = rankedHeroSchema.safeParse(h);
      return r.success ? [r.data] : [];
    }),
  ),
});
export type StatsRanked = z.infer<typeof statsRankedSchema>;

/** Разбор stats-ranked.json; null — файла нет, другой патч или схема */
export function parseStatsRanked(raw: unknown, expectedPatch: string | null): StatsRanked | null {
  const r = statsRankedSchema.safeParse(raw);
  if (!r.success) return null;
  if (expectedPatch !== null && r.data.patch !== expectedPatch) return null;
  return r.data;
}
