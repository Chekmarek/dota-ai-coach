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
        /** Итог фокуса матча — первым в разборе матча (с 0.19; в старом состоянии поля нет) */
        focus: z
          .object({
            title: text(80),
            /** null — не удалось измерить */
            achieved: z.boolean().nullable(),
            value: text(30),
            target: text(30),
            /** «в среднем 2,4» — ваше среднее за прошлые матчи; null — мало матчей */
            avg: text(60).nullable(),
            keep: text(200),
          })
          .nullable()
          .optional(),
        /** Первые 10 с — только итог фокуса, потом обычный разбор под ним */
        focusOnly: z.boolean().optional(),
        /** Опыт за матч и за что (с 0.20; только за улучшение) */
        xp: z
          .object({
            total: z.number().int().min(0).max(10_000),
            items: z.array(z.object({ label: text(160), xp: z.number().int().min(0).max(1000) })).max(8),
            /** Звание после матча: «Рыцарь ★3» */
            level: text(40),
            levelUp: z.boolean(),
            achievements: z.array(text(60)).max(4),
          })
          .nullable()
          .optional(),
      })
      .nullable(),
  })
  .strict();
export type HudHint = z.infer<typeof hudHintSchema>;

/** Счётчик фокуса матча поверх игры: маленькая плашка в постоянном месте */
export const hudFocusSchema = z
  .object({
    /** «Смерти», «Добивания», «С TP» */
    label: text(40),
    /** «1/1», «23/45», «96%» */
    progress: text(20),
    state: z.enum(['pending', 'achieved', 'failed', 'unknown']),
  })
  .strict();
export type HudFocus = z.infer<typeof hudFocusSchema>;

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
    source: z.enum(['gsi', 'clock', 'pace', 'custom-game', 'manual', 'none']),
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
  /** Счётчик фокуса матча; null — нет (старое состояние без поля — тоже null) */
  focus: hudFocusSchema.nullable().catch(null).default(null),
});
export type HudState = z.infer<typeof hudStateSchema>;

export const DEFAULT_HUD_OPTIONS: HudOptions = { theme: 'runes', reduceMotion: false, opacity: 1, scale: 1, zones: null, hiddenZones: [] };
