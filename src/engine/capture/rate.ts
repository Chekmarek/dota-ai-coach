// Чистая логика без DOM — покрыта unit-тестами.

/** Измеряет фактическую частоту событий в скользящем окне */
export class FpsMeter {
  private stamps: number[] = [];
  constructor(private readonly windowMs = 3000) {}

  tick(now: number): void {
    this.stamps.push(now);
    this.trim(now);
  }

  fps(now: number): number {
    this.trim(now);
    if (this.stamps.length < 2) return 0;
    const span = this.stamps[this.stamps.length - 1]! - this.stamps[0]!;
    return span > 0 ? ((this.stamps.length - 1) * 1000) / span : 0;
  }

  reset(): void {
    this.stamps = [];
  }

  private trim(now: number): void {
    const from = now - this.windowMs;
    while (this.stamps.length && this.stamps[0]! < from) this.stamps.shift();
  }
}

/**
 * Ограничитель частоты обработки.
 * Кадр принимается, только если прошло не меньше 1/maxFps с прошлого принятого
 * и предыдущий кадр уже обработан (иначе он отбрасывается — очередь не копится).
 */
export class FrameGate {
  private lastAccepted = -Infinity;
  private busy = false;
  private minIntervalMs: number;

  constructor(maxFps: number) {
    this.minIntervalMs = 1000 / maxFps;
  }

  setMaxFps(maxFps: number): void {
    this.minIntervalMs = 1000 / maxFps;
  }

  /** true — кадр можно обрабатывать; вызывающий обязан затем вызвать done() */
  tryAcquire(now: number): boolean {
    // Небольшой допуск, чтобы дрожание таймера не отбрасывало каждый второй кадр
    if (this.busy || now - this.lastAccepted < this.minIntervalMs * 0.9) return false;
    this.busy = true;
    this.lastAccepted = now;
    return true;
  }

  done(): void {
    this.busy = false;
  }

  reset(): void {
    this.busy = false;
    this.lastAccepted = -Infinity;
  }
}

/** Вычисляет размер кадра после масштабирования до maxWidth (без увеличения) */
export function fitWidth(width: number, height: number, maxWidth: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round((height * maxWidth) / width)) };
}

