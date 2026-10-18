// Движок подсказок: снимок матча → память → быстрые правила (синхронно, < 50 мс) → ошибки → разборы → очередь.
// Слой ИИ работает сбоку и асинхронно: совет «что делать и куда идти», пересказ подсказок, ошибок и разборов.
// Нет модели или она медленная — правила и шаблоны работают как обычно. Чистое ядро: время приходит снаружи.
import type { MatchState } from '../match-state/index.ts';
import type { GsiReading } from '../gsi/map.ts';
import { CoachLookup, type CoachData } from './data.ts';
import { CoachMemory } from './memory.ts';
import { HintQueue, DEFAULT_QUEUE_CONFIG, type QueueConfig } from './queue.ts';
import { MistakeDetector, MISTAKE_RU, type Mistake } from './mistakes.ts';
import { deathReview, matchReview, type DeathReview, type MatchReview } from './reviews.ts';
import { ACTION_RU, actionChoice, type ActionChoice } from './prob.ts';
import { buildView, poolPct, type CoachView } from './view.ts';
import { draft, mmss, type Rule, type RuleContext } from './rules/context.ts';
import { FIGHT_RULES, matchupsOnDemand } from './rules/fight.ts';
import { DANGER_RULES } from './rules/danger.ts';
import { LANING_RULES } from './rules/laning.ts';
import { ECONOMY_RULES, GOLD_HIGH } from './rules/economy.ts';
import { MACRO_RULES } from './rules/macro.ts';
import { DRAFT_RULES } from './rules/draft.ts';
import { TIMING_RULES } from './rules/timings.ts';
import {
  CoachAi,
  DESTINATION_RU,
  adviceFacts,
  adviceOptions,
  buildAdvicePrompt,
  deathPrompt,
  matchPrompt,
  mistakePrompt,
  parseAdvice,
  phrasePrompt,
  validateText,
  type Advice,
} from './ai.ts';
import { PRIORITY_RANK, defaultCoachSettings, type CoachSettings, type Hint, type HintDraft } from './types.ts';
import { asGameModeInfo, resolveGameMode } from '../gsi/mode.ts';

export const ALL_RULES: Rule[] = [...DANGER_RULES, ...FIGHT_RULES, ...MACRO_RULES, ...TIMING_RULES, ...LANING_RULES, ...ECONOMY_RULES, ...DRAFT_RULES];
/**
 * Совет ИИ «что делать и куда идти» — только по событию (см. adviceTrigger), не по таймеру.
 * Не чаще раза в ADVICE_MIN_GAP_MS; та же обстановка (подпись) не спрашивается повторно ADVICE_SAME_MS;
 * готовые ответы по подписи берутся из кэша ADVICE_CACHE_MS без обращения к модели.
 */
export const ADVICE_MIN_GAP_MS = 10_000;
export const ADVICE_SAME_MS = 90_000;
export const ADVICE_CACHE_MS = 180_000;
/** События, после которых совет повторяем, даже если обстановка та же (из кэша) */
const ADVICE_REPEAT_REASONS: ReadonlySet<string> = new Set(['respawn', 'fight-over', 'objective', 'building', 'enemies-dead']);
/** Простой, после которого стоит подсказать, куда идти */
export const ADVICE_IDLE_MS = 12_000;
/** Сколько мс новое лучшее действие должно продержаться, чтобы считаться сменой плана */
export const ADVICE_PLAN_STABLE_MS = 3000;
/** Ошибки, о которых говорим сразу (остальные — в разборах) */
const LIVE_MISTAKES = new Set(['missed-fight', 'missed-rune']);

export interface JournalEntry {
  wallMs: number;
  clock: number | null;
  kind: 'hint' | 'mistake' | 'death-review' | 'match-review';
  id: string;
  text: string;
  source: 'template' | 'ai';
}

export interface CoachUpdate {
  wallMs: number;
  /** Все подсказки на экране сейчас */
  visible: Hint[];
  /** Показаны впервые в этом тике (или пришли от ИИ после прошлого тика) */
  shown: Hint[];
  expired: Hint[];
  /** Текст на экране обновился (ИИ дописал) */
  changed: Hint[];
  mistakes: Mistake[];
  deathReview: DeathReview | null;
  matchReview: MatchReview | null;
  inFight: boolean;
  /** Время на правила этого тика, мс */
  rulesMs: number;
}

export interface CoachEngineOptions {
  data: CoachData;
  settings?: CoachSettings;
  ai?: CoachAi | null;
  queue?: QueueConfig;
  now?: () => number;
  /** ИИ прислал совет или текст между тиками — можно отправить обновление сразу */
  onAsync?: () => void;
}

export class CoachEngine {
  readonly look: CoachLookup;
  readonly mem = new CoachMemory();
  readonly queue: HintQueue;
  readonly mistakes = new MistakeDetector();
  readonly journal: JournalEntry[] = [];
  settings: CoachSettings;
  deathReviewNow: DeathReview | null = null;
  matchReviewNow: MatchReview | null = null;
  private readonly ai: CoachAi | null;
  private readonly now: () => number;
  private lastView: CoachView | null = null;
  private lastCtx: RuleContext | null = null;
  private lastAdviceAskMs = 0;
  private lastAdviceSig: string | null = null;
  private lastAdviceSigMs = 0;
  private adviceCache = new Map<string, { advice: Advice; choice: ActionChoice; ms: number }>();
  private phraseCache = new Map<string, string>();
  private planBest: string | null = null;
  private planSinceMs = 0;
  private planAdvised: string | null = null;
  private prevInFight = false;
  private prevMissing = 0;
  private prevEnemiesDead = 0;
  private idleAdvised = false;
  /** Почему последний раз спрашивали совет (для журнала и тестов) */
  lastAdviceReason: string | null = null;
  private asyncShown: Hint[] = [];
  private asyncChanged: Hint[] = [];
  private reviewHintSeq: number | null = null;

  constructor(private readonly opts: CoachEngineOptions) {
    this.look = new CoachLookup(opts.data);
    this.settings = opts.settings ?? defaultCoachSettings();
    this.queue = new HintQueue(opts.queue ?? DEFAULT_QUEUE_CONFIG);
    this.ai = opts.ai ?? null;
    this.now = opts.now ?? (() => Date.now());
  }

  setSettings(s: CoachSettings): void {
    this.settings = s;
  }

  /** Сколько записей журнала было всего (журнал обрезается — по этому счётчику main берёт новые) */
  journalTotal = 0;

  /** Матч идёт (по последнему снимку) */
  get inGame(): boolean {
    return this.lastView?.inGame ?? false;
  }
  get matchId(): string | null {
    return this.lastView?.matchId ?? this.mem.matchId;
  }
  get heroName(): string | null {
    return this.lastView?.me.hero.value?.name ?? null;
  }

  private log(e: JournalEntry): void {
    this.journalTotal++;
    this.journal.push(e);
    if (this.journal.length > 1000) this.journal.splice(0, this.journal.length - 1000);
  }

  private pushDraft(d: HintDraft, ctx: RuleContext, out: Hint[]): Hint | null {
    const r = this.queue.push(d, { now: ctx.now, clock: ctx.v.clock.value, inFight: this.mem.inFight, settings: this.settings });
    if (r.status === 'shown' && r.hint) {
      out.push(r.hint);
      this.log({ wallMs: ctx.now, clock: ctx.v.clock.value, kind: 'hint', id: r.hint.id, text: r.hint.short, source: r.hint.textSource });
      return r.hint;
    }
    return r.hint;
  }

  tick(state: MatchState, gsi: GsiReading | null, gsiWallMs: number | null): CoachUpdate {
    const t0 = this.now();
    // Режим игры: из снимка матча (GSI) с ручным выбором пользователя — от него механика и нормы правил
    this.look.setMode(resolveGameMode(asGameModeInfo(state.match.mode), this.settings.gameMode));
    const v = buildView(state, gsi, gsiWallMs);
    const ev = this.mem.ingest(v, GOLD_HIGH);
    if (ev.matchReset) {
      this.queue.reset();
      this.mistakes.reset();
      this.deathReviewNow = null;
      this.matchReviewNow = null;
      this.ai?.cancelAll();
    }
    const ctx: RuleContext = { v, mem: this.mem, ev, look: this.look, settings: this.settings, now: v.wallMs };
    this.lastView = v;
    this.lastCtx = ctx;
    const shown: Hint[] = [...this.asyncShown];
    const changed: Hint[] = [...this.asyncChanged];
    this.asyncShown = [];
    this.asyncChanged = [];
    let newMistakes: Mistake[] = [];

    if (v.inGame) {
      // 1. Быстрые правила
      const drafts: HintDraft[] = [];
      for (const rule of ALL_RULES) {
        try {
          const r = rule(ctx);
          if (Array.isArray(r)) drafts.push(...r);
          else if (r) drafts.push(r);
        } catch {
          // правило не должно ронять остальные
        }
      }
      drafts.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.confidence - a.confidence);
      for (const d of drafts) this.pushDraft(d, ctx, shown);

      // 2. Ошибки
      newMistakes = this.mistakes.detect(ctx);
      for (const m of newMistakes) {
        this.log({ wallMs: v.wallMs, clock: m.clock, kind: 'mistake', id: m.id, text: m.text, source: 'template' });
        if (LIVE_MISTAKES.has(m.type) && v.me.alive.value) {
          this.pushDraft(
            draft({ id: `mistake.${m.type}`, category: 'mistake', priority: 'info', confidence: 0.7, short: MISTAKE_RU[m.type], normal: `${m.text}. ${m.instead}`, facts: m.facts, ttlSec: 10, cooldownSec: 60 }),
            ctx,
            shown,
          );
        }
      }
    }

    // 3. Разбор после смерти
    if (ev.died) {
      const r = deathReview(ctx, ev.died, this.mem.deaths.length - 1, this.mistakes.list);
      this.deathReviewNow = r;
      const ttl = Math.max(10, Math.min(120, r.respawnSec ?? 30));
      const h = this.pushDraft(
        draft({
          id: `review.death:${r.index}`,
          ruleId: 'review.death',
          category: 'review',
          priority: 'advice',
          confidence: 0.9,
          short: 'Разбор смерти',
          normal: [r.why[0], r.tips[0], r.buyback.text].filter(Boolean).join(' · '),
          detailed: [...r.why, ...r.tips.map((t) => `Совет: ${t}`), r.buyback.text].join(' · '),
          facts: [],
          ttlSec: ttl,
          cooldownSec: 0,
        }),
        ctx,
        shown,
      );
      this.reviewHintSeq = h?.seq ?? null;
      this.log({ wallMs: v.wallMs, clock: r.clock, kind: 'death-review', id: `death:${r.index}`, text: r.why.join('; '), source: 'template' });
      this.askDeath(r);
    }
    if (ev.respawned && this.reviewHintSeq !== null) {
      this.queue.dismiss(this.reviewHintSeq);
      this.reviewHintSeq = null;
      this.deathReviewNow = null;
    }

    // 4. Разбор матча
    if (v.phase === 'post-game' && !this.matchReviewNow && this.mem.samples.length > 60) {
      const r = matchReview(v, this.mem, this.look, this.mistakes.list, ctx);
      this.matchReviewNow = r;
      this.pushDraft(
        draft({
          id: 'review.match',
          category: 'review',
          priority: 'advice',
          confidence: 0.9,
          short: r.result === 'win' ? 'Победа: разбор матча' : r.result === 'loss' ? 'Поражение: разбор матча' : 'Разбор матча',
          normal: [...r.why.slice(0, 2), r.goals[0] ? `Цель: ${r.goals[0]}` : ''].filter(Boolean).join(' · '),
          detailed: [...r.why, ...r.goodPlays.map((g) => `Хорошо: ${g}`), ...r.goals.map((g) => `Цель: ${g}`)].join(' · '),
          facts: [],
          ttlSec: 600,
          cooldownSec: 0,
        }),
        ctx,
        shown,
      );
      this.log({ wallMs: v.wallMs, clock: r.durationSec, kind: 'match-review', id: 'match', text: r.why.join('; '), source: 'template' });
      this.askMatch(r);
      // ошибки ИИ объясняет только в разборе, не во время игры
      for (const m of r.topMistakes) this.askMistake(m);
    }

    // 5. Совет ИИ «что делать и куда идти» — когда что-то изменилось, а не по таймеру
    if (this.ai && this.settings.aiLive && v.inGame && !v.paused) this.maybeAdvise(ctx);
    this.prevInFight = this.mem.inFight;

    // 6. Пересказ ИИ только для важного с долгим показом; одинаковые тексты — из кэша
    if (this.ai && this.settings.detail !== 'min') {
      const h = shown.find((x) => (x.priority === 'advice' || x.priority === 'critical') && x.textSource === 'template' && x.ttlMs >= 8000 && x.category !== 'review' && x.id !== 'ai.advice');
      if (h) {
        const cached = this.phraseCache.get(`${h.ruleId}|${h.short}`);
        if (cached) this.changedText(h.seq, cached, 'normal');
        else if (!this.ai.busy && this.ai.available) this.askPhrase(h);
      }
    }

    // Устаревшие: правило перестало подтверждать ситуативную подсказку (только пока идёт игра — на паузе правила молчат)
    const stale = v.inGame && !v.paused ? this.queue.expireStale(v.wallMs) : [];
    const expired = [...stale, ...this.queue.tick(v.wallMs)];
    return {
      wallMs: v.wallMs,
      visible: this.queue.visible(),
      shown,
      expired,
      changed,
      mistakes: newMistakes,
      deathReview: this.deathReviewNow,
      matchReview: this.matchReviewNow,
      inFight: this.mem.inFight,
      rulesMs: this.now() - t0,
    };
  }

  /** Последний снимок матча (для страницы «Драфт»: какие герои уже известны); null — снимков ещё не было */
  get currentView(): CoachView | null {
    return this.lastView;
  }

  /** Матчапы против всех известных врагов (кнопка в интерфейсе) */
  showMatchups(): Hint[] {
    if (!this.lastCtx) return [];
    const out: Hint[] = [];
    for (const d of matchupsOnDemand(this.lastCtx)) this.pushDraft({ ...d, zone: 'decision' }, this.lastCtx, out);
    return out;
  }

  // ---------- ИИ ----------

  private changedText(seq: number | null | undefined, text: string, mode: 'normal' | 'both' = 'both'): void {
    if (seq == null) return;
    const cur = this.queue.visible().find((h) => h.seq === seq);
    if (!cur) return;
    const h = this.queue.updateText(seq, { detail: { normal: text, detailed: mode === 'both' ? `${text} · ${cur.detail.detailed}` : cur.detail.detailed }, textSource: 'ai' });
    if (h) {
      this.asyncChanged.push(h);
      this.opts.onAsync?.();
    }
  }

  /** Подпись обстановки: если она та же, что при прошлом совете, — модель не спрашиваем */
  private adviceSig(v: CoachView, choice: ActionChoice): string {
    const hp = poolPct(v.me.hp.value);
    const missing = v.enemies.filter((e) => e.missing === true).length;
    const dead = v.enemies.filter((e) => e.alive.value === false).length;
    const clock = v.clock.value ?? 0;
    return [
      choice.best,
      v.me.zone ?? '-',
      missing >= 3 ? 'm3' : missing >= 1 ? 'm1' : 'm0',
      `d${Math.min(dead, 3)}`,
      hp === null ? 'h?' : hp < 35 ? 'h1' : hp < 70 ? 'h2' : 'h3',
      clock < 600 ? 'early' : clock < 1500 ? 'mid' : 'late',
    ].join('|');
  }

  /** Зачем нужен совет прямо сейчас; null — ничего не изменилось */
  private adviceTrigger(ctx: RuleContext, choice: ActionChoice): string | null {
    const { v, ev, now } = ctx;
    const missing = v.enemies.filter((e) => e.missing === true).length;
    const dead = v.enemies.filter((e) => e.alive.value === false).length;
    const prevMissing = this.prevMissing;
    const prevDead = this.prevEnemiesDead;
    this.prevMissing = missing;
    this.prevEnemiesDead = dead;
    // Смена плана считается, только если новое лучшее действие держится ADVICE_PLAN_STABLE_MS
    if (choice.best !== this.planBest) {
      this.planBest = choice.best;
      this.planSinceMs = now;
    }
    const idle = this.mem.idleSinceMs !== null && now - this.mem.idleSinceMs >= ADVICE_IDLE_MS;
    if (this.mem.idleSinceMs === null) this.idleAdvised = false;

    if (ev.respawned) return 'respawn';
    if (this.prevInFight && !this.mem.inFight) return 'fight-over';
    if (ev.levelUp === 6) return 'level6';
    if (ev.roshanKilled || ev.aegisPicked) return 'objective';
    const attacked = this.mem.marks.get('bld-attack@');
    if (attacked !== undefined && attacked === now) return 'building';
    if (ev.newItems.some((k) => (this.look.itemCost(k) ?? 0) >= 1500 && !this.look.isComponent(k))) return 'item';
    if (dead >= 2 && prevDead < 2) return 'enemies-dead';
    if (Math.abs(missing - prevMissing) >= 2) return 'map';
    if (idle && !this.idleAdvised) {
      this.idleAdvised = true;
      return 'idle';
    }
    if (this.planAdvised !== null && choice.best !== this.planAdvised && now - this.planSinceMs >= ADVICE_PLAN_STABLE_MS) return 'plan-change';
    if (this.planAdvised === null && (v.clock.value ?? -1) >= 0) return 'first';
    return null;
  }

  private maybeAdvise(ctx: RuleContext): void {
    const { v, now } = ctx;
    if (v.me.alive.value !== true || this.mem.inFight) return;
    const choice = actionChoice(v, this.mem, this.look, this.settings.minPercentConfidence);
    const reason = this.adviceTrigger(ctx, choice);
    if (!reason || !choice.showable) return;
    const sig = this.adviceSig(v, choice);
    const cached = this.adviceCache.get(sig);
    // Та же обстановка — совет уже был; после важного события напоминаем его из кэша (модель не спрашиваем)
    if (sig === this.lastAdviceSig && now - this.lastAdviceSigMs < ADVICE_SAME_MS) {
      this.planAdvised = choice.best;
      if (ADVICE_REPEAT_REASONS.has(reason) && cached) {
        this.lastAdviceReason = reason;
        this.showAdvice(cached.advice, choice, v.clock.value);
      }
      return;
    }
    // Готовый ответ для такой обстановки — без обращения к модели
    if (cached && now - cached.ms < ADVICE_CACHE_MS) {
      this.markAdvised(sig, choice, now, reason);
      this.showAdvice(cached.advice, choice, ctx.v.clock.value);
      return;
    }
    if (now - this.lastAdviceAskMs < ADVICE_MIN_GAP_MS || this.ai!.pending('advice') > 0 || !this.ai!.available) return;
    this.lastAdviceAskMs = now;
    this.markAdvised(sig, choice, now, reason);
    this.askAdvice(ctx, choice, sig);
  }

  private markAdvised(sig: string, choice: ActionChoice, now: number, reason: string): void {
    this.lastAdviceSig = sig;
    this.lastAdviceSigMs = now;
    this.planAdvised = choice.best;
    this.lastAdviceReason = reason;
  }

  private showAdvice(value: Advice, choice: ActionChoice, clock: number | null): void {
    const short = `${ACTION_RU[value.action]}: ${DESTINATION_RU(value.where)}`;
    const d = draft({
      id: 'ai.advice',
      category: 'macro',
      priority: value.action === 'retreat' ? 'advice' : 'info',
      confidence: Math.min(0.85, choice.confidence),
      short,
      normal: value.say,
      detailed: `${value.say} · Оценка коуча: ${(Object.keys(choice.percents) as (keyof typeof choice.percents)[]).map((k) => `${ACTION_RU[k].toLowerCase()} ${choice.percents[k]}%`).join(', ')}`,
      facts: [{ key: 'ai-advice', label: 'Совет ИИ', value: value.say, source: 'derived', ageSec: 0, confidence: choice.confidence, verified: true }],
      ttlSec: 12,
      cooldownSec: 0,
      zone: 'decision',
    });
    const r = this.queue.push(d, { now: this.now(), clock, inFight: this.mem.inFight, settings: this.settings });
    if (!r.hint) return;
    r.hint.textSource = 'ai';
    if (r.status === 'shown') {
      this.asyncShown.push(r.hint);
      this.log({ wallMs: this.now(), clock, kind: 'hint', id: r.hint.id, text: `${short} — ${value.say}`, source: 'ai' });
    } else this.asyncChanged.push(r.hint);
    this.opts.onAsync?.();
  }

  private askAdvice(ctx: RuleContext, choice: ActionChoice, sig: string): void {
    const opts = adviceOptions(ctx.v, choice);
    const facts = adviceFacts(ctx.v, choice, opts);
    const p = buildAdvicePrompt(facts, opts);
    const deathsAtAsk = this.mem.deaths.length;
    this.ai!.enqueue<Advice>({
      kind: 'advice',
      key: 'advice',
      system: p.system,
      user: p.user,
      facts,
      validate: (t) => parseAdvice(t, opts, facts),
      createdMs: this.now(),
      staleMs: 15_000,
      onResult: ({ value }) => {
        const c = this.lastCtx;
        if (!value) return;
        this.adviceCache.set(sig, { advice: value, choice, ms: this.now() });
        if (this.adviceCache.size > 40) this.adviceCache.delete(this.adviceCache.keys().next().value!);
        // Пока ИИ думал, герой умер, начал драку или обстановка сменилась — совет устарел
        if (!c || this.mem.deaths.length !== deathsAtAsk || this.mem.inFight || c.v.me.alive.value !== true) return;
        if (this.adviceSig(c.v, actionChoice(c.v, this.mem, this.look, this.settings.minPercentConfidence)) !== sig) return;
        this.showAdvice(value, choice, c.v.clock.value);
      },
    });
  }

  private askPhrase(h: Hint): void {
    const p = phrasePrompt(h);
    this.ai!.enqueue<string>({
      kind: 'phrase',
      key: `phrase:${h.seq}`,
      system: p.system,
      user: p.user,
      facts: p.facts,
      validate: validateText(p.facts, 16),
      createdMs: this.now(),
      staleMs: Math.max(2000, h.ttlMs - 4000),
      onResult: ({ value }) => {
        if (!value) return;
        this.phraseCache.set(`${h.ruleId}|${h.short}`, value);
        if (this.phraseCache.size > 100) this.phraseCache.delete(this.phraseCache.keys().next().value!);
        this.changedText(h.seq, value, 'normal');
      },
    });
  }

  private askMistake(m: Mistake): void {
    if (!this.ai) return;
    const p = mistakePrompt(m);
    this.ai.enqueue<string>({
      kind: 'mistake',
      key: `mistake:${m.id}`,
      system: p.system,
      user: p.user,
      facts: p.facts,
      validate: validateText(p.facts, 24),
      createdMs: this.now(),
      staleMs: 120_000,
      onResult: ({ value }) => {
        m.aiText = value;
      },
    });
  }

  private askDeath(r: DeathReview): void {
    if (!this.ai) return;
    const p = deathPrompt(r);
    const seq = this.reviewHintSeq;
    this.ai.enqueue<string>({
      kind: 'death',
      key: `death:${r.index}`,
      system: p.system,
      user: p.user,
      facts: p.facts,
      validate: validateText(p.facts, 60),
      createdMs: this.now(),
      staleMs: Math.max(5000, (r.respawnSec ?? 20) * 1000 - 5000),
      onResult: ({ value }) => {
        if (!value) return;
        r.aiText = value;
        this.changedText(seq, value.replace(/\n+/g, ' '), 'both');
      },
    });
  }

  private askMatch(r: MatchReview): void {
    if (!this.ai) return;
    const p = matchPrompt(r);
    this.ai.enqueue<string>({
      kind: 'match',
      key: 'match',
      system: p.system,
      user: p.user,
      facts: p.facts,
      validate: validateText(p.facts, 200),
      createdMs: this.now(),
      staleMs: 300_000,
      onResult: ({ value }) => {
        if (!value) return;
        r.aiText = value;
        const h = this.queue.visible().find((x) => x.id === 'review.match');
        if (h) this.changedText(h.seq, value.replace(/\n+/g, ' '), 'both');
      },
    });
  }

  /** Время матча для заголовков истории */
  clockText(): string | null {
    const c = this.lastView?.clock.value;
    return c === null || c === undefined ? null : mmss(c);
  }
}
