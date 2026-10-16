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
import { ACTION_RU, actionChoice } from './prob.ts';
import { buildView, type CoachView } from './view.ts';
import { draft, mmss, type Rule, type RuleContext } from './rules/context.ts';
import { FIGHT_RULES, matchupsOnDemand } from './rules/fight.ts';
import { DANGER_RULES } from './rules/danger.ts';
import { LANING_RULES } from './rules/laning.ts';
import { ECONOMY_RULES, GOLD_HIGH } from './rules/economy.ts';
import { MACRO_RULES } from './rules/macro.ts';
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

export const ALL_RULES: Rule[] = [...DANGER_RULES, ...FIGHT_RULES, ...MACRO_RULES, ...LANING_RULES, ...ECONOMY_RULES];
/** Как часто просить у ИИ совет «что делать и куда идти» */
export const ADVICE_EVERY_MS = 20_000;
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
  private lastAdviceMs = 0;
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

  private log(e: JournalEntry): void {
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
        this.askMistake(m);
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
    }

    // 5. Совет ИИ «что делать и куда идти» — постоянно, пока герой жив и не в драке
    if (this.ai && this.settings.aiLive && v.inGame && !v.paused && v.me.alive.value === true && !this.mem.inFight && v.wallMs - this.lastAdviceMs >= ADVICE_EVERY_MS && this.ai.pending('advice') === 0 && this.ai.available) {
      this.lastAdviceMs = v.wallMs;
      this.askAdvice(ctx);
    }

    // 6. Пересказ ИИ для важных советов на экране (если модель свободна)
    if (this.ai && this.settings.detail !== 'min' && !this.ai.busy && this.ai.available) {
      const h = shown.find((x) => x.priority === 'advice' && x.textSource === 'template' && x.ttlMs >= 8000 && x.category !== 'review');
      if (h) this.askPhrase(h);
    }

    const expired = this.queue.tick(v.wallMs);
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

  private askAdvice(ctx: RuleContext): void {
    const choice = actionChoice(ctx.v, this.mem, this.look, this.settings.minPercentConfidence);
    if (!choice.showable) return;
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
        // Пока ИИ думал, герой умер или начал драку — совет устарел
        if (!value || !c || this.mem.deaths.length !== deathsAtAsk || this.mem.inFight || c.v.me.alive.value !== true) return;
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
          cooldownSec: 15,
          zone: 'decision',
        });
        const r = this.queue.push(d, { now: this.now(), clock: c.v.clock.value, inFight: this.mem.inFight, settings: this.settings });
        if (r.hint) {
          r.hint.textSource = 'ai';
          if (r.status === 'shown') {
            this.asyncShown.push(r.hint);
            this.log({ wallMs: this.now(), clock: c.v.clock.value, kind: 'hint', id: r.hint.id, text: `${short} — ${value.say}`, source: 'ai' });
          } else this.asyncChanged.push(r.hint);
          this.opts.onAsync?.();
        }
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
        if (value) this.changedText(h.seq, value, 'normal');
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
