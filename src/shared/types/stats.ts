// Статистика текущего патча (resources/data/kb/<патч>/stats.json, scripts/import-stats.mjs).
// Терпимая схема: испорченная запись героя отбрасывается, остальные читаются.
import { z } from 'zod';

const pct = z.object({ p50: z.number().nullable(), p80: z.number().nullable() }).nullable().catch(null);

const popularList = z.array(z.object({ key: z.string(), count: z.number() }));

/** Минуты кривых профи */
export const CURVE_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40] as const;
/** Порядок чисел в точке кривой */
export const CURVE_FIELDS = ['lh50', 'lh75', 'gold50', 'gold75', 'xp50', 'xp75'] as const;
const curveSchema = z.object({ n: z.number(), at: z.record(z.string(), z.array(z.number().nullable()).length(CURVE_FIELDS.length)) });
export type HeroCurve = z.infer<typeof curveSchema>;

export const heroStatsSchema = z.object({
  id: z.number().int(),
  key: z.string(),
  /** Публичные рейтинговые матчи патча; null — нет данных */
  pub: z.object({ games: z.number(), winrate: z.number() }).nullable().catch(null),
  /** id врага → [игр, доля побед героя против него] */
  matchups: z.record(z.string(), z.tuple([z.number(), z.number()])).catch({}),
  /** id союзника → [игр в одной команде, доля побед пары] (для драфта); старые stats.json — пусто */
  synergy: z.record(z.string(), z.tuple([z.number(), z.number()])).catch({}),
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
      /** Доли позиций 1…5 (место по GPM в команде); null — нет данных */
      positions: z.array(z.number()).length(5).nullable().catch(null),
      /**
       * Как играют профи на этом герое по минутам (этап 3 «понимания игры»): позиция '1'…'5' или 'all' →
       * число игроков и для минут 5, 10, 15 … — [добивания p50, p75, золото p50, p75, опыт p50, p75] (золото и опыт —
       * заработанные к этой минуте, OpenDota gold_t / xp_t). В старых stats.json поля нет — {}.
       */
      curves: z.record(z.string(), curveSchema).catch({}),
    })
    .nullable()
    .catch(null),
  /** Запасная сборка для редких в профи героев: популярные предметы по фазам игры (OpenDota, не только этот патч) */
  popular: z
    .object({ start: popularList, early: popularList, mid: popularList, late: popularList })
    .nullable()
    .catch(null),
  bench: z.object({ gpm: pct, xpm: pct, lhPerMin: pct }).nullable().catch(null),
});

export type HeroStats = z.infer<typeof heroStatsSchema>;

export const kbStatsSchema = z.object({
  schema: z.literal('dota-coach.kb-stats'),
  version: z.literal(1),
  /** turbo — stats-turbo.json (публичные матчи Турбо: только матчапы, связки, доля побед); нет поля — обычная статистика */
  mode: z.literal('turbo').optional(),
  patch: z.string(),
  patchStart: z.string(),
  generatedAt: z.string(),
  verification: z.string(),
  /** Откуда и сколько матчей (scripts/import-stats.mjs); старые файлы — без поля */
  sources: z.array(z.object({ name: z.string(), covers: z.array(z.string()), matches: z.number().optional() }).passthrough()).optional().catch(undefined),
  heroes: z.array(z.unknown()).transform((arr) =>
    arr.flatMap((h) => {
      const r = heroStatsSchema.safeParse(h);
      return r.success ? [r.data] : [];
    }),
  ),
});

export type KbStats = z.infer<typeof kbStatsSchema>;

/** Разбор stats.json (или stats-turbo.json при mode = 'turbo'); null — файла нет, другой патч, режим или схема */
export function parseKbStats(raw: unknown, expectedPatch: string | null, mode: 'normal' | 'turbo' = 'normal'): KbStats | null {
  const r = kbStatsSchema.safeParse(raw);
  if (!r.success) return null;
  if (expectedPatch !== null && r.data.patch !== expectedPatch) return null;
  if ((r.data.mode ?? 'normal') !== mode) return null;
  return r.data;
}

/** Сколько матчей в статистике матчапов (по источникам файла); null — не указано */
export function statsMatches(s: KbStats | null): number | null {
  const m = s?.sources?.find((x) => x.covers.includes('matchups'))?.matches;
  return typeof m === 'number' ? m : null;
}
