// Игровое время: экстраполяция между чтениями, пауза, скачки и признак нового матча.
import { FAST_CONFIDENCE, VISIBLE_MS } from './stable-field.ts';
import type { Tracked } from './types.ts';

/** Чтение согласуется с ожидаемым временем, если отличается не больше чем на столько секунд */
export const CLOCK_TOLERANCE_SEC = 3;
/** Скачок времени принимается после стольких подряд согласованных между собой чтений */
export const CLOCK_JUMP_READINGS = 3;
/** Время стоит дольше этого (мс) — игра на паузе */
export const PAUSE_AFTER_MS = 3000;
/** Время ушло назад больше чем на столько секунд — начался новый матч */
export const RESET_BACK_SEC = 120;

export type ClockEvent = { type: 'pause' } | { type: 'unpause' } | { type: 'jump'; from: number; to: number } | { type: 'match-reset'; from: number; to: number };

export class ClockTracker {
  /** Опора экстраполяции: принятое время и когда оно было верно */
  private anchor: { sec: number; wallMs: number } | null = null;
  paused = false;
  confidence = 0;
  firstSeenWallMs: number | null = null;
  lastSeenWallMs: number | null = null;
  /** Последнее прочитанное значение и с какого момента оно не меняется (для паузы) */
  private same: { sec: number; since: number } | null = null;
  /** Чтения, не согласованные с текущим временем, — кандидаты на скачок */
  private jump: { sec: number; wallMs: number }[] = [];

  get known(): boolean {
    return this.anchor !== null;
  }

  /** Ожидаемое время на момент wallMs (без паузы — с ходом часов) */
  at(wallMs: number): number | null {
    if (!this.anchor) return null;
    return this.paused ? this.anchor.sec : this.anchor.sec + (wallMs - this.anchor.wallMs) / 1000;
  }

  ingest(sec: number | null, confidence: number, valid: boolean, wallMs: number): ClockEvent[] {
    if (!valid || sec === null) return [];
    const events: ClockEvent[] = [];

    if (!this.anchor) {
      // Первое время: сразу при высокой уверенности, иначе — два согласованных чтения подряд
      this.jump.push({ sec, wallMs });
      if (confidence >= FAST_CONFIDENCE || this.jumpConsistent(2)) this.setAnchor(sec, wallMs, confidence);
      else this.trimJump(2);
      if (this.anchor) this.same = { sec, since: wallMs };
      return events;
    }

    const expected = this.at(wallMs)!;
    if (Math.abs(sec - expected) <= CLOCK_TOLERANCE_SEC) {
      this.jump = [];
      this.lastSeenWallMs = wallMs;
      this.confidence = Math.max(this.confidence, confidence);
      // Пауза: прочитанное время не меняется дольше PAUSE_AFTER_MS
      if (this.same && this.same.sec === sec) {
        if (!this.paused && wallMs - this.same.since > PAUSE_AFTER_MS) {
          this.paused = true;
          this.anchor = { sec, wallMs };
          events.push({ type: 'pause' });
        }
      } else {
        this.same = { sec, since: wallMs };
        if (this.paused) {
          this.paused = false;
          this.anchor = { sec, wallMs };
          events.push({ type: 'unpause' });
        }
      }
      // Подправляем опору, только если целая секунда разошлась с прочитанной (часы показывают целые секунды)
      if (!this.paused && Math.floor(this.at(wallMs)!) !== sec) this.anchor = { sec, wallMs };
      return events;
    }

    // Не согласуется: копим кандидатов на скачок
    this.jump.push({ sec, wallMs });
    if (!this.jumpConsistent(CLOCK_JUMP_READINGS)) {
      this.trimJump(CLOCK_JUMP_READINGS);
      return events;
    }
    const from = expected;
    const back = from - sec > RESET_BACK_SEC;
    this.setAnchor(sec, wallMs, confidence);
    this.paused = false;
    this.same = { sec, since: wallMs };
    events.push({ type: back ? 'match-reset' : 'jump', from, to: sec });
    return events;
  }

  /** Последние n кандидатов согласованы между собой (каждый — продолжение предыдущего) */
  private jumpConsistent(n: number): boolean {
    if (this.jump.length < n) return false;
    const tail = this.jump.slice(-n);
    for (let i = 1; i < tail.length; i++) {
      const a = tail[i - 1]!, b = tail[i]!;
      const elapsed = (b.wallMs - a.wallMs) / 1000;
      // Допускаем и ход часов, и стоящие часы (кадры во время паузы)
      if (b.sec < a.sec - CLOCK_TOLERANCE_SEC || b.sec > a.sec + elapsed + CLOCK_TOLERANCE_SEC) return false;
    }
    return true;
  }

  /** Оставляем хвост кандидатов: несогласованный старый кандидат больше не нужен */
  private trimJump(n: number): void {
    if (this.jump.length < 2) return;
    // Начинаем цепочку заново с последнего чтения, если оно не продолжает предыдущее
    const last = this.jump[this.jump.length - 1]!;
    const prev = this.jump[this.jump.length - 2]!;
    const elapsed = (last.wallMs - prev.wallMs) / 1000;
    if (last.sec < prev.sec - CLOCK_TOLERANCE_SEC || last.sec > prev.sec + elapsed + CLOCK_TOLERANCE_SEC) this.jump = [last];
    else if (this.jump.length > n) this.jump = this.jump.slice(-n);
  }

  private setAnchor(sec: number, wallMs: number, confidence: number): void {
    this.anchor = { sec, wallMs };
    this.confidence = confidence;
    this.firstSeenWallMs = wallMs;
    this.lastSeenWallMs = wallMs;
    this.jump = [];
  }

  tracked(wallMs: number): Tracked<number> {
    const value = this.at(wallMs);
    if (value === null || this.lastSeenWallMs === null) {
      return { value: null, confidence: 0, tag: 'unknown', lastSeenWallMs: null, firstSeenWallMs: null };
    }
    const fresh = wallMs - this.lastSeenWallMs < VISIBLE_MS;
    return {
      value,
      confidence: this.confidence,
      // Между чтениями время — вывод из последнего принятого и прошедшего времени
      tag: fresh ? 'visible' : 'inferred',
      lastSeenWallMs: this.lastSeenWallMs,
      firstSeenWallMs: this.firstSeenWallMs,
    };
  }
}
