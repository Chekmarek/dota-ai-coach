// Фильтр внимания (attention gate): получает все подсказки генераторов за тик и решает, что показать сейчас,
// что отложить до спокойного момента и что выбросить — с причиной. Правила:
//  - бюджет: несрочная — не больше одной за budgetMs; тот же тип — не чаще своего кулдауна; та же фраза — не чаще
//    repeatTextMs; срочная проходит мимо бюджета, но со своим кулдауном на тип;
//  - момент: в драке проходят только срочные, на экране остаются только они; несрочные ждут спокойного момента
//    (мёртв, пауза, до горна, на базе, идёт на базу, тихо) и уходят, если устарели или ситуация прошла;
//  - очевидное: предмет уже есть, уже у руны; уверенность ниже minConfidence — не в игре, а в разбор матча;
//  - «не нужно» (горячая клавиша): тип последней показанной подсказки молчит до конца матча; после «не нужно»
//    в demoteAfterMutes разных матчах тип понижается до info;
//  - метрики по типу: показана / выполнена (эвристика) / проигнорирована / «не нужно» / не проверить.
// Чистое ядро: время и сигналы приходят снаружи.
import { type HintCategory, type HintDraft } from '../coach/types.ts';
import { MomentTracker } from './moment.ts';
import { itemKeyOf, isRetreat, toGateHint, type GateNames } from './derive.ts';
import {
  DEFAULT_GATE_CONFIG,
  GATE_PRIORITY_RANK,
  emptyGateMemory,
  type CalmKind,
  type GateConfig,
  type GateDebug,
  type GateDecision,
  type GateHint,
  type GateMemoryState,
  type GateMoment,
  type GateSignals,
  type GateVisible,
  type SuppressReason,
  type TypeMetrics,
} from './types.ts';

/** Номера показов фильтра — вне номеров очереди движка (разборы идут оттуда) и подтверждений (1e12) */
export const GATE_SEQ_BASE = 1_000_000_000;
/** Ситуативная подсказка на экране без подтверждения дольше — снимается (как в очереди движка) */
const VISIBLE_STALE_MS = 2500;
/** Спокойные моменты, когда к короткой фразе можно добавить подробности */
const DETAIL_CALM: ReadonlySet<CalmKind> = new Set(['dead', 'paused', 'pregame', 'base']);
/** Порядок категорий при равной важности: что важно прямо сейчас — раньше */
const CATEGORY_RANK: Record<HintCategory, number> = { review: 8, danger: 7, fight: 6, timing: 5, macro: 4, laning: 3, economy: 2, mistake: 1 };
/** Окна проверки «выполнил ли совет» */
const ACT_ITEM_MS = 90_000;
const ACT_RETREAT_MS = 10_000;
const ACT_RETREAT_UNITS = 700;
/** «Выжил после совета»: не умер столько мс после показа «Отходи» */
export const SURVIVE_MS = 15_000;
const ACT_RUNE_MS = 30_000;
const ACT_RUNE_UNITS = 900;
const ACT_GENERIC_MS = 30_000;
const RECENT_DECISIONS = 30;
const MUTES_KEEP = 10;

interface Offer {
  hint: GateHint;
  firstMs: number;
  lastMs: number;
  confirms: number;
  status: 'waiting' | 'shown' | 'done';
  /** Почему ждёт (итоговая причина, если так и не покажется) */
  wait: SuppressReason | null;
}

interface Pending {
  seq: number;
  key: string;
  type: string;
  shownMs: number;
  itemKey: string | null;
  retreat: boolean;
  rune: boolean;
  generic: boolean;
  startBase: number | null;
  short: string;
  /** «Отходи»: игрок отошёл (решается за ACT_RETREAT_MS) */
  followed?: true;
}

/** Итог показанной подсказки: выполнил ли игрок; у «Отходи» — ещё и выжил ли за 15 с */
export interface HintOutcome {
  shownMs: number;
  type: string;
  short: string;
  result: 'acted' | 'ignored' | 'unclear';
  /** null — не проверяется (не «Отходи») */
  survived: boolean | null;
}

export interface GateTickInput {
  signals: GateSignals;
  /** Все подсказки генераторов за тик (повторы ситуативных — каждый тик) */
  offered: readonly HintDraft[];
  /** Какие категории включены в настройках; нет — все */
  categories?: Partial<Record<HintCategory, boolean>>;
}

export interface GateTickResult {
  visible: GateVisible[];
  /** Показаны впервые на этом тике */
  shown: GateVisible[];
  moment: GateMoment;
}

export class AttentionGate {
  readonly cfg: GateConfig;
  private readonly tracker: MomentTracker;
  private offers = new Map<string, Offer>();
  private vis: GateVisible[] = [];
  private lastTypeMs = new Map<string, number>();
  private lastTextMs = new Map<string, number>();
  private lastNonCriticalMs = -Infinity;
  private seq = GATE_SEQ_BASE;
  private matchId: string | null = null;
  private mutedNow = new Set<string>();
  private deferred = new Map<string, { short: string; count: number }>();
  private received = 0;
  private shownCount = 0;
  private suppressed: Partial<Record<SuppressReason, number>> = {};
  private recent: GateDecision[] = [];
  private pending: Pending[] = [];
  private lastMoment: GateMoment = { fight: false, calm: null, why: [] };
  private lastNow = 0;
  /** Последняя показанная (для «не нужно», даже если карточка уже ушла) */
  private lastShownV: GateVisible | null = null;
  private mem: GateMemoryState;

  constructor(cfg: Partial<GateConfig> = {}, memory: GateMemoryState | null = null, private readonly names: GateNames = {}) {
    this.cfg = { ...DEFAULT_GATE_CONFIG, ...cfg };
    this.tracker = new MomentTracker(this.cfg);
    this.mem = memory ? structuredClone(memory) : emptyGateMemory();
  }

  /** Новые настройки (бюджет, порог уверенности) — без сброса состояния */
  configure(cfg: Partial<GateConfig>): void {
    Object.assign(this.cfg, cfg);
  }

  /** Новый матч: очередь, «не нужно» на матч и счётчики — заново; хранимое между матчами остаётся */
  resetMatch(matchId: string | null): void {
    this.matchId = matchId;
    this.offers.clear();
    this.vis = [];
    this.lastTypeMs.clear();
    this.lastTextMs.clear();
    this.lastNonCriticalMs = -Infinity;
    this.mutedNow.clear();
    this.deferred.clear();
    this.received = 0;
    this.shownCount = 0;
    this.suppressed = {};
    this.recent = [];
    this.pending = [];
    this.tracker.reset();
  }

  isDemoted(type: string): boolean {
    return (this.mem.mutes[type]?.length ?? 0) >= this.cfg.demoteAfterMutes;
  }

  get memory(): GateMemoryState {
    return this.mem;
  }

  visible(): GateVisible[] {
    return [...this.vis];
  }

  get moment(): GateMoment {
    return this.lastMoment;
  }

  /** Ушло в разбор матча из-за низкой уверенности */
  deferredForReview(): { type: string; short: string; count: number }[] {
    return [...this.deferred].map(([type, v]) => ({ type, ...v })).sort((a, b) => b.count - a.count);
  }

  tick(input: GateTickInput): GateTickResult {
    const s = input.signals;
    const now = s.nowMs;
    this.lastNow = now;
    if (s.matchId !== null && s.matchId !== this.matchId) this.resetMatch(s.matchId);
    const moment = this.tracker.update(s);
    this.lastMoment = moment;
    if (!s.inGame) {
      // Вне матча — ничего не ждёт и не висит (разборы идут мимо фильтра)
      for (const o of this.offers.values()) if (o.status === 'waiting') this.finish(o, o.wait ?? 'expired', now);
      this.offers.clear();
      this.vis = [];
      return { visible: [], shown: [], moment };
    }

    // 1. Подсказки генераторов: новые — в очередь, повторы — подтверждение
    for (const d of input.offered) {
      if (d.category === 'review') continue;
      const type = d.ruleId || d.id.split(':')[0]!;
      const h = toGateHint(d, { nowMs: now, names: this.names, demoted: this.isDemoted(type), focus: this.cfg.focusTypes.includes(type) });
      let o = this.offers.get(h.key);
      if (o && !(o.status === 'done' && now - o.lastMs > this.cfg.staleMs)) {
        o.lastMs = now;
        o.confirms++;
        o.hint = { ...h, expiresAt: h.repeating ? h.expiresAt : o.hint.expiresAt };
        const v = this.vis.find((x) => x.hint.key === h.key);
        if (v) {
          v.hint = o.hint;
          if (h.priority === 'critical' && h.repeating) v.untilMs = Math.max(v.untilMs, now + d.ttlMs);
        }
        continue;
      }
      o = { hint: h, firstMs: now, lastMs: now, confirms: 1, status: 'waiting', wait: null };
      this.offers.set(h.key, o);
      this.received++;
      if (input.categories && input.categories[h.category] === false) this.finish(o, 'disabled', now);
      else if (this.mutedNow.has(h.type)) this.finish(o, 'muted', now);
      else if (h.confidence < this.cfg.minConfidence) {
        const prev = this.deferred.get(h.type);
        this.deferred.set(h.type, { short: h.short, count: (prev?.count ?? 0) + 1 });
        this.finish(o, 'low-confidence', now);
      }
    }

    // 2. Экран: истёкшие, устаревшие ситуативные; в драке — только срочные
    this.vis = this.vis.filter((v) => {
      const o = this.offers.get(v.hint.key);
      if (now >= v.untilMs) return false;
      if (v.hint.repeating && o && o.confirms >= 2 && now - o.lastMs > VISIBLE_STALE_MS) return false;
      if (moment.fight && v.hint.priority !== 'critical') return false;
      return true;
    });
    for (const o of this.offers.values()) if (o.status === 'shown' && !this.vis.some((v) => v.hint.key === o.hint.key)) o.status = 'done';

    // 3. Ждущие: устарели, сделано, или кандидаты на показ
    const critical: Offer[] = [];
    const calm: Offer[] = [];
    for (const o of this.offers.values()) {
      if (o.status !== 'waiting') continue;
      const h = o.hint;
      if (h.repeating && now - o.lastMs > this.cfg.staleMs) {
        this.finish(o, o.wait ?? 'stale', now);
        continue;
      }
      if ((!h.repeating && now >= h.expiresAt) || now - o.firstMs > this.cfg.maxWaitMs) {
        this.finish(o, o.wait ?? 'expired', now);
        continue;
      }
      if (this.alreadyDone(h, s)) {
        this.finish(o, 'already-done', now);
        continue;
      }
      if (h.priority === 'critical') {
        const last = this.lastTypeMs.get(h.type);
        if (last !== undefined && now - last < (this.cfg.typeCooldownMs[h.type] ?? this.cfg.criticalCooldownMs)) o.wait = 'cooldown';
        else critical.push(o);
        continue;
      }
      const lastType = this.lastTypeMs.get(h.type);
      const lastText = this.lastTextMs.get(h.short);
      if (moment.fight) o.wait = 'fight';
      else if (moment.calm === null) o.wait = 'busy';
      else if (lastType !== undefined && now - lastType < (this.cfg.typeCooldownMs[h.type] ?? this.cfg.defaultTypeCooldownMs)) o.wait = 'cooldown';
      else if (lastText !== undefined && now - lastText < this.cfg.repeatTextMs) o.wait = 'duplicate';
      else if (now - this.lastNonCriticalMs < (h.focus ? this.cfg.budgetMs / 2 : this.cfg.budgetMs)) o.wait = 'budget';
      else calm.push(o);
    }

    // 4. Показ: срочные — сразу (вытесняют несрочную), несрочная — одна, лучшая
    const shown: GateVisible[] = [];
    critical.sort((a, b) => b.hint.confidence - a.hint.confidence || a.firstMs - b.firstMs);
    for (const o of critical) {
      if (this.vis.length >= this.cfg.maxVisible) {
        const weak = this.vis.find((v) => v.hint.priority !== 'critical');
        if (!weak) {
          o.wait = 'busy';
          continue;
        }
        this.vis = this.vis.filter((v) => v !== weak);
        const wo = this.offers.get(weak.hint.key);
        if (wo) wo.status = 'done';
      }
      shown.push(this.show(o, now, moment, s));
    }
    if (calm.length && !this.vis.some((v) => v.hint.priority !== 'critical') && this.vis.length < this.cfg.maxVisible) {
      calm.sort((a, b) => Number(b.hint.focus) - Number(a.hint.focus) || GATE_PRIORITY_RANK[b.hint.priority] - GATE_PRIORITY_RANK[a.hint.priority] || CATEGORY_RANK[b.hint.category] - CATEGORY_RANK[a.hint.category] || b.hint.confidence - a.hint.confidence || a.firstMs - b.firstMs);
      shown.push(this.show(calm[0]!, now, moment, s));
      for (const o of calm.slice(1)) o.wait = 'budget';
    } else for (const o of calm) o.wait = this.vis.length ? 'busy' : 'budget';

    // 5. Метрики: выполнил ли игрок показанный совет
    this.evaluate(s);
    // старые завершённые — из памяти
    for (const [k, o] of this.offers) if (o.status === 'done' && now - o.lastMs > 60_000) this.offers.delete(k);
    return { visible: this.visible(), shown, moment };
  }

  private alreadyDone(h: GateHint, s: GateSignals): boolean {
    const item = itemKeyOf(h);
    if (item && s.items?.includes(item)) return true;
    if (h.type.startsWith('timing.rune-') && s.distToRune !== null && s.distToRune <= ACT_RUNE_UNITS) return true;
    return false;
  }

  private show(o: Offer, now: number, moment: GateMoment, s: GateSignals): GateVisible {
    const h = o.hint;
    o.status = 'shown';
    o.wait = null;
    const ttl = Math.max(0, h.expiresAt - now);
    const untilMs = h.priority === 'critical' ? now + Math.max(this.cfg.minShowMs, ttl) : now + Math.min(this.cfg.maxShowMs, Math.max(this.cfg.minShowMs, ttl));
    const v: GateVisible = { seq: ++this.seq, hint: h, shownMs: now, untilMs, withDetails: moment.calm !== null && DETAIL_CALM.has(moment.calm) };
    this.vis.push(v);
    this.vis.sort((a, b) => GATE_PRIORITY_RANK[b.hint.priority] - GATE_PRIORITY_RANK[a.hint.priority] || a.shownMs - b.shownMs);
    this.lastTypeMs.set(h.type, now);
    if (h.priority !== 'critical') {
      this.lastTextMs.set(h.short, now);
      this.lastNonCriticalMs = now;
    }
    this.shownCount++;
    this.metric(h.type).shown++;
    this.decide(h, 'shown', now);
    const rune = h.type.startsWith('timing.rune-');
    const itemKey = itemKeyOf(h);
    const retreat = isRetreat(h);
    this.pending.push({
      seq: v.seq,
      key: h.key,
      type: h.type,
      shownMs: now,
      itemKey,
      retreat,
      rune,
      generic: !itemKey && !retreat && !rune && h.repeating && (h.category === 'economy' || h.category === 'laning' || h.category === 'macro'),
      startBase: s.distToBase,
      short: h.short,
    });
    return v;
  }

  /**
   * Выполнил ли игрок совет — эвристика по сигналам: предмет появился за 90 с; «отходи» — за 10 с стал ближе к базе
   * на 700 ед. (умер — не выполнил); руна — за 30 с подошёл к руне; повторяющийся совет экономики, линии и макро —
   * генератор перестал его подтверждать за 30 с (ситуация решена). Остальное проверить нечем — «не проверить».
   */
  private evaluate(s: GateSignals): void {
    const now = s.nowMs;
    const keep: Pending[] = [];
    for (const p of this.pending) {
      const age = now - p.shownMs;
      let out: keyof TypeMetrics | null = null;
      let survived: boolean | null = null;
      if (p.itemKey) out = s.items?.includes(p.itemKey) ? 'acted' : age > ACT_ITEM_MS ? 'ignored' : null;
      else if (p.retreat) {
        // «Отходи»: выполнил — за 10 с стал на 700 ед. ближе к базе; выжил — не умер за 15 с после показа
        if (p.followed === undefined && age <= ACT_RETREAT_MS && s.alive !== false && p.startBase !== null && s.distToBase !== null && p.startBase - s.distToBase >= ACT_RETREAT_UNITS) p.followed = true;
        if (s.alive === false || age >= SURVIVE_MS) {
          survived = s.alive !== false;
          out = p.followed ? 'acted' : 'ignored';
        }
      } else if (p.rune) out = s.distToRune !== null && s.distToRune <= ACT_RUNE_UNITS ? 'acted' : age > ACT_RUNE_MS ? 'ignored' : null;
      else if (p.generic) {
        const o = this.offers.get(p.key);
        if (s.alive === false) out = 'ignored';
        else if (!o || now - o.lastMs > this.cfg.staleMs) out = 'acted';
        else if (age > ACT_GENERIC_MS) out = 'ignored';
      } else out = 'unclear';
      if (out) {
        this.metric(p.type)[out]++;
        this.outcomes.push({ shownMs: p.shownMs, type: p.type, short: p.short, result: out === 'acted' || out === 'ignored' ? out : 'unclear', survived });
      } else keep.push(p);
    }
    this.pending = keep;
  }

  /** Итоги показанных подсказок с прошлого вызова (для истории матча и статистики доверия) */
  drainOutcomes(): HintOutcome[] {
    const out = this.outcomes;
    this.outcomes = [];
    return out;
  }
  private outcomes: HintOutcome[] = [];

  /**
   * «Не нужно»: тип последней показанной подсказки молчит до конца матча, карточка уходит; в хранимое — матч.
   * Возвращает тип, короткую фразу и понижен ли тип теперь; null — нечего отключать.
   */
  mute(nowMs: number): { type: string; short: string; demoted: boolean } | null {
    const last = [...this.vis].sort((a, b) => b.shownMs - a.shownMs)[0] ?? this.lastShownV;
    if (!last || nowMs - last.shownMs > 60_000) return null;
    const type = last.hint.type;
    this.mutedNow.add(type);
    this.vis = this.vis.filter((v) => v.hint.type !== type);
    const match = this.matchId ?? `local-${new Date(last.shownMs).toISOString().slice(0, 10)}`;
    const list = this.mem.mutes[type] ?? [];
    const firstThisMatch = !list.includes(match);
    if (firstThisMatch) this.mem.mutes[type] = [...list, match].slice(-MUTES_KEEP);
    this.metric(type).muted++;
    // показанная только что подсказка этого типа считается «не нужно», а не «проигнорирована»
    this.pending = this.pending.filter((p) => p.type !== type);
    for (const o of this.offers.values()) if (o.hint.type === type && o.status === 'waiting') this.finish(o, 'muted', nowMs);
    return { type, short: last.hint.short, demoted: this.isDemoted(type) };
  }

  private metric(type: string): TypeMetrics {
    return (this.mem.metrics[type] ??= { shown: 0, acted: 0, ignored: 0, muted: 0, unclear: 0 });
  }

  private finish(o: Offer, reason: SuppressReason, now: number): void {
    o.status = 'done';
    o.wait = reason;
    this.suppressed[reason] = (this.suppressed[reason] ?? 0) + 1;
    this.decide(o.hint, reason, now);
  }

  private decide(h: GateHint, outcome: GateDecision['outcome'], now: number): void {
    if (outcome === 'shown') this.lastShownV = this.vis.find((v) => v.hint.key === h.key) ?? this.lastShownV;
    this.recent.push({ atMs: now, type: h.type, short: h.short, priority: h.priority, outcome });
    if (this.recent.length > RECENT_DECISIONS) this.recent.splice(0, this.recent.length - RECENT_DECISIONS);
  }

  debug(enabled = true): GateDebug {
    return {
      enabled,
      moment: { fight: this.lastMoment.fight, calm: this.lastMoment.calm, why: this.lastMoment.why },
      received: this.received,
      shown: this.shownCount,
      suppressed: { ...this.suppressed },
      waiting: [...this.offers.values()].filter((o) => o.status === 'waiting').length,
      budgetInSec: Math.max(0, Math.ceil((this.cfg.budgetMs - (this.lastNow - this.lastNonCriticalMs)) / 1000)),
      muted: [...this.mutedNow],
      demoted: Object.keys(this.mem.mutes).filter((t) => this.isDemoted(t)),
      deferred: this.deferredForReview(),
      recent: [...this.recent].reverse(),
    };
  }
}
