// Фокус матча: расчёт метрики по снимкам игры и решение «получилось / нет». Время — игровые часы (с), поэтому
// одинаково на живом матче и на записи. Подключение посреди матча: счётчики (смерти, добивания) — абсолютные из
// игры, доли — с момента подключения. Чистое ядро.
import { focusWindowSec, type FocusDef } from './config.ts';

/** Снимок для фокуса (из данных игры) */
export interface FocusSample {
  /** Игровые часы, с; null — не известно */
  clock: number | null;
  inGame: boolean;
  paused: boolean;
  alive: boolean | null;
  /** Счётчики из игры (абсолютные за матч) */
  deaths: number | null;
  lastHits: number | null;
  gold: number | null;
  /** Есть Town Portal Scroll (или сапоги путешествий) */
  hasTp: boolean | null;
  /** Счётчик приказов игрока */
  commands: number | null;
  atBase: boolean | null;
}

export type FocusState = 'pending' | 'achieved' | 'failed' | 'unknown';

export interface FocusProgress {
  /** Значение метрики сейчас; null — ещё нет данных */
  value: number | null;
  target: number;
  state: FocusState;
  /** Для счётчика: «1/1», «23/45», «96%» */
  text: string;
}

/** Шаг между снимками больше этого (с) — разрыв (пауза записи, переподключение): время не засчитываем */
const MAX_STEP_SEC = 5;

/** Цель фокуса: постоянная или от среднего за прошлые матчи (не хуже среднего, с запасом factor) */
export function resolveTarget(def: FocusDef, o: { avg: number | null; position: number | null }): number {
  const t = def.target;
  if ('fixed' in t) return t.fixed;
  const f = t.fromAverage;
  const byPos = o.position !== null ? f.fallbackByPosition?.[o.position as 1 | 2 | 3 | 4 | 5] : undefined;
  if (o.avg === null) return byPos ?? f.fallback;
  const raw = def.better === 'higher' ? o.avg * f.factor : o.avg / f.factor;
  return Math.round(Math.max(f.min, Math.min(f.max, raw)));
}

const meets = (def: FocusDef, value: number, target: number) => (def.better === 'lower' ? value <= target : value >= target);

export class FocusTracker {
  private value: number | null = null;
  private done: FocusState | null = null;
  // доли
  private total = 0;
  private hit = 0;
  private prevClock: number | null = null;
  // простои
  private lastCmd: number | null = null;
  private cmdSinceClock: number | null = null;
  private idleCounted = false;
  private idles = 0;

  constructor(
    readonly def: FocusDef,
    readonly target: number,
    readonly turbo: boolean,
  ) {}

  feed(s: FocusSample): FocusProgress {
    const m = this.def.metric;
    const c = s.clock;
    const live = s.inGame && !s.paused && c !== null && c >= 0;
    const window = focusWindowSec(this.def, this.turbo);
    if (m.kind === 'deaths-before') {
      if (c !== null && c < window! && s.deaths !== null) this.value = s.deaths;
      if (this.value !== null && this.value > this.target) this.done = 'failed';
      else if (c !== null && c >= window! && this.done === null) this.done = this.value === null ? 'unknown' : 'achieved';
    } else if (m.kind === 'last-hits-at') {
      if (c !== null && c <= window! && s.lastHits !== null) this.value = s.lastHits;
      if (c !== null && c > window! && this.done === null) this.done = this.value === null ? 'unknown' : meets(this.def, this.value, this.target) ? 'achieved' : 'failed';
    } else if (m.kind === 'share') {
      const step = this.prevClock !== null && c !== null ? c - this.prevClock : 0;
      if (live && s.alive === true && c! >= m.fromSec && step > 0 && step <= MAX_STEP_SEC) {
        const cond = m.signal === 'has-tp' ? s.hasTp : s.gold === null ? null : s.gold >= (this.turbo ? m.turboGoldAbove : m.goldAbove);
        if (cond !== null) {
          this.total += step;
          if (cond) this.hit += step;
        }
      }
      if (this.total > 0) this.value = Math.round((100 * this.hit) / this.total);
    } else if (m.kind === 'idle-episodes') {
      if (!live || s.alive !== true || s.atBase === true || s.commands === null || s.commands !== this.lastCmd) {
        this.lastCmd = s.commands;
        this.cmdSinceClock = c;
        this.idleCounted = false;
      } else if (this.cmdSinceClock !== null && c! - this.cmdSinceClock >= m.idleSec && !this.idleCounted) {
        this.idleCounted = true;
        this.idles++;
      }
      if (live) this.value = this.idles;
      if (this.value !== null && this.value > this.target) this.done = 'failed';
    }
    if (c !== null) this.prevClock = c;
    return this.progress();
  }

  progress(): FocusProgress {
    return { value: this.value, target: this.target, state: this.done ?? 'pending', text: this.text() };
  }

  /** Конец матча: что не решилось по ходу, решается по итогу */
  finish(): FocusProgress {
    if (this.done === null) {
      if (this.value === null) this.done = 'unknown';
      else this.done = meets(this.def, this.value, this.target) ? 'achieved' : 'failed';
    }
    return this.progress();
  }

  private text(): string {
    const v = this.value === null ? '—' : String(this.value);
    if (this.def.unit === '%') return `${v}%`;
    return `${v}/${this.target}`;
  }
}
