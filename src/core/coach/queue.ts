// H. Очередь подсказок против спама: приоритеты, не больше N на зону, кулдауны подсказки и категории, слияние
// повторов, вытеснение важным, автоудаление по TTL, тишина в драке для неважного, общий лимит в минуту.
import { PRIORITY_RANK, type CoachSettings, type Hint, type HintCategory, type HintDraft, type HintZone, DEFAULT_ZONE } from './types.ts';

export interface QueueConfig {
  maxPerZone: Record<HintZone, number>;
  /** Минимальный промежуток между новыми подсказками одной категории */
  categoryGapMs: Record<HintCategory, number>;
  /** Не больше стольких новых некритичных подсказок за минуту */
  maxPerMinute: number;
  /** Категории, которые не замолкают в драке (критичные проходят всегда) */
  inFightAllowed: HintCategory[];
}

export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxPerZone: { alert: 1, decision: 2, timing: 3, review: 1 },
  categoryGapMs: { danger: 4000, fight: 3000, laning: 20_000, economy: 20_000, macro: 10_000, timing: 3000, mistake: 30_000, review: 0 },
  maxPerMinute: 8,
  inFightAllowed: ['fight', 'danger'],
};

export type DropReason = 'disabled' | 'low-confidence' | 'percent-uncertain' | 'cooldown' | 'category-gap' | 'in-fight' | 'rate' | 'zone-full';

export interface PushResult {
  hint: Hint | null;
  /** merged — та же подсказка уже на экране, обновлена */
  status: 'shown' | 'merged' | 'dropped';
  reason?: DropReason;
  /** Вытесненные подсказки (освободили место для важной) */
  evicted: Hint[];
}

export interface PushContext {
  now: number;
  clock: number | null;
  inFight: boolean;
  settings: CoachSettings;
}

export class HintQueue {
  private visibleHints: Hint[] = [];
  private lastById = new Map<string, number>();
  private lastByCategory = new Map<HintCategory, number>();
  private shownAt: number[] = [];
  private seq = 0;
  readonly dropped: Record<DropReason, number> = { disabled: 0, 'low-confidence': 0, 'percent-uncertain': 0, cooldown: 0, 'category-gap': 0, 'in-fight': 0, rate: 0, 'zone-full': 0 };
  shownTotal = 0;

  constructor(readonly config: QueueConfig = DEFAULT_QUEUE_CONFIG) {}

  reset(): void {
    this.visibleHints = [];
    this.lastById.clear();
    this.lastByCategory.clear();
    this.shownAt = [];
  }

  visible(zone?: HintZone): Hint[] {
    return zone ? this.visibleHints.filter((h) => h.zone === zone) : [...this.visibleHints];
  }

  /** Удаляет подсказки с истёкшим TTL; возвращает удалённые */
  tick(now: number): Hint[] {
    const gone = this.visibleHints.filter((h) => h.expiresWallMs <= now);
    if (gone.length) this.visibleHints = this.visibleHints.filter((h) => h.expiresWallMs > now);
    return gone;
  }

  dismiss(seq: number): Hint | null {
    const h = this.visibleHints.find((x) => x.seq === seq) ?? null;
    if (h) this.visibleHints = this.visibleHints.filter((x) => x.seq !== seq);
    return h;
  }

  /** Новый текст подсказки на экране (например, от ИИ) */
  updateText(seq: number, patch: Partial<Pick<Hint, 'short' | 'detail' | 'textSource'>>): Hint | null {
    const h = this.visibleHints.find((x) => x.seq === seq);
    if (!h) return null;
    Object.assign(h, patch);
    return h;
  }

  /** Сколько новых подсказок показано за последнюю минуту */
  perMinute(now: number): number {
    return this.shownAt.filter((t) => now - t < 60_000).length;
  }

  push(d: HintDraft, ctx: PushContext): PushResult {
    const drop = (reason: DropReason): PushResult => {
      this.dropped[reason]++;
      return { hint: null, status: 'dropped', reason, evicted: [] };
    };
    const { now, settings } = ctx;
    if (!settings.categories[d.category]) return drop('disabled');
    if (d.confidence < settings.minConfidence[d.priority]) return drop('low-confidence');
    if (d.percent && (!d.percent.estimate.showable || d.percent.estimate.confidence < settings.minPercentConfidence)) return drop('percent-uncertain');

    const zone = d.zone ?? DEFAULT_ZONE[d.category];
    const same = this.visibleHints.find((h) => h.id === d.id);
    if (same) {
      // Повтор: обновляем содержимое и продлеваем, номер показа сохраняем; текст ИИ не затираем шаблоном
      const keepDetail = same.textSource === 'ai' ? same.detail : d.detail;
      Object.assign(same, { ...d, zone, detail: keepDetail, seq: same.seq, createdWallMs: same.createdWallMs, textSource: same.textSource, expiresWallMs: Math.max(same.expiresWallMs, now + d.ttlMs) });
      this.lastById.set(d.id, now);
      return { hint: same, status: 'merged', evicted: [] };
    }

    const last = this.lastById.get(d.id);
    if (last !== undefined && now - last < d.cooldownMs) return drop('cooldown');
    const critical = d.priority === 'critical';
    const review = d.category === 'review';
    if (!critical && !review) {
      const lastCat = this.lastByCategory.get(d.category);
      if (lastCat !== undefined && now - lastCat < this.config.categoryGapMs[d.category]) return drop('category-gap');
      if (ctx.inFight && !this.config.inFightAllowed.includes(d.category)) return drop('in-fight');
      if (this.perMinute(now) >= this.config.maxPerMinute) return drop('rate');
    }

    const inZone = this.visibleHints.filter((h) => h.zone === zone);
    const evicted: Hint[] = [];
    if (inZone.length >= this.config.maxPerZone[zone]) {
      // Вытесняем самую неважную (и самую старую среди равных), если новая важнее — или критичная
      const weakest = [...inZone].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdWallMs - b.createdWallMs)[0]!;
      const stronger = PRIORITY_RANK[d.priority] > PRIORITY_RANK[weakest.priority] || (critical && weakest.priority === 'critical') || review;
      if (!stronger) return drop('zone-full');
      this.visibleHints = this.visibleHints.filter((h) => h !== weakest);
      evicted.push(weakest);
    }

    const hint: Hint = { ...d, zone, seq: ++this.seq, createdWallMs: now, expiresWallMs: now + d.ttlMs, clock: ctx.clock, textSource: 'template' };
    this.visibleHints.push(hint);
    // Важное — первым в своей зоне
    this.visibleHints.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdWallMs - b.createdWallMs);
    this.lastById.set(d.id, now);
    this.lastByCategory.set(d.category, now);
    if (!critical && !review) this.shownAt.push(now);
    this.shownAt = this.shownAt.filter((t) => now - t < 60_000);
    this.shownTotal++;
    return { hint, status: 'shown', evicted };
  }
}
