// Прогресс игрока: опыт, уровни, серия, достижения, тренды ошибок, статистика доверия к советам.
// Только за настоящее улучшение в матчах — за открытие приложения ничего нет. Всё считается из записей матчей
// (по одной на сыгранный матч, локально). Чистое ядро.

/** Итог показанной подсказки в матче (из фильтра внимания) */
export interface MatchHintOutcome {
  type: string;
  /** Короткая фраза: «Отходи», «Не вступай» — по ней статистика доверия */
  short: string;
  result: 'acted' | 'ignored' | 'unclear';
  /** «Отходи»: выжил ли 15 с после совета; null — не проверялось */
  survived: boolean | null;
}

/** Запись о матче для прогресса — компактная, хранится дольше истории (история — последние 50 матчей) */
export interface MatchRecord {
  /** Ключ матча (id файла истории) */
  key: string;
  /** Когда начат, ISO */
  startedAt: string;
  turbo: boolean;
  /** Фокус матча; null — фокуса не было */
  focus: { id: string; achieved: boolean | null } | null;
  /** Значения метрик фокусов (смерти до 10 мин, добивания к 10:00, доля с TP …) */
  metrics: Record<string, number>;
  /** Сколько раз за матч была каждая ошибка коуча */
  mistakes: Record<string, number>;
  outcomes: MatchHintOutcome[];
}

export interface XpItem {
  reason: 'focus' | 'streak' | 'hint' | 'improved';
  xp: number;
  /** По-русски: «Фокус выполнен: меньше смертей до 10 мин» */
  label: string;
}

/** Опыт за матч (вычисляется один раз, когда матч закончен) */
export interface MatchAward {
  key: string;
  items: XpItem[];
  total: number;
}
