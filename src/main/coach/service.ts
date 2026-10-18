// Движок подсказок в main (этап 4): снимок матча от окна движка + последнее чтение GSI → правила и слой ИИ
// (src/core/coach) → подсказки в окно поверх игры и в интерфейс → «История советов».
// Без Electron: зависимости передаются снаружи (проверяется unit-тестами).
import { CoachAi, CoachEngine, MISTAKE_RU, defaultCoachSettings, toHudHint, type CoachData, type CoachSettings, type CoachUpdate } from '@core/coach/index.ts';
import type { AiProvider } from '@core/ai/provider.ts';
import type { Settings } from '@shared/schemas/settings';
import type { HudHint, ModeBanner } from '@shared/types/hud';
import type { CoachInput } from '@shared/types/coach-input';
import type { HistoryMatch } from '@shared/types/history';
import type { KbStats } from '@shared/types/stats';
import type { KnowledgeBase } from '@shared/types/kb';
import type { DraftLiveHeroes } from '@shared/types/draft';
import { liveHeroes } from './draft';
import { asGameModeInfo, modeBannerText, resolveGameMode, type GameModeInfo } from '@core/gsi/mode.ts';
import { parseModeOverrides } from '@core/knowledge-base/modes.ts';
import turboJson from '../../data/modes/turbo.json';

/** Справочник Турбо (вшит в сборку); неверная форма — null, тогда в Турбо вся механика «не проверено» */
const TURBO = parseModeOverrides(turboJson);

/** Как часто сохранять историю идущего матча */
export const HISTORY_SAVE_MS = 30_000;
/** Смена режима посреди матча объявляется, если новый режим держится столько (без мигания) */
export const MODE_STABLE_MS = 1500;

export interface CoachDeps {
  settings: { get(): Settings };
  kb: { get(): KnowledgeBase | { error: string }; stats(): KbStats | null };
  aiProvider: () => AiProvider | null;
  history: { save(m: HistoryMatch): void };
  /** Подсказки на экране сейчас (пусто — нечего показывать); inMatch — матч идёт по данным игры */
  onHints: (hints: HudHint[], inMatch: boolean) => void;
  /** Показать индикатор режима игры: начало матча или смена режима (из игры или в настройках) */
  onModeBanner?: (banner: ModeBanner) => void;
  log?: (...parts: unknown[]) => void;
  now?: () => number;
}

export function coachSettings(s: Settings): CoachSettings {
  const d = defaultCoachSettings();
  return { ...d, detail: s.hints.detail, categories: { ...s.hints.categories }, aiLive: s.hints.ai, gameMode: s.hints.gameMode };
}

const safeId = (s: string) => s.replace(/[^0-9A-Za-z_-]/g, '-').slice(0, 80);

export class CoachService {
  private engine: CoachEngine | null = null;
  private engineError: string | null = null;
  private match: HistoryMatch | null = null;
  private seenJournal = 0;
  private lastSaveMs = 0;
  private lastHintsKey = '';
  /** Для live.log: когда пришёл первый снимок, был ли матч, когда последний раз писали о подсказках */
  private inputs = 0;
  private loggedInMatch: boolean | null = null;
  private lastHintLogMs = 0;
  private readonly now: () => number;
  /** Индикатор режима: для какого матча и какого режима уже показан; кандидат на смену и с какого момента */
  private modeShown: { matchId: string; sig: string } | null = null;
  private modePending: { sig: string; since: number } | null = null;
  private modeSeq = 0;

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
      turbo: TURBO,
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
    this.inputs++;
    if (this.inputs === 1) this.deps.log?.('coach первый снимок матча', { gsi: input.gsi !== null, screen: input.state.sources.screen, heroKey: input.gsi?.hero.key ?? null });
    if (e.inGame !== this.loggedInMatch) {
      this.loggedInMatch = e.inGame;
      this.deps.log?.('coach матч', { inGame: e.inGame, gameState: input.gsi?.gameState ?? null, clock: input.gsi?.clock ?? null });
    }
    if (u.shown.length && this.now() - this.lastHintLogMs >= 5000) {
      this.lastHintLogMs = this.now();
      this.deps.log?.('coach подсказки', { shown: u.shown.map((h) => h.id).slice(0, 6), visible: u.visible.length, rulesMs: Math.round(u.rulesMs) });
    }
    const mode = resolveGameMode(asGameModeInfo(input.state.match.mode), s.hints.gameMode);
    this.trackHistory(u, mode);
    this.announceMode(e, mode);
    this.publish();
    return u;
  }

  /** Герои текущего матча (страница «Драфт», кнопка «Взять из матча») */
  liveHeroes(): DraftLiveHeroes {
    return liveHeroes(this.engine?.currentView ?? null, this.engine?.look ?? null);
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

  // ---------- Индикатор режима ----------

  /** В начале каждого матча — сразу; смена режима посреди матча — когда новый режим продержался MODE_STABLE_MS */
  private announceMode(e: CoachEngine, mode: GameModeInfo): void {
    if (!e.inGame || !this.match) return;
    const sig = `${mode.mode}|${mode.source}|${mode.raw ?? ''}`;
    const now = this.now();
    const newMatch = this.modeShown?.matchId !== this.match.id;
    if (!newMatch) {
      if (sig === this.modeShown!.sig) {
        this.modePending = null;
        return;
      }
      if (this.modePending?.sig !== sig) this.modePending = { sig, since: now };
      if (now - this.modePending.since < MODE_STABLE_MS) return;
    }
    this.modeShown = { matchId: this.match.id, sig };
    this.modePending = null;
    const t = modeBannerText(mode);
    const banner: ModeBanner = { seq: ++this.modeSeq, mode: mode.mode, source: mode.source, title: t.title, text: t.text };
    this.deps.log?.('coach режим игры', { mode: mode.mode, source: mode.source, raw: mode.raw, newMatch });
    this.deps.onModeBanner?.(banner);
  }

  // ---------- История ----------

  private trackHistory(u: CoachUpdate, mode: GameModeInfo): void {
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
    // Режим: известный не затирается «неизвестным» (GSI замолчал), ручной выбор пользователя — важнее
    if (mode.mode !== 'unknown' || !m.gameMode) m.gameMode = mode;
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
