// Фокус матча: выбор одного фокуса по истории (самые частые ошибки), переключение одной клавишей, счёт всех
// метрик (чтобы в следующих матчах было «ваше среднее»), итог после матча. Чистое ядро.
import { FOCUS_DEFS, STARTER_FOCUS_IDS, focusTitle, type FocusDef } from './config.ts';
import { FocusTracker, resolveTarget, type FocusProgress, type FocusSample } from './tracker.ts';

/** Прошлый матч для выбора фокуса и среднего */
export interface FocusHistoryItem {
  /** Типы ошибок коуча за матч (повторы — столько раз, сколько было) */
  mistakes: readonly string[];
  /** Какой был фокус и получилось ли */
  focus?: { id: string; achieved: boolean | null } | null;
  /** Значения метрик фокусов за матч (id фокуса → значение) */
  metrics?: Readonly<Record<string, number>>;
  turbo?: boolean;
}

/** Сколько прошлых матчей учитывать */
export const FOCUS_HISTORY_MATCHES = 10;

/**
 * Фокусы по порядку: чаще всего ошибки этого фокуса за последние матчи (свежие — с бо́льшим весом). Если фокус
 * получался два последних раза подряд — в конец списка (уже освоен). Истории нет — стартовый набор.
 * Не подходит позиции (добивания саппорту) — не предлагаем.
 */
export function rankFocuses(history: readonly FocusHistoryItem[], position: number | null, defs: readonly FocusDef[] = FOCUS_DEFS): FocusDef[] {
  const recent = history.slice(0, FOCUS_HISTORY_MATCHES);
  const fits = defs.filter((d) => !d.positions || position === null || d.positions.includes(position as 1 | 2 | 3 | 4 | 5));
  const starter = (d: FocusDef) => {
    const i = STARTER_FOCUS_IDS.indexOf(d.id);
    return i < 0 ? STARTER_FOCUS_IDS.length + defs.indexOf(d) : i;
  };
  const score = (d: FocusDef) =>
    recent.reduce((s, m, i) => {
      const n = m.mistakes.filter((t) => (d.mistakes as readonly string[]).includes(t)).length;
      return s + Math.min(n, 3) * (1 - i * 0.05);
    }, 0);
  const mastered = (d: FocusDef) => {
    const runs = recent.filter((m) => m.focus?.id === d.id).slice(0, 2);
    return runs.length === 2 && runs.every((m) => m.focus?.achieved === true);
  };
  return [...fits].sort((a, b) => Number(mastered(a)) - Number(mastered(b)) || score(b) - score(a) || starter(a) - starter(b));
}

/** Среднее значение метрики фокуса за прошлые матчи того же режима; меньше 2 матчей — null */
export function focusAverage(history: readonly FocusHistoryItem[], id: string, turbo: boolean): number | null {
  const vals = history
    .slice(0, FOCUS_HISTORY_MATCHES)
    .filter((m) => (m.turbo ?? false) === turbo)
    .map((m) => m.metrics?.[id])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (vals.length < 2) return null;
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}

export interface FocusNow {
  def: FocusDef;
  title: string;
  voice: string;
  progress: FocusProgress;
  /** Выбран клавишей (тогда смена позиции его не меняет) */
  manual: boolean;
}

export interface FocusResult {
  id: string;
  title: string;
  value: number | null;
  target: number;
  unit: '' | '%';
  better: 'lower' | 'higher';
  achieved: boolean | null;
  /** Ваше среднее за прошлые матчи; null — мало матчей */
  prevAvg: number | null;
  keep: string;
}

export class FocusSession {
  readonly matchId: string | null;
  readonly turbo: boolean;
  private readonly history: readonly FocusHistoryItem[];
  private position: number | null;
  private order: FocusDef[];
  private idx = 0;
  private manual = false;
  private trackers = new Map<string, FocusTracker>();

  constructor(
    o: { matchId: string | null; turbo: boolean; position: number | null; history: readonly FocusHistoryItem[] },
    private readonly defs: readonly FocusDef[] = FOCUS_DEFS,
  ) {
    this.matchId = o.matchId;
    this.turbo = o.turbo;
    this.history = o.history;
    this.position = o.position;
    this.order = rankFocuses(o.history, o.position, defs);
    // Считаем все фокусы — и выбранный, и остальные: их значения станут «вашим средним» в следующих матчах
    for (const d of defs) this.trackers.set(d.id, new FocusTracker(d, resolveTarget(d, { avg: focusAverage(o.history, d.id, o.turbo), position: o.position }), o.turbo));
  }

  get current(): FocusNow {
    const def = this.order[this.idx] ?? this.defs[0]!;
    return { def, title: focusTitle(def, this.turbo), voice: def.voice, progress: this.trackers.get(def.id)!.progress(), manual: this.manual };
  }

  /** Выбрать фокус по id (перенос выбора в пересобранную сессию); false — такого нет в списке */
  select(id: string, manual: boolean): boolean {
    const i = this.order.findIndex((d) => d.id === id);
    if (i < 0) return false;
    this.idx = i;
    this.manual = manual;
    return true;
  }

  /** Следующий фокус из списка (горячая клавиша) */
  next(): FocusNow {
    this.idx = (this.idx + 1) % Math.max(1, this.order.length);
    this.manual = true;
    return this.current;
  }

  /**
   * Позиция стала известна (выбор героев → матч): если текущий фокус ей не подходит и игрок его не выбирал сам —
   * список пересобирается. Возвращает true, если фокус сменился.
   */
  setPosition(position: number | null): boolean {
    if (position === this.position) return false;
    this.position = position;
    if (this.manual) return false;
    const before = this.current.def.id;
    this.order = rankFocuses(this.history, position, this.defs);
    this.idx = 0;
    // цель от позиции (добивания) — заново, пока окно фокуса не началось
    for (const d of this.defs) {
      const old = this.trackers.get(d.id)!;
      if (old.progress().value === null) this.trackers.set(d.id, new FocusTracker(d, resolveTarget(d, { avg: focusAverage(this.history, d.id, this.turbo), position }), this.turbo));
    }
    return this.current.def.id !== before;
  }

  feed(s: FocusSample): FocusNow {
    for (const t of this.trackers.values()) t.feed(s);
    return this.current;
  }

  /** Итог матча: выбранный фокус и значения всех метрик (для истории) */
  finish(): { result: FocusResult; metrics: Record<string, number> } {
    const metrics: Record<string, number> = {};
    for (const [id, t] of this.trackers) {
      const p = t.finish();
      if (p.value !== null) metrics[id] = p.value;
    }
    const def = this.current.def;
    const p = this.trackers.get(def.id)!.progress();
    const achieved = p.state === 'achieved' ? true : p.state === 'failed' ? false : null;
    return {
      result: {
        id: def.id,
        title: focusTitle(def, this.turbo),
        value: p.value,
        target: p.target,
        unit: def.unit,
        better: def.better,
        achieved,
        prevAvg: focusAverage(this.history, def.id, this.turbo),
        keep: achieved === false ? def.keep.failed : def.keep.achieved,
      },
      metrics,
    };
  }
}
