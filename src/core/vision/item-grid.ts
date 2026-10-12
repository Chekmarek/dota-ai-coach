// Общая обработка для сопоставления иконок предметов: усреднение по сетке 12×9, маска углов, нормализация цвета.
// Используется и при сборке шаблонов (scripts/make-item-templates.ts), и при распознавании — обработка обязана совпадать.
import type { RgbaImage } from './image.ts';

export const GRID_W = 12;
export const GRID_H = 9;

/** Клетки, которые не сравниваются: левый верхний угол (номер клавиши) и правый нижний (заряды, секунды, мана) */
export const GRID_MASK: Uint8Array = (() => {
  const m = new Uint8Array(GRID_W * GRID_H).fill(1);
  for (let gy = 0; gy < GRID_H; gy++)
    for (let gx = 0; gx < GRID_W; gx++) {
      if (gx < 3 && gy < 3) m[gy * GRID_W + gx] = 0;
      if (gx >= GRID_W - 5 && gy >= GRID_H - 3) m[gy * GRID_W + gx] = 0;
    }
  return m;
})();

/** Средний цвет (RGB, с учётом прозрачности) в каждой клетке сетки поверх прямоугольника изображения */
export function gridColors(img: RgbaImage, x0 = 0, y0 = 0, w = img.width, h = img.height): Float32Array {
  const out = new Float32Array(GRID_W * GRID_H * 3);
  for (let gy = 0; gy < GRID_H; gy++)
    for (let gx = 0; gx < GRID_W; gx++) {
      const xa = Math.floor(x0 + (gx * w) / GRID_W), xb = Math.max(xa + 1, Math.floor(x0 + ((gx + 1) * w) / GRID_W));
      const ya = Math.floor(y0 + (gy * h) / GRID_H), yb = Math.max(ya + 1, Math.floor(y0 + ((gy + 1) * h) / GRID_H));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = ya; y < yb; y++)
        for (let x = xa; x < xb; x++) {
          const i = (y * img.width + x) * 4;
          const a = img.data[i + 3]! / 255;
          r += img.data[i]! * a;
          g += img.data[i + 1]! * a;
          b += img.data[i + 2]! * a;
          n++;
        }
      const k = (gy * GRID_W + gx) * 3;
      out[k] = r / n;
      out[k + 1] = g / n;
      out[k + 2] = b / n;
    }
  return out;
}

/** Вычитаем среднее и делим на разброс (по клеткам маски): яркость и контраст отрисовки в игре не важны */
export function normalizeGrid(v: Float32Array): Float32Array {
  let s = 0, n = 0;
  for (let i = 0; i < GRID_W * GRID_H; i++) if (GRID_MASK[i]) for (let c = 0; c < 3; c++) (s += v[i * 3 + c]!), n++;
  const m = s / n;
  let q = 0;
  for (let i = 0; i < GRID_W * GRID_H; i++) if (GRID_MASK[i]) for (let c = 0; c < 3; c++) q += (v[i * 3 + c]! - m) ** 2;
  const sd = Math.sqrt(q / n) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = (v[i]! - m) / sd;
  return o;
}

/** Среднеквадратичное расстояние по клеткам маски; шаблон хранится как целые (×TEMPLATE_SCALE) */
export const TEMPLATE_SCALE = 25;
export function gridDistance(a: Float32Array, t: ArrayLike<number>): number {
  let d = 0, n = 0;
  for (let i = 0; i < GRID_W * GRID_H; i++)
    if (GRID_MASK[i])
      for (let c = 0; c < 3; c++) {
        d += (a[i * 3 + c]! - t[i * 3 + c]! / TEMPLATE_SCALE) ** 2;
        n++;
      }
  return d / n;
}
