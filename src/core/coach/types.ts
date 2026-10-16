// Типы движка подсказок (этап 2). Чистое ядро: без Electron, DOM, сети и файлов; время передаётся снаружи.

/** Категории подсказок; каждую можно выключить в настройках */
export const HINT_CATEGORIES = ['fight', 'danger', 'laning', 'economy', 'macro', 'timing', 'mistake', 'review'] as const;
export type HintCategory = (typeof HINT_CATEGORIES)[number];

export const HINT_CATEGORY_RU: Record<HintCategory, string> = {
  fight: 'Драки и решения',
  danger: 'Опасность',
  laning: 'Линия',
  economy: 'Фарм и экономика',
  macro: 'Макро и цели',
  timing: 'Тайминги',
  mistake: 'Ошибки',
  review: 'Разборы',
};

export type HintPriority = 'critical' | 'advice' | 'info';
export const PRIORITY_RANK: Record<HintPriority, number> = { critical: 3, advice: 2, info: 1 };

/**
 * Зоны вывода (расстановка — в layout оверлея, этап 3):
 * alert — под верхней панелью по центру (драка, опасность);
 * decision — правый край по центру (решения с %);
 * timing — левый край над мини-картой (тайминги, напоминания);
 * review — большая панель (разбор после смерти и матча).
 */
export const HINT_ZONES = ['alert', 'decision', 'timing', 'review'] as const;
export type HintZone = (typeof HINT_ZONES)[number];

export const DETAIL_LEVELS = ['min', 'normal', 'detailed'] as const;
export type DetailLevel = (typeof DETAIL_LEVELS)[number];

/** Откуда факт: gsi — данные игры, screen — зрение, derived — вычислено коучем, kb — база знаний, stats — статистика патча */
export type FactSource = 'gsi' | 'screen' | 'derived' | 'kb' | 'stats';

/** Факт, на котором построена подсказка */
export interface FactRef {
  key: string;
  /** Подпись по-русски: «Здоровье», «Врагов пропало» */
  label: string;
  value: string | number | boolean | null;
  source: FactSource;
  /** Секунд с последнего подтверждения; null — не применимо (база знаний) */
  ageSec: number | null;
  /** 0…1 */
  confidence: number;
  /** false — данные не сверены вручную («не проверено») */
  verified: boolean;
}

/** Фактор процента: как он сдвинул оценку (процентные пункты) */
export interface PercentFactor {
  id: string;
  label: string;
  /** Вклад в процентных пунктах (+ за, − против); 0 — фактор неизвестен */
  effect: number;
  known: boolean;
}

export interface PercentEstimate {
  /** 0…100 (ограничено 5…95: уверенности 0 и 100 не бывает) */
  value: number;
  /** Насколько оценка опирается на известные данные, 0…1 */
  confidence: number;
  factors: PercentFactor[];
  /** false — уверенность ниже порога: процент не показывать */
  showable: boolean;
}

/** Подсказка от правила (до очереди) */
export interface HintDraft {
  /** Ключ для слияния повторов и кулдауна: ruleId или ruleId:объект */
  id: string;
  ruleId: string;
  category: HintCategory;
  priority: HintPriority;
  /** 0…1 — общая уверенность подсказки */
  confidence: number;
  /** Не больше 8 слов */
  short: string;
  /** Текст для «Обычный» и «Подробно» (в «Минимум» — только short) */
  detail: { normal: string; detailed: string };
  percent?: { label: string; estimate: PercentEstimate } | null;
  facts: FactRef[];
  ttlMs: number;
  /** Через сколько мс та же подсказка (id) может прийти снова */
  cooldownMs: number;
  zone?: HintZone;
  /** Ключ иконки: герой (hero:antimage), предмет (item:bkb) или способность */
  icon?: string | null;
}

/** Подсказка в очереди */
export interface Hint extends HintDraft {
  zone: HintZone;
  /** Уникальный номер показа */
  seq: number;
  createdWallMs: number;
  expiresWallMs: number;
  clock: number | null;
  textSource: 'template' | 'ai';
}

export const DEFAULT_ZONE: Record<HintCategory, HintZone> = {
  fight: 'decision',
  danger: 'alert',
  laning: 'decision',
  economy: 'timing',
  macro: 'decision',
  timing: 'timing',
  mistake: 'timing',
  review: 'review',
};

export interface CoachSettings {
  detail: DetailLevel;
  categories: Record<HintCategory, boolean>;
  /** Минимальная уверенность для показа подсказки по важности */
  minConfidence: Record<HintPriority, number>;
  /** Показывать % только при уверенности оценки не ниже */
  minPercentConfidence: number;
  /** Подсказки ИИ во время матча */
  aiLive: boolean;
}

export function defaultCoachSettings(): CoachSettings {
  return {
    detail: 'normal',
    categories: Object.fromEntries(HINT_CATEGORIES.map((c) => [c, true])) as Record<HintCategory, boolean>,
    minConfidence: { critical: 0.45, advice: 0.5, info: 0.55 },
    minPercentConfidence: 0.55,
    aiLive: true,
  };
}

/** Текст подсказки для уровня подробности */
export function hintText(h: Pick<HintDraft, 'short' | 'detail'>, level: DetailLevel): string {
  if (level === 'min') return h.short;
  return level === 'detailed' ? h.detail.detailed : h.detail.normal;
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
