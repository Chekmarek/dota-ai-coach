// Самокалибровка мини-карты по своему герою: у игроков мини-карта бывает слева или справа и разного размера.
// В обычной игре GSI сообщает точные координаты своего героя и его ячейку (цвет значка). Коуч ищет значок этого
// цвета в нижних углах экрана, копит пары «пиксель ↔ координаты мира» и по ним вычисляет, где мини-карта и
// какого она размера. Пока пар мало — используется раскладка по умолчанию (мини-карта справа, обычного
// размера), с пометкой «не подтверждена». Если раскладка по умолчанию с парами не сходится, а своей
// калибровки ещё нет — позиции не выдаются (не угадываем).
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { FrameAccess, RgbaImage } from './image.ts';
import { calibrateFromPairs, type MinimapCalibration, type MinimapLayout } from './minimap.ts';

/** Где искать свой значок: нижние углы кадра (доли ширины и высоты) */
const SEARCH = [
  { x0: 0, x1: 0.32, y0: 0.5, y1: 1 },
  { x0: 0.68, x1: 1, y0: 0.5, y1: 1 },
];
/** Новая пара — только если герой сдвинулся хотя бы на столько (ед. мира) или прошло столько мс */
const MIN_MOVE = 250;
const MIN_GAP_MS = 2000;
/** Пар храним не больше */
const MAX_PAIRS = 400;
/** Пересчитывать калибровку после стольких новых пар */
const RECALC_EVERY = 10;

export type CalibrationStatus =
  /** Пар ещё мало: раскладка по умолчанию, не проверена на этом экране */
  | 'default-unconfirmed'
  /** Пары подтверждают раскладку по умолчанию */
  | 'default-confirmed'
  /** Своя калибровка по пар — мини-карта в другом месте или другого размера */
  | 'self'
  /** Пары не сходятся с раскладкой по умолчанию, а своя калибровка ещё не набралась — позиции не выдаются */
  | 'mismatch';

export interface CalibrationState {
  status: CalibrationStatus;
  /** Калибровка для чтения мини-карты; null — позиции не выдавать */
  calibration: MinimapCalibration | null;
  pairs: number;
}

type Pair = { px: number; py: number; wx: number; wy: number; wallMs: number };

/** Пятна цвета: те же признаки, что у значков в minimap.ts, но размер карты неизвестен — границы шире */
function findColorBlobs(img: RgbaImage, color: [number, number, number], tol: number, maxMeanD: number, minN: number, maxN: number, maxSide: number) {
  const { width: w, height: h, data } = img;
  const mark = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(data[i * 4]! - color[0]) + Math.abs(data[i * 4 + 1]! - color[1]) + Math.abs(data[i * 4 + 2]! - color[2]);
    if (d < tol) mark[i] = 1;
  }
  const out: { x: number; y: number; n: number }[] = [];
  const stack: number[] = [];
  for (let i = 0; i < w * h; i++) {
    if (mark[i] !== 1) continue;
    let n = 0, sx = 0, sy = 0, sd = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
    mark[i] = 2;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop()!;
      const x = j % w, y = (j / w) | 0;
      n++;
      sx += x;
      sy += y;
      sd += Math.abs(data[j * 4]! - color[0]) + Math.abs(data[j * 4 + 1]! - color[1]) + Math.abs(data[j * 4 + 2]! - color[2]);
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mark[j - 1] === 1) (mark[j - 1] = 2), stack.push(j - 1);
      if (x < w - 1 && mark[j + 1] === 1) (mark[j + 1] = 2), stack.push(j + 1);
      if (y > 0 && mark[j - w] === 1) (mark[j - w] = 2), stack.push(j - w);
      if (y < h - 1 && mark[j + w] === 1) (mark[j + w] = 2), stack.push(j + w);
    }
    if (n >= minN && n <= maxN && sd / n <= maxMeanD && x1 - x0 + 1 <= maxSide && y1 - y0 + 1 <= maxSide) out.push({ x: sx / n, y: sy / n, n });
  }
  return out;
}

export class MinimapCalibrator {
  private pairs: Pair[] = [];
  private sinceRecalc = 0;
  private self: MinimapCalibration | null = null;
  private status: CalibrationStatus = 'default-unconfirmed';

  private readonly layout: MinimapLayout;

  constructor(layout: MinimapLayout) {
    this.layout = layout;
  }

  /**
   * Кадр + своя позиция из GSI (того же момента). slot — ячейка своего героя (цвет значка).
   * Свой значок ищется в нижних углах; два и больше кандидатов — кадр пропускается (неоднозначно).
   */
  addSample(frame: FrameAccess, slot: number, wx: number, wy: number, wallMs: number): void {
    const color = this.layout.colors[slot];
    if (!color) return;
    const last = this.pairs[this.pairs.length - 1];
    if (last && Math.hypot(last.wx - wx, last.wy - wy) < MIN_MOVE && wallMs - last.wallMs < MIN_GAP_MS) return;
    const s = frame.height / 1080;
    const tol = this.layout.colorToleranceBySlot?.[String(slot)] ?? this.layout.colorTolerance;
    const found: { px: number; py: number }[] = [];
    for (const r of SEARCH) {
      const rect = { x: Math.round(r.x0 * frame.width), y: Math.round(r.y0 * frame.height), w: Math.round((r.x1 - r.x0) * frame.width), h: Math.round((r.y1 - r.y0) * frame.height) };
      // Значок 8–60 px по стороне при 1080 (мини-карта бывает заметно больше обычной)
      for (const b of findColorBlobs(frame.read(rect), color, tol, this.layout.maxMeanDistance, 40 * s * s, 2500 * s * s, 60 * s)) found.push({ px: rect.x + b.x + 0.5, py: rect.y + b.y + 0.5 });
    }
    if (found.length !== 1) return;
    this.pairs.push({ px: found[0]!.px, py: found[0]!.py, wx, wy, wallMs });
    if (this.pairs.length > MAX_PAIRS) this.pairs.shift();
    if (++this.sinceRecalc >= RECALC_EVERY) this.recalc(frame.width, frame.height);
  }

  private recalc(fw: number, fh: number): void {
    this.sinceRecalc = 0;
    const d = this.layout.default;
    const tol = 4 * (fh / 1080);
    const agree = this.pairs.filter((p) => Math.hypot((d.ax * p.wx + d.bx) * fw - p.px, (d.ay * p.wy + d.by) * fh - p.py) <= tol).length;
    if (this.pairs.length >= 12 && agree / this.pairs.length >= 0.8) {
      this.status = 'default-confirmed';
      this.self = null;
      return;
    }
    const self = calibrateFromPairs(this.pairs, fw, fh, { tolPx: tol });
    if (self) {
      this.self = self;
      this.status = 'self';
    } else if (this.pairs.length >= 12) this.status = 'mismatch';
  }

  state(): CalibrationState {
    const calibration: MinimapCalibration | null =
      this.status === 'self' ? this.self : this.status === 'mismatch' ? null : { ...this.layout.default, source: 'layout' };
    return { status: this.status, calibration, pairs: this.pairs.length };
  }

  reset(): void {
    this.pairs = [];
    this.sinceRecalc = 0;
    this.self = null;
    this.status = 'default-unconfirmed';
  }
}
