// Выделение отдельных символов (глифов) из области с текстом.
import type { Rect } from '../../shared/types/observation.ts';
import { channel, otsu, type ChannelMode, type RgbaImage } from './image.ts';

export const GLYPH_W = 10;
export const GLYPH_H = 14;

export interface Glyph {
  /** Положение в координатах области */
  box: Rect;
  /** Нормированное изображение символа GLYPH_W×GLYPH_H, значения 0..1 */
  vec: Float32Array;
  aspect: number;
  /** Высота относительно самого высокого символа строки */
  relH: number;
  /** Сдвиг верхнего края относительно строки (0 — вровень с верхом, ~0.7 — точка внизу) */
  relTop: number;
}

export interface SegmentOptions {
  mode: ChannelMode;
  /** Отбрасывать пятна, касающиеся края области (например, кольцо вокруг уровня) */
  dropBorder?: boolean;
  minArea?: number;
  /** Минимальная разница яркости текста и фона, иначе считаем, что текста нет */
  minSeparation?: number;
  /** Учитывать только круг, вписанный в область (цифры уровня внутри кольца) */
  circleMask?: boolean;
  /** Брать только первую группу символов слева и отбрасывать широкие значки после неё (монеты рядом с золотом) */
  firstRun?: boolean;
  /** Разрезать слишком широкие пятна на два символа (для цифр; для букв выключать — M и W широкие) */
  splitWide?: boolean;
  /**
   * Постоянный порог вместо порога Оцу. Нужен, когда фон местами так же ярок, как текст (белое имя героя
   * на голубой воде или светлых камнях): Оцу тогда делит не «текст/фон», а «светлый фон/тёмный фон».
   */
  threshold?: number;
}

export interface Segmentation {
  glyphs: Glyph[];
  separation: number;
  threshold: number;
  /** false — в области нет различимого текста */
  hasText: boolean;
  /** true — символ обрезан краем области: читать такое значение нельзя */
  truncated: boolean;
}

interface Blob {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
  touchesBorder: boolean;
  /** касается левого или правого края */
  touchesSide: boolean;
}

/** Связные области (8-связность) на бинарной маске */
export function components(mask: Uint8Array, w: number, h: number): Blob[] {
  const seen = new Uint8Array(w * h);
  const blobs: Blob[] = [];
  const stack: number[] = [];
  for (let start = 0; start < w * h; start++) {
    if (!mask[start] || seen[start]) continue;
    const b: Blob = { x0: w, y0: h, x1: -1, y1: -1, area: 0, touchesBorder: false, touchesSide: false };
    stack.push(start);
    seen[start] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      const x = p % w, y = (p - x) / w;
      b.area++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) b.touchesBorder = true;
      if (x === 0 || x === w - 1) b.touchesSide = true;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx, ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const q = ny * w + nx;
          if (mask[q] && !seen[q]) {
            seen[q] = 1;
            stack.push(q);
          }
        }
    }
    blobs.push(b);
  }
  return blobs;
}

export function segment(img: RgbaImage, opts: SegmentOptions): Segmentation {
  const { width: w, height: h } = img;
  const values = channel(img, opts.mode);
  if (opts.circleMask) {
    // Всё вне внутреннего круга считаем фоном: кольцо вокруг цифр проходит по ~0.94 радиуса области
    // (внутренний край ~0.87), цифры занимают до ~0.8 радиуса от центра
    const cx = (w - 1) / 2, cy = (h - 1) / 2, r = (Math.min(w, h) / 2) * 0.66;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) values[y * w + x] = 0;
  }
  const { threshold, separation } = opts.threshold !== undefined ? fixedSplit(values, opts.threshold) : otsu(opts.circleMask ? values.filter((v) => v > 0) : values);
  const empty = { glyphs: [], separation, threshold, hasText: false, truncated: false };
  if (w === 0 || h === 0 || separation < (opts.minSeparation ?? 60)) return empty;

  const mask = new Uint8Array(w * h);
  for (let i = 0; i < values.length; i++) mask[i] = values[i]! > threshold ? 1 : 0;

  // Сначала оставляем даже крошечные пятна (точки двоеточия), окончательный фильтр — после объединения
  let blobs = components(mask, w, h).filter((b) => b.area >= 2);
  if (opts.dropBorder) blobs = blobs.filter((b) => !b.touchesBorder);
  if (blobs.length === 0) return empty;

  // Объединяем части, стоящие друг над другом (двоеточие, точки над буквами)
  blobs.sort((a, b) => a.x0 - b.x0);
  const tallest = Math.max(...blobs.map((b) => b.y1 - b.y0 + 1));
  const merged: Blob[] = [];
  for (const b of blobs) {
    const last = merged[merged.length - 1];
    if (last) {
      const overlap = Math.min(last.x1, b.x1) - Math.max(last.x0, b.x0) + 1;
      const narrow = Math.min(last.x1 - last.x0, b.x1 - b.x0) + 1;
      // Части одного символа:
      //  - сильно перекрываются по горизонтали (двоеточие);
      //  - или два мелких обрывка стоят один над другим почти вплотную (бледная косая черта распадается на куски)
      const disjointY = b.y0 > last.y1 || b.y1 < last.y0;
      const small = (x: Blob) => x.y1 - x.y0 + 1 < tallest * 0.6;
      const fragments = disjointY && small(last) && small(b) && b.x0 - last.x1 <= 2;
      if (overlap >= narrow * 0.5 || fragments) {
        last.x0 = Math.min(last.x0, b.x0);
        last.x1 = Math.max(last.x1, b.x1);
        last.y0 = Math.min(last.y0, b.y0);
        last.y1 = Math.max(last.y1, b.y1);
        last.area += b.area;
        last.touchesSide ||= b.touchesSide;
        last.touchesBorder ||= b.touchesBorder;
        continue;
      }
    }
    merged.push({ ...b });
  }

  // Слипшиеся цифры («26» одним пятном): слишком широкое пятно режем по самому тонкому столбцу в середине
  for (let i = 0; opts.splitWide !== false && i < merged.length; i++) {
    const b = merged[i]!;
    const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
    if (bw / bh <= 1.0 || bw < 6) continue;
    let cut = -1, min = Infinity;
    for (let x = b.x0 + Math.floor(bw * 0.3); x <= b.x0 + Math.ceil(bw * 0.7); x++) {
      let n = 0;
      for (let y = b.y0; y <= b.y1; y++) n += mask[y * w + x]!;
      if (n < min) {
        min = n;
        cut = x;
      }
    }
    if (cut < 0 || min > bh * 0.5) continue; // нет явной перемычки — не режем
    const left = shrink(mask, w, { ...b, x1: cut - 1 });
    const right = shrink(mask, w, { ...b, x0: cut + 1 });
    if (!left || !right) continue;
    merged.splice(i, 1, left, right);
    i--; // проверить получившиеся части ещё раз
  }

  if (opts.firstRun && merged.length > 1) {
    // Обрезаем после первого большого промежутка, затем снимаем широкие значки в конце (монеты)
    const digitH = Math.max(...merged.filter((b) => (b.x1 - b.x0 + 1) / (b.y1 - b.y0 + 1) <= 1.1).map((b) => b.y1 - b.y0 + 1), 1);
    let end = 1;
    while (end < merged.length && merged[end]!.x0 - merged[end - 1]!.x1 - 1 <= digitH * 0.5) end++;
    merged.length = end;
    while (merged.length && (merged.at(-1)!.x1 - merged.at(-1)!.x0 + 1) / (merged.at(-1)!.y1 - merged.at(-1)!.y0 + 1) > 1.1) merged.pop();
    if (!merged.length) return empty;
  }

  // Мелкий мусор — пятна намного ниже основной строки (кроме точек/двоеточий, они проходят по площади)
  const lineH = Math.max(...merged.map((b) => b.y1 - b.y0 + 1));
  const lineTop = Math.min(...merged.filter((b) => b.y1 - b.y0 + 1 >= lineH * 0.6).map((b) => b.y0));
  const glyphs = merged
    .filter((b) => b.area >= Math.max(opts.minArea ?? 3, lineH * 0.25))
    .map((b): Glyph => {
      const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
      return {
        box: { x: b.x0, y: b.y0, w: bw, h: bh },
        vec: resample(values, w, b, threshold),
        aspect: bw / bh,
        relH: bh / lineH,
        relTop: (b.y0 - lineTop) / lineH,
      };
    });
  // Высокий символ, упёршийся в боковой край, — обрезан: значение может быть неполным («14» → «1»)
  const truncated = merged.some((b) => b.touchesSide && b.y1 - b.y0 + 1 >= lineH * 0.6);
  return { glyphs, separation, threshold, hasText: glyphs.length > 0, truncated };
}

/** Подрезает рамку пятна по фактическим пикселям маски внутри неё; null — пикселей нет */
function shrink(mask: Uint8Array, w: number, b: Blob): Blob | null {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1, area = 0;
  for (let y = b.y0; y <= b.y1; y++)
    for (let x = b.x0; x <= b.x1; x++)
      if (mask[y * w + x]) {
        area++;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  if (area < 2) return null;
  return { x0, y0, x1, y1, area, touchesBorder: b.touchesBorder, touchesSide: b.touchesSide && (x0 === 0 || x1 === w - 1) };
}

/**
 * Приводит символ к сетке GLYPH_W×GLYPH_H: доля «текстовых» пикселей в каждой клетке (0..1).
 * Сравнивается только форма, а не яркость — поэтому светлый или тёмный фон под цифрами не мешает.
 */
function resample(values: Float32Array, w: number, b: Blob, thr: number): Float32Array {
  const out = new Float32Array(GLYPH_W * GLYPH_H);
  const bw = b.x1 - b.x0 + 1, bh = b.y1 - b.y0 + 1;
  for (let gy = 0; gy < GLYPH_H; gy++)
    for (let gx = 0; gx < GLYPH_W; gx++) {
      const sx0 = b.x0 + (gx * bw) / GLYPH_W, sx1 = b.x0 + ((gx + 1) * bw) / GLYPH_W;
      const sy0 = b.y0 + (gy * bh) / GLYPH_H, sy1 = b.y0 + ((gy + 1) * bh) / GLYPH_H;
      let acc = 0, n = 0;
      for (let y = Math.floor(sy0); y < Math.max(Math.floor(sy0) + 1, Math.ceil(sy1)); y++)
        for (let x = Math.floor(sx0); x < Math.max(Math.floor(sx0) + 1, Math.ceil(sx1)); x++) {
          acc += values[y * w + x]! > thr ? 1 : 0;
          n++;
        }
      out[gy * GLYPH_W + gx] = n ? acc / n : 0;
    }
  return out;
}

/** Разница средних «выше порога» и «не выше» при постоянном пороге (0 — выше порога ничего нет) */
function fixedSplit(values: Float32Array, threshold: number): { threshold: number; separation: number } {
  let hi = 0, nHi = 0, lo = 0, nLo = 0;
  for (const v of values) {
    if (v > threshold) {
      hi += v;
      nHi++;
    } else {
      lo += v;
      nLo++;
    }
  }
  return { threshold, separation: nHi && nLo ? hi / nHi - lo / nLo : 0 };
}
