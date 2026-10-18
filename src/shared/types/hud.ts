// Данные для окна подсказок поверх игры (этап 3). Проверяются zod на каждом переходе между процессами.
import { z } from 'zod';
import { HUD_ZONE_IDS, zoneOverridesSchema } from '../../core/hud/layout.ts';

export const HUD_THEME_IDS = ['runes', 'obsidian'] as const;
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
  /** Зоны, которые пользователь скрыл (старое состояние без поля — ничего не скрыто) */
  hiddenZones: z.array(z.enum(HUD_ZONE_IDS)).max(HUD_ZONE_IDS.length).catch([]).default([]),
});
export type HudOptions = z.infer<typeof hudOptionsSchema>;

/** Сколько на экране индикатор режима игры — поверх игры и в окне коуча */
export const MODE_BANNER_MS = 5000;

/** Индикатор режима игры (0.13.3): крупная плашка в начале матча и при смене режима — «включён Турбо» */
export const modeBannerSchema = z
  .object({
    /** Номер показа: новый номер — новая анимация появления */
    seq: z.number().int().nonnegative(),
    mode: z.enum(['all-pick', 'turbo', 'other', 'unknown']),
    source: z.enum(['gsi', 'clock', 'custom-game', 'manual', 'none']),
    title: text(40),
    text: text(160),
  })
  .strict();
export type ModeBanner = z.infer<typeof modeBannerSchema>;

export const hudStateSchema = z.object({
  hints: z.array(hudHintSchema).max(12),
  options: hudOptionsSchema,
  /** Индикатор режима; null — не показывать (старое состояние без поля — тоже null) */
  mode: modeBannerSchema.nullable().catch(null).default(null),
});
export type HudState = z.infer<typeof hudStateSchema>;

export const DEFAULT_HUD_OPTIONS: HudOptions = { theme: 'runes', reduceMotion: false, opacity: 1, scale: 1, zones: null, hiddenZones: [] };
