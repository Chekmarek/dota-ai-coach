// H. Очередь подсказок против спама: приоритеты, не больше N на зону, кулдауны подсказки и категории, слияние
// повторов, вытеснение важным, автоудаление по TTL, тишина в драке для неважного, общий лимит в минуту,
// снятие устаревших: ситуативная подсказка уходит, когда правило перестало её подтверждать (expireStale).
import { PRIORITY_RANK, type CoachSettings, type Hint, type HintCategory, type HintDraft, type HintZone, DEFAULT_ZONE } from './types.ts';

export interface QueueConfig {
  maxPerZone: Record<HintZone, number>;
  /** Минимальный промежуток между новыми подсказками одной категории */
  categoryGapMs: Record<HintCategory, number>;
  /** Не больше стольких новых некритичных подсказок за минуту */
  maxPerMinute: number;
  /** Категории, которые не замолкают в драке (критичные проходят всегда) */
  inFightAllowed: HintCategory[];
  /** В драке — не чаще одной новой подсказки (и критичной тоже) за столько мс: драку не заваливаем текстом */
  inFightGapMs: number;
  /** Всего на экране одновременно (арбитр: «максимум 1–2») */
  maxVisible: number;
}

// Фильтр качества (этап 5 «понимания игры»): в 5 матчах 18.10 было ~7 подсказок в минуту — лимит 8 почти не работал,
// а критичные шли без лимита. Теперь: 5 в минуту, категории реже, в драке — одна новая раз в 4 с
export const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  maxPerZone: { alert: 1, decision: 2, timing: 3, review: 1 },
  // экономика и линия — как раньше (20 с): спамили драка и опасность, а «Дальше: предмет» и «Простой» иначе терялись
  categoryGapMs: { danger: 8000, fight: 6000, laning: 20_000, economy: 20_000, macro: 15_000, timing: 5000, mistake: 45_000, review: 0 },
  maxPerMinute: 5,
  inFightAllowed: ['fight', 'danger'],
  inFightGapMs: 4000,
  maxVisible: 2,
};

/** Категории «по ситуации»: правило выдаёт подсказку на каждом снимке, пока ситуация есть */
export const SITUATIONAL_CATEGORIES: readonly HintCategory[] = ['danger', 'fight', 'laning', 'macro'];
/** Сколько ждать после последнего подтверждения, прежде чем снять ситуативную подсказку (пропуск снимка — не повод) */
export const STALE_GRACE_MS = 2500;

/** Сколько подсказка должна провисеть, прежде чем новая той же важности её сменит (экран полон) */
export const ROTATE_MS = 4000;

export type DropReason = 'disabled' | 'low-confidence' | 'percent-uncertain' | 'cooldown' | 'category-gap' | 'in-fight' | 'rate' | 'zone-full' | 'conflict' | 'full';

/**
 * Куда зовёт подсказка: «вперёд» (драться, пушить, к руне, к аванпосту, к команде) или «назад» (отходить, враги
 * пропали, мало здоровья, опасный лес). null — ни то ни другое (предметы, тайминги, разборы).
 */
export function stanceOf(h: Pick<HintDraft, 'ruleId' | 'id' | 'short'>): 'go' | 'back' | null {
  const r = h.ruleId;
  if (r === 'fight.disengage' || r === 'danger.low-hp' || r === 'danger.deep' || r === 'danger.smoke' || r === 'danger.missing') return 'back';
  if (r === 'fight.engage') return /^Не вступать/.test(h.short) ? 'back' : /^Вступать/.test(h.short) ? 'go' : null;
  if (r === 'ai.advice') return /^Отходить/.test(h.short) ? 'back' : /^(Драться|Пушить)/.test(h.short) ? 'go' : null;
  if (r === 'macro.push' || r === 'macro.help' || r === 'macro.group' || r === 'macro.outpost' || r === 'fight.ult-ready') return 'go';
  if (r === 'timing.rune-power' || r === 'timing.rune-bounty' || r === 'timing.rune-water' || r === 'timing.lotus' || r === 'timing.stack') return 'go';
  return null;
}

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
  /** Когда показана последняя новая подсказка (кроме разборов) — для тишины в драке */
  private lastShownMs: number | null = null;
  private seq = 0;
  /** Подтверждения правилом: сколько раз подсказка пришла (показ + повторы) и когда последний раз */
  private confirms = new Map<number, { count: number; lastMs: number }>();
  readonly dropped: Record<DropReason, number> = { disabled: 0, 'low-confidence': 0, 'percent-uncertain': 0, cooldown: 0, 'category-gap': 0, 'in-fight': 0, rate: 0, 'zone-full': 0, conflict: 0, full: 0 };
  shownTotal = 0;

  constructor(readonly config: QueueConfig = DEFAULT_QUEUE_CONFIG) {}

  reset(): void {
    this.visibleHints = [];
    this.confirms.clear();
    this.lastById.clear();
    this.lastByCategory.clear();
    this.shownAt = [];
    this.lastShownMs = null;
  }

  visible(zone?: HintZone): Hint[] {
    return zone ? this.visibleHints.filter((h) => h.zone === zone) : [...this.visibleHints];
  }

  /** Удаляет подсказки с истёкшим TTL; возвращает удалённые */
  tick(now: number): Hint[] {
    const gone = this.visibleHints.filter((h) => h.expiresWallMs <= now);
    if (gone.length) this.visibleHints = this.visibleHints.filter((h) => h.expiresWallMs > now);
    for (const h of gone) this.confirms.delete(h.seq);
    return gone;
  }

  dismiss(seq: number): Hint | null {
    const h = this.visibleHints.find((x) => x.seq === seq) ?? null;
    if (h) this.visibleHints = this.visibleHints.filter((x) => x.seq !== seq);
    this.confirms.delete(seq);
    return h;
  }

  /**
   * Снимает ситуативные подсказки, которые правило подтверждало несколько снимков подряд, а теперь перестало
   * (ситуация изменилась) — не дожидаясь TTL. Разовые подсказки по событию (смок, Рошан, уровень) подтверждаются
   * один раз и уходят только по сроку.
   */
  expireStale(now: number, graceMs = STALE_GRACE_MS): Hint[] {
    const stale = this.visibleHints.filter((h) => {
      if (!SITUATIONAL_CATEGORIES.includes(h.category)) return false;
      const c = this.confirms.get(h.seq);
      return !!c && c.count >= 2 && now - c.lastMs >= graceMs;
    });
    if (stale.length) {
      this.visibleHints = this.visibleHints.filter((h) => !stale.includes(h));
      for (const h of stale) this.confirms.delete(h.seq);
    }
    return stale;
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
      // Обновление на месте не должно создавать противоречие: «Не вступать» → «Вступать», пока на экране «Отходи»
      if (stanceOf(d) === 'go' && this.visibleHints.some((h) => h !== same && stanceOf(h) === 'back')) return drop('conflict');
      // Повтор: обновляем содержимое и продлеваем, номер показа сохраняем; текст ИИ не затираем шаблоном
      const keepDetail = same.textSource === 'ai' ? same.detail : d.detail;
      // Продлевается только подсказка «по ситуации» (пока опасность есть — она на экране). Совет экономики
      // («Нет Town Portal Scroll») правило подтверждает каждую секунду — продление держало его на экране бесконечно
      // и не пускало остальные (арбитр, этап 3)
      const extend = SITUATIONAL_CATEGORIES.includes(d.category);
      Object.assign(same, { ...d, zone, detail: keepDetail, seq: same.seq, createdWallMs: same.createdWallMs, textSource: same.textSource, expiresWallMs: extend ? Math.max(same.expiresWallMs, now + d.ttlMs) : same.expiresWallMs });
      this.lastById.set(d.id, now);
      const c = this.confirms.get(same.seq);
      this.confirms.set(same.seq, { count: (c?.count ?? 1) + 1, lastMs: now });
      return { hint: same, status: 'merged', evicted: [] };
    }

    const last = this.lastById.get(d.id);
    if (last !== undefined && now - last < d.cooldownMs) return drop('cooldown');
    const critical = d.priority === 'critical';
    const review = d.category === 'review';
    if (ctx.inFight && !review && this.lastShownMs !== null && now - this.lastShownMs < this.config.inFightGapMs) return drop('in-fight');
    if (!critical && !review) {
      const lastCat = this.lastByCategory.get(d.category);
      if (lastCat !== undefined && now - lastCat < this.config.categoryGapMs[d.category]) return drop('category-gap');
      if (ctx.inFight && !this.config.inFightAllowed.includes(d.category)) return drop('in-fight');
      if (this.perMinute(now) >= this.config.maxPerMinute) return drop('rate');
    }

    // Противоречия (арбитр, ночная задача, этап 3): пока на экране «назад», «вперёд» не показываем;
    // пришло «назад» — висящее «вперёд» убираем. Срочное важнее планового
    const evicted: Hint[] = [];
    const stance = stanceOf(d);
    if (stance === 'go' && this.visibleHints.some((h) => stanceOf(h) === 'back')) return drop('conflict');
    if (stance === 'back') {
      const gone = this.visibleHints.filter((h) => stanceOf(h) === 'go');
      if (gone.length) {
        this.visibleHints = this.visibleHints.filter((h) => !gone.includes(h));
        for (const h of gone) this.confirms.delete(h.seq);
        evicted.push(...gone);
      }
    }

    const inZone = this.visibleHints.filter((h) => h.zone === zone);
    if (inZone.length >= this.config.maxPerZone[zone]) {
      // Вытесняем самую неважную (и самую старую среди равных), если новая важнее — или критичная
      const weakest = [...inZone].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || a.createdWallMs - b.createdWallMs)[0]!;
      const stronger = PRIORITY_RANK[d.priority] > PRIORITY_RANK[weakest.priority] || (critical && weakest.priority === 'critical') || review;
      if (!stronger) return drop('zone-full');
      this.visibleHints = this.visibleHints.filter((h) => h !== weakest);
      this.confirms.delete(weakest.seq);
      evicted.push(weakest);
    }
    // Всего на экране — не больше maxVisible: новая вытесняет самую неважную, только если она важнее
    if (this.visibleHints.length >= this.config.maxVisible) {
      // самая слабая: ниже важность → повторяющаяся (придёт снова) раньше одноразовой → старше
      const oneShot = (h: { cooldownMs: number }) => (h.cooldownMs === 0 ? 1 : 0);
      // Шанс в драке (висит постоянно, пока враги рядом) предупреждение об опасности не вытесняет никогда
      const candidates = d.ruleId === 'fight.engage' ? this.visibleHints.filter((h) => h.category !== 'danger') : this.visibleHints;
      if (!candidates.length) return drop('full');
      const weakest = [...candidates].sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || oneShot(a) - oneShot(b) || a.createdWallMs - b.createdWallMs)[0]!;
      // равная по важности сменяет ту, что уже провисела ROTATE_MS: подсказки чередуются, а не теряются
      // одноразовое событие (без кулдауна: «Рошан убит») при равной важности сразу вытесняет повторяющуюся подсказку —
      // та придёт снова, а событие — нет
      const same = PRIORITY_RANK[d.priority] === PRIORITY_RANK[weakest.priority];
      const stronger = PRIORITY_RANK[d.priority] > PRIORITY_RANK[weakest.priority] || review || (same && now - weakest.createdWallMs >= ROTATE_MS) || (same && d.cooldownMs === 0 && weakest.cooldownMs > 0);
      if (!stronger) {
        // вытесненное ради «назад» уже убрано — возвращать его не нужно: «назад» важнее, но места нет
        return drop('full');
      }
      this.visibleHints = this.visibleHints.filter((h) => h !== weakest);
      this.confirms.delete(weakest.seq);
      evicted.push(weakest);
    }

    const hint: Hint = { ...d, zone, seq: ++this.seq, createdWallMs: now, expiresWallMs: now + d.ttlMs, clock: ctx.clock, textSource: 'template' };
    this.visibleHints.push(hint);
    this.confirms.set(hint.seq, { count: 1, lastMs: now });
    // Важное — первым в своей зоне
    this.visibleHints.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || a.createdWallMs - b.createdWallMs);
    this.lastById.set(d.id, now);
    this.lastByCategory.set(d.category, now);
    if (!review) this.lastShownMs = now;
    if (!critical && !review) this.shownAt.push(now);
    this.shownAt = this.shownAt.filter((t) => now - t < 60_000);
    this.shownTotal++;
    return { hint, status: 'shown', evicted };
  }
}
