// Статистика текущего патча (resources/data/kb/<патч>/stats.json, scripts/import-stats.mjs).
// Терпимая схема: испорченная запись героя отбрасывается, остальные читаются.
import { z } from 'zod';

const pct = z.object({ p50: z.number().nullable(), p80: z.number().nullable() }).nullable().catch(null);

export const heroStatsSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  /** Публичные рейтинговые матчи патча; null — нет данных */
  pub: z.object({ games: z.number(), winrate: z.number() }).nullable().catch(null),
  /** id врага → [игр, доля побед героя против него] */
  matchups: z.record(z.string(), z.tuple([z.number(), z.number()])).catch({}),
  /** Профессиональные матчи патча */
  pro: z
    .object({
      games: z.number(),
      winrate: z.number(),
      build: z.array(z.object({ key: z.string(), share: z.number(), medianMin: z.number() })),
      startItems: z.array(z.object({ key: z.string(), share: z.number() })),
      /** Порядок навыков по уровням 1…18: ключ способности или 'talent' */
      skills: z.array(z.object({ key: z.string(), share: z.number() }).nullable()),
      /** lane_role OpenDota (1 — лёгкая, 2 — центр, 3 — сложная, 4 — лес) → медиана добиваний к 10:00 */
      lhAt10: z.record(z.string(), z.object({ median: z.number(), n: z.number() })),
    })
    .nullable()
    .catch(null),
  bench: z.object({ gpm: pct, xpm: pct, lhPerMin: pct }).nullable().catch(null),
});

export type HeroStats = z.infer<typeof heroStatsSchema>;

export const kbStatsSchema = z.object({
  schema: z.literal('dota-coach.kb-stats'),
  version: z.literal(1),
  patch: z.string(),
  patchStart: z.string(),
  generatedAt: z.string(),
  verification: z.string(),
  heroes: z.array(z.unknown()).transform((arr) =>
    arr.flatMap((h) => {
      const r = heroStatsSchema.safeParse(h);
      return r.success ? [r.data] : [];
    }),
  ),
});

export type KbStats = z.infer<typeof kbStatsSchema>;

/** Разбор stats.json; null — файла нет, другой патч или не та схема */
export function parseKbStats(raw: unknown, expectedPatch: string | null): KbStats | null {
  const r = kbStatsSchema.safeParse(raw);
  if (!r.success) return null;
  if (expectedPatch !== null && r.data.patch !== expectedPatch) return null;
  return r.data;
}
