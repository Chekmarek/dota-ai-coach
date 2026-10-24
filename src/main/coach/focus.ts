// Фокус матча в main: когда выбрать (выбор героев / начало матча), объявление поверх игры и звук, счётчик,
// смена клавишей, итог после матча и запись в историю. Логика фокусов — src/core/focus; здесь — только проводка.
// Без Electron: проверяется unit-тестами вместе с CoachService.
import { FocusSession, focusById, focusWindowSec, type FocusHistoryItem, type FocusNow, type FocusResult, type FocusSample } from '@core/focus/index.ts';
import type { CoachView } from '@core/coach/index.ts';
import type { HistoryFocus, HistoryMatch } from '@shared/types/history';
import type { HudFocus, HudHint } from '@shared/types/hud';

/** Объявление фокуса поверх игры, мс */
export const FOCUS_ANNOUNCE_MS = 6000;
/** Первые столько мс после матча — только итог фокуса, потом обычный разбор под ним */
export const FOCUS_RESULT_MS = 10_000;
/** До какого игрового времени (с) фокус пересобирается, если режим (Турбо) стал известен позже выбора героев */
const MODE_SETTLE_SEC = 120;
/** Номера карточек объявления — вне номеров подсказок (очередь, фильтр 1e9, подтверждения 1e12) */
const ANNOUNCE_SEQ_BASE = 3e12;

const ruNum = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');

/** Прошлые матчи → вход выбора фокуса; старые файлы без метрик — что можно восстановить (смерти, добивания к 10:00) */
export function focusHistory(matches: readonly HistoryMatch[]): FocusHistoryItem[] {
  const deathsDef = focusById('deaths-early');
  return matches.map((m) => {
    const turbo = m.gameMode?.mode === 'turbo';
    const metrics: Record<string, number> = { ...(m.focusMetrics ?? {}) };
    if (metrics['deaths-early'] === undefined && deathsDef && m.matchReview) {
      const until = focusWindowSec(deathsDef, turbo)!;
      metrics['deaths-early'] = m.deathReviews.filter((d) => d.clock !== null && d.clock < until).length;
    }
    if (metrics['last-hits'] === undefined && !turbo) {
      const lh = m.matchReview?.stats.find((s) => s.label === 'Добивания к 10:00')?.value;
      if (typeof lh === 'number') metrics['last-hits'] = lh;
    }
    return { mistakes: m.mistakes.map((x) => x.type), focus: m.focus ? { id: m.focus.id, achieved: m.focus.achieved } : null, metrics, turbo };
  });
}

/** Снимок для фокуса из снимка коуча: счётчики игры, TP, приказы, база */
export function focusSample(v: CoachView): FocusSample {
  const tp = v.me.itemsKnown ? v.me.items.some((i) => i.key === 'tpscroll' || i.key.startsWith('travel_boots')) : null;
  const atBase = v.team && v.me.zone ? v.me.zone === `${v.team}-base` : null;
  return {
    clock: v.clock.value,
    inGame: v.inGame,
    paused: v.paused,
    alive: v.me.alive.value,
    deaths: v.me.deaths.value,
    lastHits: v.me.lastHits.value,
    gold: v.me.gold.value,
    hasTp: tp,
    commands: v.me.commands.value,
    atBase,
  };
}

export interface FocusTick {
  /** Объявить (новый фокус или смена): заголовок, голос */
  announce: FocusNow | null;
  now: FocusNow | null;
}

export class FocusController {
  private session: FocusSession | null = null;
  private announce: { seq: number; until: number; title: string; text: string } | null = null;
  private announceSeq = ANNOUNCE_SEQ_BASE;
  private result: { r: FocusResult; metrics: Record<string, number>; atMs: number } | null = null;
  private resultMatch: string | null = null;

  constructor(private readonly history: () => FocusHistoryItem[]) {}

  get current(): FocusNow | null {
    return this.session?.current ?? null;
  }

  /**
   * Тик: фокус выбирается, как только известен матч (выбор героев или уже идёт игра); позиция стала известна —
   * пересчёт; счётчики — по снимку. shortcut — подпись клавиши для объявления.
   */
  tick(o: { nowMs: number; view: CoachView; turbo: boolean; position: number | null; shortcut: string }): FocusTick {
    const v = o.view;
    const started = v.matchId !== null && (v.phase === 'pre-game' || v.inGame);
    let announce: FocusNow | null = null;
    if (started && this.session?.matchId !== v.matchId) {
      this.session = new FocusSession({ matchId: v.matchId, turbo: o.turbo, position: o.position, history: this.history() });
      this.result = null;
      announce = this.session.current;
    }
    // Режим узнали позже выбора героев (Турбо определяется по темпу часов): в первые 2 минуты — пересобрать
    // под режим (окно «до 7 мин», среднее по Турбо-матчам), выбор игрока сохраняется
    if (this.session && this.session.matchId === v.matchId && !this.session.turbo && o.turbo && (v.clock.value ?? 0) < MODE_SETTLE_SEC) {
      const prev = this.session.current;
      this.session = new FocusSession({ matchId: v.matchId, turbo: o.turbo, position: o.position, history: this.history() });
      this.session.select(prev.def.id, prev.manual);
      announce = this.session.current;
    }
    const s = this.session;
    if (!s || s.matchId !== v.matchId) return { announce: null, now: null };
    if (s.setPosition(o.position)) announce = s.current;
    const now = s.feed(focusSample(v));
    if (announce) this.setAnnounce(announce, o.nowMs, o.shortcut);
    return { announce, now };
  }

  /** Горячая клавиша: следующий фокус; null — матча нет */
  next(nowMs: number, shortcut: string): FocusNow | null {
    if (!this.session || this.result) return null;
    const f = this.session.next();
    this.setAnnounce(f, nowMs, shortcut);
    return f;
  }

  private setAnnounce(f: FocusNow, nowMs: number, shortcut: string): void {
    this.announce = { seq: ++this.announceSeq, until: nowMs + FOCUS_ANNOUNCE_MS, title: `Фокус: ${f.title}`, text: shortcut ? `${shortcut} — другой фокус` : '' };
  }

  /** Карточка объявления поверх игры (пока свежая) */
  announceHint(nowMs: number): HudHint | null {
    const a = this.announce;
    if (!a || nowMs >= a.until) return null;
    return { seq: a.seq, zone: 'alert', priority: 'advice', category: 'review', title: a.title.slice(0, 120), text: a.text, percent: null, icon: null, source: 'template', ttlMs: FOCUS_ANNOUNCE_MS, review: null };
  }

  /** Счётчик поверх игры: только пока идёт матч */
  counter(inGame: boolean): HudFocus | null {
    const f = this.current;
    if (!f || !inGame || this.result) return null;
    return { label: f.def.counter, progress: f.progress.text, state: f.progress.state };
  }

  /** Конец матча: итог фокуса (один раз за матч) */
  finish(nowMs: number): { result: FocusResult; metrics: Record<string, number> } | null {
    const s = this.session;
    if (!s) return null;
    if (this.result && this.resultMatch === s.matchId) return { result: this.result.r, metrics: this.result.metrics };
    const r = s.finish();
    this.result = { r: r.result, metrics: r.metrics, atMs: nowMs };
    this.resultMatch = s.matchId;
    return r;
  }

  /** Блок итога в разборе матча; only — первые FOCUS_RESULT_MS только он */
  reviewBlock(nowMs: number): { focus: NonNullable<NonNullable<HudHint['review']>['focus']>; only: boolean } | null {
    const x = this.result;
    if (!x) return null;
    const r = x.r;
    const u = r.unit;
    const value = r.value === null ? 'нет данных' : `${ruNum(r.value)}${u}`;
    return {
      focus: {
        title: `Фокус: ${r.title}`.slice(0, 80),
        achieved: r.achieved,
        value,
        target: `${r.better === 'lower' ? 'не больше' : 'не меньше'} ${ruNum(r.target)}${u}`,
        avg: r.prevAvg === null ? null : `в среднем за прошлые матчи ${ruNum(r.prevAvg)}${u}`,
        keep: r.keep,
      },
      only: nowMs - x.atMs < FOCUS_RESULT_MS,
    };
  }

  /** Для истории */
  historyFocus(): { focus: HistoryFocus; metrics: Record<string, number> } | null {
    const x = this.result;
    if (!x) return null;
    return { focus: { ...x.r }, metrics: x.metrics };
  }
}
