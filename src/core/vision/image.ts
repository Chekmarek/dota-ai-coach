// Базовые операции с изображением на чистом TypeScript (без DOM) — одинаково работают
// в движке (ImageData из OffscreenCanvas) и в тестах (декодированный PNG).
import type { Rect } from '../../shared/types/observation.ts';

export interface RgbaImage {
  width: number;
  height: number;
  data: Uint8ClampedArray;
}

/** Способ доставать из кадра нужные области — чтобы не копировать весь кадр ради нескольких цифр */
export interface FrameAccess {
  width: number;
  height: number;
  read(rect: Rect): RgbaImage;
}

export function frameAccessFromImage(img: RgbaImage): FrameAccess {
  return { width: img.width, height: img.height, read: (r) => crop(img, r) };
}

export function crop(img: RgbaImage, r: Rect): RgbaImage {
  const x0 = Math.max(0, Math.round(r.x));
  const y0 = Math.max(0, Math.round(r.y));
  const x1 = Math.min(img.width, Math.round(r.x + r.w));
  const y1 = Math.min(img.height, Math.round(r.y + r.h));
  const w = Math.max(0, x1 - x0);
  const h = Math.max(0, y1 - y0);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y0 + y) * img.width + x0) * 4;
    data.set(img.data.subarray(src, src + w * 4), y * w * 4);
  }
  return { width: w, height: h, data };
}

/**
 * Как выделять текст из фона:
 * - luma: яркость (жёлтые/светлые цифры на тёмном фоне — золото, уровень);
 * - white: «белизна» = min(R,G,B) — белый текст поверх цветной полосы HP/маны;
 * - white-or-red: белый ИЛИ красный текст (при смерти героя цифры HP/маны становятся красными);
 * - saturation: насыщенность цвета (золотые буквы имени на светлом блёклом фоне — песок, камни).
 */
export type ChannelMode = 'luma' | 'white' | 'white-or-red' | 'saturation';

export function channel(img: RgbaImage, mode: ChannelMode): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n);
  const d = img.data;
  for (let i = 0; i < n; i++) {
    const r = d[i * 4]!, g = d[i * 4 + 1]!, b = d[i * 4 + 2]!;
    if (mode === 'luma') out[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    else if (mode === 'saturation') out[i] = Math.max(r, g, b) - Math.min(r, g, b);
    else {
      const white = Math.min(r, g, b);
      out[i] = mode === 'white' ? white : Math.max(white, r - Math.max(g, b) * 0.6);
    }
  }
  return out;
}

/**
 * Порог Оцу: делит значения на «фон» и «текст».
 * separation — разница средних двух классов: если она мала, текста в области, скорее всего, нет.
 */
export function otsu(values: Float32Array): { threshold: number; separation: number } {
  const hist = new Float64Array(256);
  for (const v of values) hist[Math.max(0, Math.min(255, Math.round(v)))]!++;
  const total = values.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = -1, threshold = 128, separation = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      threshold = t;
      separation = mF - mB;
    }
  }
  return { threshold, separation };
}
