// Полоски здоровья героев над их головами в 3D-виде.
// Полоска героя: тёмная рамка, слева заливка цвета команды (зелёная/красная), справа чёрная пустая часть,
// под ней синяя полоска маны, справа квадрат с уровнем. Длина заливки+пустоты при 1920×1080 ~99 px, высота ~8 px.
// У крипов полоски короче и тоньше и без маны, у нейтралов — коричневые: по длине, высоте и мане они отсеиваются.
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { GlyphModel } from '../ocr/glyph-ocr.ts';
import { classify } from '../ocr/glyph-ocr.ts';
import { segment } from './segment.ts';
import type { HudLayout } from './hud-layout.ts';
import { layoutFits } from './hud-layout.ts';
import type { FrameAccess, RgbaImage } from './image.ts';

/** Координаты — в эталонном разрешении раскладки (reference), кроме area */
export interface HealthBarsLayout {
  /** Где искать (доли кадра x, y, w, h): мир между верхней панелью и нижним HUD */
  area: [number, number, number, number];
  /**
   * Длина заливки + пустой части: [мин, макс]. Полоски масштабируются вместе с отдалением камеры:
   * на наборе 2026-10-14 — от ~70 px (камера отдалена) до ~103 px (обычно; у выбранного героя ~111)
   */
  length: [number, number];
  /** Эталонная длина полоски: под неё заданы minRows и level, при другой длине они масштабируются */
  refLength: number;
  /** Сколько строк подряд должна держаться полоска (высота заливки ~8 при refLength) */
  minRows: number;
  /** Квадрат уровня относительно правого конца полоски и верха заливки при refLength: [dx, dy, w, h] */
  level: [number, number, number, number];
}

export type BarColor = 'green' | 'red';

/**
 * Команда по цвету полоски. У игрока зелёные — его команда, красные — противник.
 * У наблюдателя (своей команды нет) зелёные — Силы Света, красные — Силы Тьмы (проверено по GSI на наборе 2026-10-14).
 */
export function barTeam(color: BarColor, ourTeam: 'radiant' | 'dire' | null): 'radiant' | 'dire' {
  const green = ourTeam ?? 'radiant';
  if (color === 'green') return green;
  return green === 'radiant' ? 'dire' : 'radiant';
}

export interface HealthBar {
  /** Цвет полоски: у игрока зелёная — союзник, красная — враг; у наблюдателя см. barTeam */
  color: BarColor;
  /** Здоровье, % (0–100) — доля заливки */
  hpPercent: number;
  /** Уровень из квадрата справа; null — не прочитан уверенно (закрыт, обрезан краем) */
  level: number | null;
  levelConfidence: number;
  /** Левый верхний угол заливки и длина полоски, пиксели кадра */
  x: number;
  y: number;
  length: number;
  /** Уверенность, что это полоска героя (форма, мана под ней, ровные края) */
  confidence: number;
}

export interface HealthBarsReading {
  /** false — кадр не 16:9 или в раскладке нет полосок: «не поддерживается», а не «героев не видно» */
  supported: boolean;
  bars: HealthBar[];
  durationMs: number;
}

/** Ниже этой уверенности уровень не называется */
export const MIN_LEVEL_CONFIDENCE = 0.35;

/**
 * Класс пикселя: 0 — чёрная пустая часть, 1 — зелёная заливка, 2 — красная заливка,
 * 4 — белый кусок «недавнего урона» между заливкой и пустотой (тает за ~1 с после удара), 3 — что-то другое
 */
function pixelClass(d: Uint8ClampedArray, k: number): number {
  const r = d[k]!, g = d[k + 1]!, b = d[k + 2]!;
  if (r <= 30 && g <= 30 && b <= 30) return 0;
  if (g >= 60 && g - r >= 25 && g - b >= 40) return 1;
  if (r >= 60 && r - g >= 50 && r - b >= 55) return 2;
  const mn = Math.min(r, g, b);
  if (mn >= 150 && Math.max(r, g, b) - mn <= 70) return 4;
  return 3;
}

interface Run {
  y: number;
  /** Начало и конец (не включая) всей полоски и конец заливки */
  x0: number;
  x1: number;
  fillEnd: number;
  color: 1 | 2;
}

/** Шаг предварительного просмотра строки (пиксели) */
const SAMPLE = 4;

/**
 * Строки, где найдено «заливка, [белый урон], пустота» подходящей длины.
 * Сначала строка просматривается через SAMPLE пикселей: полоска — это длинный отрезок «своих» пикселей
 * (засечки и сглаженные края — одиночные чужие), и только такие отрезки проверяются попиксельно.
 * На кадре-шуме это в разы быстрее полного просмотра, на настоящих кадрах — результат тот же.
 */
function findRuns(img: RgbaImage, y: number, minLen: number, maxLen: number, out: Run[]): void {
  const { width: w, data: d } = img;
  const row = y * w;
  let start = -1, last = -1, misses = 0;
  for (let x = 0; x < w; x += SAMPLE) {
    if (pixelClass(d, (row + x) * 4) !== 3) {
      if (start < 0) start = x;
      last = x;
      misses = 0;
    } else if (start >= 0 && ++misses > 1) {
      if (last - start >= minLen - 2 * SAMPLE) scanRuns(img, y, Math.max(0, start - SAMPLE), last + SAMPLE, minLen, maxLen, out);
      start = -1;
      misses = 0;
    }
  }
  if (start >= 0 && last - start >= minLen - 2 * SAMPLE) scanRuns(img, y, Math.max(0, start - SAMPLE), w, minLen, maxLen, out);
}

/** Попиксельный поиск полосок, начинающихся в [from, to) */
function scanRuns(img: RgbaImage, y: number, from: number, to: number, minLen: number, maxLen: number, out: Run[]): void {
  const { width: w, data: d } = img;
  const row = y * w;
  let x = from;
  while (x < to) {
    const c0 = pixelClass(d, (row + x) * 4);
    if (c0 !== 1 && c0 !== 2) {
      x++;
      continue;
    }
    // Части идут строго по порядку: заливка → белый урон → пустота; другой порядок или смена цвета — не полоска
    let e = x, phase = 0, fillEnd = x, broken = false;
    while (e < w) {
      const c = pixelClass(d, (row + e) * 4);
      // Пустая часть кончается чем угодно не чёрным: за ней рамка и квадрат уровня (белые цифры, соседняя полоска)
      if (phase === 2 && c !== 0) break;
      if (c === 3) {
        // Внутри заливки и белого урона пропускаем до 2 «чужих» пикселей (сглаженная граница, засечки)
        const n1 = e + 1 < w ? pixelClass(d, (row + e + 1) * 4) : 3;
        const n2 = e + 2 < w ? pixelClass(d, (row + e + 2) * 4) : 3;
        if (n1 === 3 && n2 === 3) break;
        e++;
        continue;
      }
      if (c === c0) {
        if (phase !== 0) {
          broken = true;
          break;
        }
        fillEnd = e + 1;
      } else if (c === 4) {
        if (phase === 2) {
          broken = true;
          break;
        }
        phase = 1;
      } else if (c === 0) phase = 2;
      else {
        broken = true;
        break;
      }
      e++;
    }
    const len = e - x;
    if (!broken && len >= minLen && len <= maxLen) out.push({ y, x0: x, x1: e, fillEnd, color: c0 as 1 | 2 });
    x = Math.max(e, x + 1);
  }
}

function median(a: number[]): number {
  const s = [...a].sort((p, q) => p - q);
  return s[s.length >> 1]!;
}

/** Сколько строк подряд в столбце x закрашено цветом заливки (от найденных строк вверх и вниз) */
function fillHeight(img: RgbaImage, x: number, yTop: number, yBottom: number, color: number): number {
  const { width: w, height: h, data: d } = img;
  let y0 = yTop, y1 = yBottom - 1;
  while (y0 > 0 && pixelClass(d, ((y0 - 1) * w + x) * 4) === color) y0--;
  while (y1 < h - 1 && pixelClass(d, ((y1 + 1) * w + x) * 4) === color) y1++;
  return y1 - y0 + 1;
}

/** Есть ли под полоской синяя мана (у левого края — мана убывает справа налево, слева она есть почти всегда) */
function hasMana(img: RgbaImage, x: number, yBottom: number, rows: number): boolean {
  const { width: w, height: h, data: d } = img;
  // Мана — синяя полоса (~88,121,222): синий пиксель нужен в обоих столбцах у самого края (маны может быть мало).
  // Фиолетовые и голубые модели героев под полоской крипа (~155,130,250) сюда не проходят: у них много красного
  for (const dx of [3, 5]) {
    let blue = false;
    for (let y = yBottom; y < Math.min(h, yBottom + rows) && !blue; y++) {
      const k = (y * w + x + dx) * 4;
      const r = d[k]!, g = d[k + 1]!, b = d[k + 2]!;
      blue = b >= 150 && r <= 120 && b - r >= 90 && g >= r;
    }
    if (!blue) return false;
  }
  return true;
}

export function readHealthBars(frame: FrameAccess, layout: HudLayout, model: GlyphModel | null, opts: { now?: () => number } = {}): HealthBarsReading {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const hb = layout.healthBars;
  if (!hb || !layoutFits(layout, frame.width, frame.height)) return { supported: false, bars: [], durationMs: now() - t0 };
  const s = frame.width / layout.reference.w;
  const [ax, ay, aw, ah] = hb.area;
  const ox = Math.round(ax * frame.width), oy = Math.round(ay * frame.height);
  const img = frame.read({ x: ox, y: oy, w: Math.round(aw * frame.width), h: Math.round(ah * frame.height) });
  const minLen = Math.floor(hb.length[0] * s), maxLen = Math.ceil(hb.length[1] * s);
  // Через строку: полоска выше minRows, ни одну не пропустим, а работы вдвое меньше
  const step = 2;
  const runs: Run[] = [];
  for (let y = 0; y < img.height; y += step) findRuns(img, y, minLen, maxLen, runs);

  // Склеиваем строки одной полоски: тот же цвет, близкие концы, соседние строки
  type Group = { runs: Run[]; color: 1 | 2; x1: number; yLast: number };
  const groups: Group[] = [];
  for (const r of runs) {
    const g = groups.find((q) => q.color === r.color && Math.abs(q.x1 - r.x1) <= 3 && r.y - q.yLast <= step);
    if (g) {
      g.runs.push(r);
      g.yLast = r.y;
    } else groups.push({ runs: [r], color: r.color, x1: r.x1, yLast: r.y });
  }

  // Полоски здоровья и маны под портретами верхней панели похожи на полоски героев — эту область пропускаем
  const tb = layout.topBar;
  const skip = tb
    ? { x0: tb.radiantX * s - ox, x1: (tb.direX + 4 * tb.step + tb.w) * s - ox, y1: (tb.timer[1] + tb.timer[3]) * s - oy }
    : null;
  const bars: HealthBar[] = [];
  for (const g of groups) {
    const x0 = median(g.runs.map((r) => r.x0));
    const x1 = median(g.runs.map((r) => r.x1));
    // Масштаб этой полоски относительно эталонной (камера могла быть отдалена)
    const k = (x1 - x0) / hb.refLength;
    const fillEnd = median(g.runs.map((r) => r.fillEnd));
    const yTop = g.runs[0]!.y, yBottom = g.yLast + 1;
    if (skip && yTop < skip.y1 && x1 > skip.x0 && x0 < skip.x1) continue;
    // Высота заливки (точно, по столбцу у левого края): у героя ~8 строк при эталонной длине, у крипов вдвое тоньше
    if (g.runs.length < 2 || fillHeight(img, x0 + 2, yTop, yBottom, g.color) < hb.minRows * k) continue;
    if (!hasMana(img, x0, yBottom, Math.max(4, Math.round(8 * k)))) continue;
    const length = x1 - x0;
    const hpPercent = Math.max(0, Math.min(100, Math.round((100 * (fillEnd - x0)) / length)));
    // Уверенность: ровность краёв по строкам
    const spread = Math.max(...g.runs.map((r) => Math.abs(r.x0 - x0) + Math.abs(r.x1 - x1)));
    const confidence = Math.max(0, Math.min(1, 1 - spread / (8 * k)));
    let level: number | null = null, levelConfidence = 0;
    if (model) {
      const [dx, dy, lw, lh] = hb.level;
      const box = { x: x1 + Math.round(dx * k), y: yTop + Math.round(dy * k), w: Math.round(lw * k), h: Math.round(lh * k) };
      if (box.x >= 0 && box.y >= 0 && box.x + box.w <= img.width && box.y + box.h <= img.height) {
        const seg = segment(cropImg(img, box.x, box.y, box.w, box.h), { mode: 'white' });
        if (seg.hasText && !seg.truncated && seg.glyphs.length <= 2) {
          const gl = seg.glyphs.map((q) => classify(model, q));
          const text = gl.map((q) => q.ch).join('');
          const c = Math.min(...gl.map((q) => q.score));
          const n = /^\d{1,2}$/.test(text) ? Number(text) : NaN;
          if (n >= 1 && n <= 30 && c >= MIN_LEVEL_CONFIDENCE) {
            level = n;
            levelConfidence = c;
          }
        }
      }
    }
    bars.push({ color: g.color === 1 ? 'green' : 'red', hpPercent, level, levelConfidence, x: ox + x0, y: oy + yTop, length, confidence });
  }
  return { supported: true, bars, durationMs: now() - t0 };
}

function cropImg(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const k = ((y + j) * img.width + x) * 4;
    out.set(img.data.subarray(k, k + w * 4), j * w * 4);
  }
  return { width: w, height: h, data: out };
}
