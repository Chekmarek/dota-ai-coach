// Тайминги предметов по скачанным матчам STRATZ (src/data/item-timings.json, scripts/build-item-timings.mjs):
// сборка героя в Турбо по реальным матчам Турбо (в STRATZ heroStats Турбо нет) и когда дешёвые ранние предметы
// уходят из 6 ячеек у сильных игроков (продан, убран в рюкзак или собран в другой предмет).
import { z } from 'zod';

const buildItem = z.object({ key: z.string(), share: z.number(), p50: z.number(), p80: z.number() });
export type TimedBuildItem = z.infer<typeof buildItem>;

const modeSchema = z.object({
  matches: z.number(),
  /** Дешёвый ранний предмет → n — у скольких был, p50 — медиана минуты ухода; null — больше половины держат до конца */
  leaves: z.record(z.string(), z.object({ n: z.number(), p50: z.number().nullable() })).catch({}),
  /** Герой → позиция '1'…'5' → матчей и первая покупка больших предметов (минуты игрового времени режима) */
  builds: z.record(z.string(), z.record(z.string(), z.object({ n: z.number(), items: z.array(buildItem) }))).catch({}),
});
export type TimingsMode = z.infer<typeof modeSchema>;

export const itemTimingsSchema = z.object({
  schema: z.literal('dota-coach.item-timings'),
  version: z.literal(1),
  patch: z.string(),
  generatedAt: z.string(),
  normal: modeSchema.nullable().catch(null),
  turbo: modeSchema.nullable().catch(null),
});
export type ItemTimings = z.infer<typeof itemTimingsSchema>;

/** Разбор файла; null — нет файла или чужая схема (тогда коуч советует, как раньше) */
export function parseItemTimings(raw: unknown): ItemTimings | null {
  const r = itemTimingsSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Сборке героя на позиции верим, если матчей не меньше */
export const BUILD_MIN_GAMES = 40;
/** Медиане «когда уходит из инвентаря» верим, если предмет был не меньше чем у стольких игроков */
export const LEAVES_MIN_GAMES = 30;

/** Сборка героя на позиции в режиме по реальным матчам; null — данных нет или матчей мало */
export function timedBuild(mode: TimingsMode | null | undefined, heroKey: string, position: string | null): { n: number; items: TimedBuildItem[] } | null {
  if (!mode || !position) return null;
  const b = mode.builds[heroKey]?.[position];
  return b && b.n >= BUILD_MIN_GAMES ? b : null;
}

/** Минута, к которой сильные игроки обычно убирают ранний предмет из 6 ячеек; null — данных нет или его держат до конца */
export function leavesAt(mode: TimingsMode | null | undefined, key: string): number | null {
  const l = mode?.leaves[key];
  return l && l.n >= LEAVES_MIN_GAMES ? l.p50 : null;
}
