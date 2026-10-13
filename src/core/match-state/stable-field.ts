// Стабилизация одного поля: покадровые чтения шумят, принимаем значение только когда оно подтвердилось.
import type { Tracked, TrackedTag } from './types.ts';

/** Чтение старше этого — уже не «видно сейчас», а «видели раньше» */
export const VISIBLE_MS = 1500;
/** Уверенность, при которой новое значение принимается с первого чтения */
export const FAST_CONFIDENCE = 0.9;
/** Сколько последних верных чтений поля учитывается и сколько из них должны совпасть */
export const RECENT_READINGS = 3;
export const MIN_REPEATS = 2;
/** Монотонное поле уменьшается только если меньшее значение держится столько (исправление ошибки чтения) */
export const CORRECTION_MS = 10_000;

export interface FieldOptions<T> {
  equals(a: T, b: T): boolean;
  /** Для монотонных полей: true, если next меньше prev хотя бы в одной части */
  decreases?: (prev: T, next: T) => boolean;
  /** Уверенность для приёма с первого чтения; null — всегда нужны повторы (ячейки инвентаря) */
  fastConfidence?: number | null;
}

export interface FieldChange<T> {
  prev: T | null;
  next: T;
}

export class StableField<T> {
  value: T | null = null;
  confidence = 0;
  firstSeenWallMs: number | null = null;
  lastSeenWallMs: number | null = null;
  private recent: T[] = [];
  /** Меньшее значение монотонного поля, которое ждёт подтверждения временем */
  private lower: { value: T; since: number } | null = null;

  constructor(private readonly opts: FieldOptions<T>) {}

  /**
   * Одно чтение поля. Возвращает изменение, если принято новое значение.
   * Нераспознанное (value = null) или неверное чтение принятое значение не трогает.
   */
  ingest(value: T | null, confidence: number, valid: boolean, wallMs: number): FieldChange<T> | null {
    if (!valid || value === null) return null;
    const eq = this.opts.equals;
    this.recent.push(value);
    if (this.recent.length > RECENT_READINGS) this.recent.shift();

    if (this.value !== null && eq(value, this.value)) {
      this.lastSeenWallMs = wallMs;
      this.confidence = Math.max(confidence, this.confidence);
      this.lower = null;
      return null;
    }
    // Меньшее значение пропало из последних чтений — это был шум
    if (this.lower && !this.recent.some((v) => eq(v, this.lower!.value))) this.lower = null;

    const repeats = this.recent.reduce((n, v) => (eq(v, value) ? n + 1 : n), 0);
    const fast = this.opts.fastConfidence === undefined ? FAST_CONFIDENCE : this.opts.fastConfidence;
    const confirmed = (fast !== null && confidence >= fast) || repeats >= MIN_REPEATS;

    if (this.value !== null && this.opts.decreases?.(this.value, value)) {
      if (!this.lower || !eq(this.lower.value, value)) {
        this.lower = { value, since: wallMs };
        return null;
      }
      if (wallMs - this.lower.since < CORRECTION_MS || repeats < MIN_REPEATS) return null;
    } else if (!confirmed) {
      return null;
    }
    return this.accept(value, confidence, wallMs);
  }

  private accept(value: T, confidence: number, wallMs: number): FieldChange<T> {
    const prev = this.value;
    this.value = value;
    this.confidence = confidence;
    this.firstSeenWallMs = wallMs;
    this.lastSeenWallMs = wallMs;
    this.lower = null;
    return { prev, next: value };
  }

  /** Значение с меткой на момент wallMs; ttlMs — сколько помнить после последнего чтения */
  tracked(wallMs: number, ttlMs: number): Tracked<T> {
    if (this.value === null || this.lastSeenWallMs === null) return unknownTracked();
    const tag = tagFor(wallMs - this.lastSeenWallMs, ttlMs);
    return {
      value: tag === 'unknown' ? null : this.value,
      confidence: tag === 'unknown' ? 0 : this.confidence,
      tag,
      lastSeenWallMs: this.lastSeenWallMs,
      firstSeenWallMs: this.firstSeenWallMs,
    };
  }
}

export function tagFor(ageMs: number, ttlMs: number): TrackedTag {
  if (ageMs < VISIBLE_MS) return 'visible';
  return ageMs < ttlMs ? 'remembered' : 'unknown';
}

export function unknownTracked<T>(): Tracked<T> {
  return { value: null, confidence: 0, tag: 'unknown', lastSeenWallMs: null, firstSeenWallMs: null };
}
