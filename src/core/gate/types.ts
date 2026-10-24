// Фильтр внимания (attention gate): контракт подсказки, настройки, сигналы обстановки и решения.
// Отдельный слой между генераторами подсказок (правила, ошибки, ИИ) и выводом (окно поверх игры, звук, голос).
// Генераторы не меняются: они отдают HintDraft, фильтр решает, что, когда и как коротко показать.
// Чистое ядро: без Electron, DOM, сети и файлов; ничего не знает о захвате экрана — только абстрактные сигналы.
import type { HintCategory, HintDraft, HintZone } from '../coach/types.ts';

/** Важность в фильтре: critical — срочно (проходит всегда), useful — полезно, info — к сведению */
export type GatePriority = 'critical' | 'useful' | 'info';
export const GATE_PRIORITY_RANK: Record<GatePriority, number> = { critical: 3, useful: 2, info: 1 };

/** Подсказка в фильтре — расширенный контракт (старые поля HintDraft сохраняются в source) */
export interface GateHint {
  /** Ключ показа: id генератора + короткая фраза (смена смысла «Вступай» → «Не вступай» — новая подсказка) */
  key: string;
  id: string;
  /** Тип подсказки (ruleId генератора): по нему кулдауны, «не нужно» и метрики */
  type: string;
  category: HintCategory;
  priority: GatePriority;
  confidence: number;
  /** ≤ 3 слов, повелительно: «Отходи», «Помоги команде» (название предмета или героя — одно слово) */
  short: string;
  /** Фраза для голоса (≤ 5 слов) или null — только срочные */
  voice: string | null;
  /** Один конкретный факт с числом из данных подсказки («шанс 34%», «Здоровье 29%»); null — числа нет */
  reason: string | null;
  /** Полное объяснение — только в спокойные моменты и в разборах */
  details: string;
  /** Когда подсказка устаревает, мс (время стены) */
  expiresAt: number;
  zone: HintZone;
  icon: string | null;
  /** Повторяющаяся: генератор подтверждает её, пока ситуация есть (cooldownMs > 0); иначе — разовое событие */
  repeating: boolean;
  /** Исходная подсказка генератора */
  source: HintDraft;
}

/** Необязательные поля, которые генератор может задать сам (иначе фильтр выводит их из подсказки) */
export type GateFields = NonNullable<HintDraft['gate']>;

export interface GateConfig {
  /** Не больше одной несрочной подсказки за столько мс */
  budgetMs: number;
  /** Тот же тип несрочной подсказки — не чаще (мс); свои значения (и для срочных) — в typeCooldownMs */
  defaultTypeCooldownMs: number;
  typeCooldownMs: Record<string, number>;
  /** Срочная подсказка того же типа — не чаще (мс), если в typeCooldownMs нет своего */
  criticalCooldownMs: number;
  /** Ниже этой уверенности подсказка не показывается в игре — уходит в разбор матча */
  minConfidence: number;
  /** Та же короткая фраза — не чаще (мс) */
  repeatTextMs: number;
  /** Сколько подсказка может ждать спокойного момента (мс) */
  maxWaitMs: number;
  /** Повторяющаяся подсказка без подтверждения генератором дольше этого — устарела (мс) */
  staleMs: number;
  /** Сколько на экране несрочная подсказка (мс): не меньше и не больше */
  minShowMs: number;
  maxShowMs: number;
  /** Пауза после напряжения, после которой момент считается спокойным (мс) */
  quietAfterMs: number;
  /** Сколько держится «драка» после последнего признака (мс) */
  stressHoldMs: number;
  /** Сколько подсказок одновременно на экране */
  maxVisible: number;
  /** Сколько матчей с «не нужно» понижают тип до info */
  demoteAfterMutes: number;
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  budgetMs: 50_000,
  defaultTypeCooldownMs: 180_000,
  // «Бьют здание» срочное, но при осаде процент падает каждые секунды — напоминать раз в минуту
  typeCooldownMs: { 'danger.building': 60_000 },
  criticalCooldownMs: 10_000,
  minConfidence: 0.6,
  repeatTextMs: 180_000,
  maxWaitMs: 90_000,
  staleMs: 3000,
  minShowMs: 4000,
  maxShowMs: 8000,
  quietAfterMs: 6000,
  stressHoldMs: 5000,
  maxVisible: 2,
  demoteAfterMutes: 3,
};

/**
 * Сигналы обстановки на тик. Источники разные (данные игры GSI и зрение), фильтру всё равно откуда:
 * null — значение не известно (нет зрения или нет данных игры), тогда признак просто не участвует.
 */
export interface GateSignals {
  nowMs: number;
  matchId: string | null;
  inGame: boolean;
  paused: boolean;
  /** До горна (выбор героев, подготовка) */
  preGame: boolean;
  alive: boolean | null;
  /** Здоровье, % */
  hpPct: number | null;
  /** Оглушён, заглушён или превращён (GSI) */
  disabled: boolean | null;
  /** Перезарядки способностей (порядок постоянный): переход 0 → >0 — способность нажата */
  abilityCooldowns: (number | null)[] | null;
  /** Врагов в ~2000 ед. и вплотную (~1200 ед.) — по зрению; null — не известно */
  enemiesNear: number | null;
  enemiesClose: number | null;
  /** Драка по зрению (враги вплотную, память коуча) */
  visionFight: boolean | null;
  /** На своей базе (фонтан, магазин) */
  atBase: boolean | null;
  /** Расстояние до своего фонтана, ед. */
  distToBase: number | null;
  /** Расстояние до ближайшей точки руны, ед. */
  distToRune: number | null;
  /** Ключи предметов героя (инвентарь, рюкзак, тайник) */
  items: readonly string[] | null;
}

/** Спокойный момент: мёртв, пауза, до горна, на базе, идёт на базу, просто тихо; null — не спокойно */
export type CalmKind = 'dead' | 'paused' | 'pregame' | 'base' | 'retreating' | 'quiet';
export const CALM_RU: Record<CalmKind, string> = { dead: 'мёртв', paused: 'пауза', pregame: 'до горна', base: 'на базе', retreating: 'идёт на базу', quiet: 'тихо' };

export interface GateMoment {
  /** Драка или напряжение: проходят только срочные */
  fight: boolean;
  calm: CalmKind | null;
  /** Почему драка (для панели отладки) */
  why: string[];
}

/** Почему подсказка не показана (итоговая причина) */
export const SUPPRESS_REASONS = ['fight', 'busy', 'budget', 'cooldown', 'duplicate', 'muted', 'low-confidence', 'already-done', 'stale', 'expired', 'disabled'] as const;
export type SuppressReason = (typeof SUPPRESS_REASONS)[number];
export const SUPPRESS_RU: Record<SuppressReason, string> = {
  fight: 'драка — ждала и устарела',
  busy: 'не было спокойного момента',
  budget: 'лимит: одна в ~минуту',
  cooldown: 'тот же тип недавно',
  duplicate: 'тот же совет недавно',
  muted: '«не нужно» в этом матче',
  'low-confidence': 'низкая уверенность → в разбор',
  'already-done': 'уже сделано',
  stale: 'ситуация прошла',
  expired: 'устарела в очереди',
  disabled: 'категория выключена',
};

/** Решение по подсказке — для панели отладки и журнала */
export interface GateDecision {
  atMs: number;
  type: string;
  short: string;
  priority: GatePriority;
  outcome: 'shown' | SuppressReason;
}

/** Подсказка на экране после фильтра */
export interface GateVisible {
  seq: number;
  hint: GateHint;
  shownMs: number;
  untilMs: number;
  /** Показ в спокойный момент «мёртв / на базе / пауза / до горна» — можно с подробностями */
  withDetails: boolean;
}

/** Счётчики по типу подсказки (локальные метрики, без сети) */
export interface TypeMetrics {
  shown: number;
  acted: number;
  ignored: number;
  muted: number;
  /** Проверить, выполнил ли игрок совет, нечем */
  unclear: number;
}

/** Хранимое между матчами: «не нужно» и метрики */
export interface GateMemoryState {
  version: 1;
  /** Тип → матчи, в которых нажали «не нужно» (последние 10) */
  mutes: Record<string, string[]>;
  metrics: Record<string, TypeMetrics>;
}

export const emptyGateMemory = (): GateMemoryState => ({ version: 1, mutes: {}, metrics: {} });

/** Сводка для панели отладки на странице «Живая игра» */
export interface GateDebug {
  enabled: boolean;
  moment: { fight: boolean; calm: CalmKind | null; why: string[] };
  /** Получено (новых подсказок от генераторов), показано, скрыто — по причинам, за матч */
  received: number;
  shown: number;
  suppressed: Partial<Record<SuppressReason, number>>;
  waiting: number;
  /** Через сколько секунд бюджет пустит несрочную подсказку (0 — уже можно) */
  budgetInSec: number;
  muted: string[];
  demoted: string[];
  /** Ушло в разбор матча из-за низкой уверенности: тип → короткая фраза и сколько раз */
  deferred: { type: string; short: string; count: number }[];
  recent: GateDecision[];
}
