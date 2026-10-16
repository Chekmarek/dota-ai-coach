// Движок подсказок в main (этап 4): снимок матча от окна движка + последнее чтение GSI → правила и слой ИИ
// (src/core/coach) → подсказки в окно поверх игры и в интерфейс → «История советов».
// Без Electron: зависимости передаются снаружи (проверяется unit-тестами).
import { CoachAi, CoachEngine, MISTAKE_RU, defaultCoachSettings, toHudHint, type CoachData, type CoachSettings, type CoachUpdate } from '@core/coach/index.ts';
import type { AiProvider } from '@core/ai/provider.ts';
import type { Settings } from '@shared/schemas/settings';
import type { HudHint } from '@shared/types/hud';
import type { CoachInput } from '@shared/types/coach-input';
import type { HistoryMatch } from '@shared/types/history';
import type { KbStats } from '@shared/types/stats';
import type { KnowledgeBase } from '@shared/types/kb';

/** Как часто сохранять историю идущего матча */
export const HISTORY_SAVE_MS = 30_000;

export interface CoachDeps {
  settings: { get(): Settings };
  kb: { get(): KnowledgeBase | { error: string }; stats(): KbStats | null };
  aiProvider: () => AiProvider | null;
  history: { save(m: HistoryMatch): void };
  /** Подсказки на экране сейчас (пусто — нечего показывать); inMatch — матч идёт по данным игры */
  onHints: (hints: HudHint[], inMatch: boolean) => void;
  log?: (...parts: unknown[]) => void;
  now?: () => number;
}

export function coachSettings(s: Settings): CoachSettings {
  const d = defaultCoachSettings();
  return { ...d, detail: s.hints.detail, categories: { ...s.hints.categories }, aiLive: s.hints.ai };
}

const safeId = (s: string) => s.replace(/[^0-9A-Za-z_-]/g, '-').slice(0, 80);

export class CoachService {
  private engine: CoachEngine | null = null;
  private engineError: string | null = null;
  private match: HistoryMatch | null = null;
  private seenJournal = 0;
  private lastSaveMs = 0;
  private lastHintsKey = '';
  private readonly now: () => number;

  constructor(private readonly deps: CoachDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  private ensure(): CoachEngine | null {
    if (this.engine || this.engineError) return this.engine;
    const kb = this.deps.kb.get();
    if ('error' in kb) {
      this.engineError = kb.error;
      this.deps.log?.('coach: нет базы знаний', kb.error);
      return null;
    }
    const data: CoachData = {
      patch: kb.meta.patch,
      heroes: kb.heroes,
      items: kb.items,
      mechanics: kb.mechanics,
      stats: this.deps.kb.stats(),
      kbVerified: kb.meta.verification === 'verified',
    };
    const ai = new CoachAi({ provider: () => this.deps.aiProvider(), now: this.now });
    this.engine = new CoachEngine({ data, ai, now: this.now, settings: coachSettings(this.deps.settings.get()), onAsync: () => this.publish() });
    this.deps.log?.('coach: движок подсказок готов', { patch: data.patch, stats: data.stats ? data.stats.heroes.length : 0 });
    return this.engine;
  }

  /** Новый снимок матча */
  ingest(input: CoachInput): CoachUpdate | null {
    const s = this.deps.settings.get();
    if (!s.hints.enabled) {
      this.emit([], false);
      return null;
    }
    const e = this.ensure();
    if (!e) return null;
    e.setSettings(coachSettings(s));
    const u = e.tick(input.state, input.gsi, input.gsiWallMs);
    this.trackHistory(u);
    this.publish();
    return u;
  }

  /** Матчапы против всех известных врагов (кнопка в интерфейсе) */
  showMatchups(): void {
    this.engine?.showMatchups();
    this.publish();
  }

  /** Настройки поменялись: подробность и категории — сразу на экране */
  onSettingsChanged(): void {
    this.engine?.setSettings(coachSettings(this.deps.settings.get()));
    this.publish(true);
  }

  private publish(force = false): void {
    const e = this.engine;
    const s = this.deps.settings.get();
    if (!e || !s.hints.enabled) return this.emit([], false);
    const reviews = { death: e.deathReviewNow, match: e.matchReviewNow };
    const hints = e.queue
      .visible()
      .filter((h) => s.hints.categories[h.category])
      .map((h) => toHudHint(h, s.hints.detail, reviews));
    const key = JSON.stringify(hints.map((h) => [h.seq, h.title, h.text, h.percent?.value, h.review?.aiText])) + e.inGame;
    if (!force && key === this.lastHintsKey) return;
    this.lastHintsKey = key;
    this.emit(hints, e.inGame);
  }

  private emit(hints: HudHint[], inMatch: boolean): void {
    this.deps.onHints(hints, inMatch);
  }

  // ---------- История ----------

  private trackHistory(u: CoachUpdate): void {
    const e = this.engine!;
    const now = this.now();
    if (!e.inGame && !u.matchReview && !this.match) return;
    const matchId = e.matchId;
    if (!this.match || (matchId && this.match.matchId && matchId !== this.match.matchId)) {
      if (this.match) this.deps.history.save(this.match);
      const started = new Date(now).toISOString();
      this.match = {
        id: safeId(`${started.replace(/[:.]/g, '-')}-${matchId ?? 'match'}`),
        startedAt: started,
        matchId,
        heroName: e.heroName,
        result: null,
        durationSec: null,
        entries: [],
        mistakes: [],
        deathReviews: [],
        matchReview: null,
      };
      this.seenJournal = e.journalTotal;
      this.lastSaveMs = now;
    }
    const m = this.match;
    m.matchId ??= matchId;
    m.heroName ??= e.heroName;
    // новые записи журнала
    const fresh = e.journalTotal - this.seenJournal;
    if (fresh > 0) m.entries.push(...e.journal.slice(-Math.min(fresh, e.journal.length)));
    this.seenJournal = e.journalTotal;
    if (m.entries.length > 1500) m.entries.splice(0, m.entries.length - 1500);
    m.mistakes = e.mistakes.list.map((x) => ({ type: x.type, titleRu: MISTAKE_RU[x.type], clock: x.clock, text: x.text, instead: x.instead, aiText: x.aiText ?? null }));
    if (u.deathReview && !m.deathReviews.some((d) => d.clock === u.deathReview!.clock)) {
      const r = u.deathReview;
      m.deathReviews.push({ clock: r.clock, why: r.why, tips: r.tips, buyback: r.buyback.text, aiText: r.aiText });
    }
    // ИИ мог дописать разбор смерти позже
    for (const d of m.deathReviews) if (!d.aiText && e.deathReviewNow && e.deathReviewNow.clock === d.clock) d.aiText = e.deathReviewNow.aiText;
    if (u.matchReview) {
      const r = u.matchReview;
      m.result = r.result;
      m.durationSec = r.durationSec;
      m.matchReview = { result: r.result, why: r.why, goodPlays: r.goodPlays, goals: r.goals, stats: r.stats, timeline: r.timeline, aiText: r.aiText };
    }
    // ИИ дописал разбор матча после конца игры
    let late = false;
    if (m.matchReview && !m.matchReview.aiText && e.matchReviewNow?.aiText) {
      m.matchReview.aiText = e.matchReviewNow.aiText;
      late = true;
    }
    if (!e.inGame && !m.matchReview && !u.matchReview) return;
    if (u.matchReview || late || now - this.lastSaveMs >= HISTORY_SAVE_MS) {
      this.lastSaveMs = now;
      this.deps.history.save(m);
    }
  }

  /** Выход из приложения: сохранить идущий матч */
  flush(): void {
    if (this.match) this.deps.history.save(this.match);
  }
}
