// Данные для окна подсказок поверх игры (этап 3). Проверяются zod на каждом переходе между процессами.
import { z } from 'zod';
import { HUD_ZONE_IDS, zoneOverridesSchema } from '../../core/hud/layout.ts';

export const HUD_THEME_IDS = ['arcane', 'void'] as const;
export type HudThemeId = (typeof HUD_THEME_IDS)[number];

const text = (n: number) => z.string().max(n);

export const hudHintSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    zone: z.enum(HUD_ZONE_IDS),
    priority: z.enum(['critical', 'advice', 'info']),
    category: z.enum(['fight', 'danger', 'laning', 'economy', 'macro', 'timing', 'mistake', 'review']),
    /** Короткий текст (≤ 8 слов) */
    title: text(120),
    /** Текст по выбранной подробности; пусто — режим «Минимум» */
    text: text(600),
    percent: z
      .object({
        label: text(40),
        value: z.number().min(0).max(100),
        /** Уверенность оценки, 0…1 */
        confidence: z.number().min(0).max(1),
        /** Факторы — только в режиме «Подробно» */
        factors: z.array(z.object({ label: text(60), effect: z.number().min(-100).max(100) })).max(12),
      })
      .nullable(),
    /** Иконка: hero:<ключ>, item:<ключ> — пока как подпись (картинки — позже) */
    icon: text(80).nullable(),
    source: z.enum(['template', 'ai']),
    ttlMs: z.number().int().min(0).max(3_600_000),
    review: z
      .object({
        kind: z.enum(['death', 'match']),
        heading: text(80),
        why: z.array(text(200)).max(6),
        tips: z.array(text(200)).max(4),
        footer: text(200).nullable(),
        stats: z.array(z.object({ label: text(60), value: text(30), ref: text(30).nullable(), verdict: z.enum(['good', 'ok', 'bad']).nullable() })).max(10),
        aiText: text(1500).nullable(),
      })
      .nullable(),
  })
  .strict();
export type HudHint = z.infer<typeof hudHintSchema>;

export const hudOptionsSchema = z.object({
  theme: z.enum(HUD_THEME_IDS),
  reduceMotion: z.boolean(),
  /** Непрозрачность карточек 0.4…1 */
  opacity: z.number().min(0.4).max(1),
  /** Размер карточек 0.8…1.4 */
  scale: z.number().min(0.8).max(1.4),
  zones: zoneOverridesSchema.nullable(),
});
export type HudOptions = z.infer<typeof hudOptionsSchema>;

export const hudStateSchema = z.object({
  hints: z.array(hudHintSchema).max(12),
  options: hudOptionsSchema,
});
export type HudState = z.infer<typeof hudStateSchema>;

export const DEFAULT_HUD_OPTIONS: HudOptions = { theme: 'arcane', reduceMotion: false, opacity: 1, scale: 1, zones: null };
