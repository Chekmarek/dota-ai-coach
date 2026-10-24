// Фокус матча: все фокусы и их критерии успеха — в одном месте. Добавить фокус = добавить запись сюда
// (метрика — одна из FocusMetric; новая метрика — ещё и расчёт в tracker.ts). Всё меряется по данным игры (GSI).
// Чистые данные: без DOM и Electron.
import type { MistakeType } from '../coach/mistakes.ts';

/**
 * Как меряется фокус (время — игровые часы, с; turbo… — для Турбо, там игра быстрее):
 * deaths-before — сколько смертей до untilSec;
 * last-hits-at — добивания к atSec;
 * share — доля времени (живы, игра идёт, после fromSec), когда выполнено условие: has-tp — Town Portal Scroll есть,
 *   gold-hoard — золота на руках не меньше goldAbove;
 * idle-episodes — сколько раз простояли без приказов idleSec и больше (не на базе).
 */
export type FocusMetric =
  | { kind: 'deaths-before'; untilSec: number; turboUntilSec: number }
  | { kind: 'last-hits-at'; atSec: number; turboAtSec: number }
  | { kind: 'share'; signal: 'has-tp'; fromSec: number }
  | { kind: 'share'; signal: 'gold-hoard'; fromSec: number; goldAbove: number; turboGoldAbove: number }
  | { kind: 'idle-episodes'; idleSec: number };

/** Цель: постоянная или от вашего среднего за прошлые матчи (чуть лучше среднего, но в разумных пределах) */
export type FocusTarget =
  | { fixed: number }
  | { fromAverage: { factor: number; min: number; max: number; fallback: number; fallbackByPosition?: Partial<Record<1 | 2 | 3 | 4 | 5, number>> } };

export interface FocusDef {
  id: string;
  /** Для экрана: «меньше смертей до {min} мин» — {min} подставляется по режиму */
  title: string;
  /** Для голоса (≤ 5 слов) */
  voice: string;
  /** Подпись счётчика поверх игры: «Смерти 1/1» */
  counter: string;
  metric: FocusMetric;
  /** Что лучше: меньше (смерти, простои) или больше (добивания, доля с TP) */
  better: 'lower' | 'higher';
  target: FocusTarget;
  /** % — доля времени; иначе штуки */
  unit: '' | '%';
  /** Ошибки коуча, которые говорят, что этот фокус вам нужен (выбор по истории) */
  mistakes: MistakeType[];
  /** Подсказки, которые относятся к фокусу: в матче — выше важность и свой звук */
  hintTypes: string[];
  /** Для каких позиций (1–5); нет — для всех. Позиция не известна — тоже подходит */
  positions?: (1 | 2 | 3 | 4 | 5)[];
  /** Одна фраза после матча: получилось — что сохранить; нет — на что смотреть */
  keep: { achieved: string; failed: string };
}

export const FOCUS_DEFS: readonly FocusDef[] = [
  {
    id: 'deaths-early',
    title: 'меньше смертей до {min} мин',
    voice: 'Фокус: меньше смертей',
    counter: 'Смерти',
    metric: { kind: 'deaths-before', untilSec: 600, turboUntilSec: 420 },
    better: 'lower',
    target: { fixed: 1 },
    unit: '',
    mistakes: ['died-unused', 'joined-losing-fight', 'overextended', 'fog-night'],
    hintTypes: ['danger.model', 'danger.low-hp', 'danger.missing', 'danger.ganker', 'danger.smoke', 'danger.deep', 'fight.disengage', 'fight.engage', 'laning.use-regen', 'laning.buy-regen'],
    keep: { achieved: 'Сохраняйте осторожность на линии: отходите, когда враги пропадают с карты.', failed: 'На линии отходите сразу, как пропали враги или здоровья меньше половины.' },
  },
  {
    id: 'last-hits',
    title: 'добивания к {min}:00',
    voice: 'Фокус: добивания',
    counter: 'Добивания',
    metric: { kind: 'last-hits-at', atSec: 600, turboAtSec: 420 },
    better: 'higher',
    target: { fromAverage: { factor: 1.1, min: 25, max: 90, fallback: 40, fallbackByPosition: { 1: 45, 2: 45, 3: 35 } } },
    unit: '',
    mistakes: ['poor-cs'],
    hintTypes: ['laning.cs', 'laning.bench', 'economy.idle', 'economy.route'],
    positions: [1, 2, 3],
    keep: { achieved: 'Держите тот же темп добиваний: последний удар по каждому крипу в зоне досягаемости.', failed: 'Ставьте добивание выше размена: сначала крип, потом удар по герою.' },
  },
  {
    id: 'tp-always',
    title: 'всегда с Town Portal Scroll',
    voice: 'Фокус: всегда с телепортом',
    counter: 'С TP',
    metric: { kind: 'share', signal: 'has-tp', fromSec: 180 },
    better: 'higher',
    target: { fixed: 90 },
    unit: '%',
    mistakes: ['no-tp', 'missed-fight'],
    hintTypes: ['economy.tp', 'macro.help'],
    keep: { achieved: 'Покупайте новый TP сразу после телепорта — так вы успеваете на все драки.', failed: 'После каждого телепорта сразу покупайте новый — курьером, если вы далеко от базы.' },
  },
  {
    id: 'gold-spend',
    title: 'тратить золото вовремя',
    voice: 'Фокус: тратить золото',
    counter: 'Запас золота',
    metric: { kind: 'share', signal: 'gold-hoard', fromSec: 120, goldAbove: 2000, turboGoldAbove: 3000 },
    better: 'lower',
    target: { fixed: 15 },
    unit: '%',
    mistakes: ['unspent-gold', 'late-item'],
    hintTypes: ['economy.gold', 'economy.next', 'economy.late'],
    keep: { achieved: 'Так и дальше: копите на предмет и сразу покупайте, не носите золото с собой.', failed: 'Хватает на предмет — покупайте курьером сразу, не ждите похода на базу.' },
  },
  {
    id: 'no-idle',
    title: 'без простоев',
    voice: 'Фокус: без простоев',
    counter: 'Простои',
    metric: { kind: 'idle-episodes', idleSec: 15 },
    better: 'lower',
    target: { fixed: 2 },
    unit: '',
    mistakes: ['idle'],
    hintTypes: ['economy.idle', 'economy.route', 'macro.group', 'macro.push'],
    keep: { achieved: 'Держите план на следующие 30 секунд: линия → лес → стак.', failed: 'Нечего делать — идите на ближайшую линию или в лес, а не ждите.' },
  },
];

/** Стартовый набор — если истории ещё нет: по порядку */
export const STARTER_FOCUS_IDS: readonly string[] = ['deaths-early', 'last-hits', 'tp-always'];

export function focusById(id: string): FocusDef | null {
  return FOCUS_DEFS.find((d) => d.id === id) ?? null;
}

/** Окно фокуса (с) по режиму: до какого времени считаются смерти, к какому — добивания */
export function focusWindowSec(def: FocusDef, turbo: boolean): number | null {
  const m = def.metric;
  if (m.kind === 'deaths-before') return turbo ? m.turboUntilSec : m.untilSec;
  if (m.kind === 'last-hits-at') return turbo ? m.turboAtSec : m.atSec;
  return null;
}

/** Название фокуса для экрана: «меньше смертей до 7 мин» в Турбо */
export function focusTitle(def: FocusDef, turbo: boolean): string {
  const w = focusWindowSec(def, turbo);
  return def.title.replace('{min}', w === null ? '' : String(Math.round(w / 60)));
}
