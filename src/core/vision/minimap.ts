// Мини-карта: где герои. Значок героя — цвета игрока (у Сил Света «капля», у Сил Тьмы «стрелка», размер ~20 px
// при мини-карте 230 px), цвет — цвет полоски игрока на верхней панели, затемнённый примерно в 0,86 раза
// (измерено на наборе кадров 2026-10-14). Поэтому герой определяется по цвету — номер игрока, а кто это —
// по верхней панели. Портреты-значки на мини-карте (другая настройка Dota) этим способом не проверены.
// Пиксели → координаты мира: px = ax·wx + bx, py = ay·wy + by (оси карты совпадают с осями экрана, y вверх).
// Коэффициенты даны в долях ширины/высоты кадра — так они не зависят от разрешения.
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { FrameAccess, RgbaImage } from './image.ts';
import type { Team } from './top-bar.ts';

export interface MinimapCalibration {
  /** Перевод мира в пиксели, в долях кадра: u = ax·wx + bx (доля ширины), v = ay·wy + by (доля высоты) */
  ax: number;
  bx: number;
  ay: number;
  by: number;
  /** Откуда: «layout» — раскладка по умолчанию; «self» — по своему герою из GSI в этом матче */
  source: 'layout' | 'self';
}

export interface MinimapLayout {
  /** Калибровка по умолчанию (набор кадров 2026-10-14: мини-карта справа, обычного размера) */
  default: Omit<MinimapCalibration, 'source'>;
  /** Границы мира, которые показывает мини-карта (ед. мира): по ним вычисляется прямоугольник поиска */
  world: [number, number, number, number];
  /** Цвет значка каждого игрока (номер ячейки 0–9), RGB */
  colors: [number, number, number][];
  /** Допустимое отличие цвета пикселя значка (сумма модулей по каналам); по ячейкам — если цвет похож на местность */
  colorTolerance: number;
  colorToleranceBySlot?: Record<string, number>;
  /** Среднее отличие цвета по пятну не больше этого: у настоящих значков ≤ ~45, у пятен местности больше */
  maxMeanDistance: number;
  /** Площадь значка в долях площади мини-карты: минимум и максимум (меньше — обрезок, больше — не значок) */
  markerArea: [number, number];
  /** Сторона рамки значка в долях стороны мини-карты: минимум и максимум */
  markerSide: [number, number];
}

export interface MinimapHero {
  slot: number;
  team: Team;
  /** Координаты мира (центр значка) */
  x: number;
  y: number;
  /** Пиксели кадра (центр значка) — для калибровки и отладки */
  px: number;
  py: number;
  confidence: number;
  /**
   * Несколько похожих значков цвета игрока (иллюзии, клоны: Phantom Lancer, Dark Seer и т. п.) —
   * какой из них герой, по мини-карте не определить; x, y — самый крупный значок, уверенность снижена
   */
  ambiguous: boolean;
  /**
   * Другие значки цвета этого игрока (поменьше выбранного): координаты мира и площадь в пикселях.
   * По ним сопровождение (minimap-track.ts) выбирает значок, ближний к прежнему месту героя
   */
  others: { x: number; y: number; n: number }[];
}

export interface MinimapReading {
  /** false — нет калибровки или раскладки: «не поддерживается», а не «никого не видно» */
  supported: boolean;
  /** Герои, чьи значки найдены (не найден — не виден на мини-карте или закрыт) */
  heroes: MinimapHero[];
  /** Прямоугольник мини-карты в пикселях кадра, где искали */
  rect: { x: number; y: number; w: number; h: number } | null;
  /** Откуда калибровка: подтверждена ли раскладка по умолчанию или вычислена по своему герою (minimap-calibration.ts) */
  calibration?: string;
  durationMs: number;
}

/** Прямоугольник мини-карты в кадре по калибровке и границам мира */
export function minimapRect(cal: Omit<MinimapCalibration, 'source'>, world: MinimapLayout['world'], fw: number, fh: number) {
  const [x0, y0, x1, y1] = world;
  const ua = (cal.ax * x0 + cal.bx) * fw, ub = (cal.ax * x1 + cal.bx) * fw;
  const va = (cal.ay * y1 + cal.by) * fh, vb = (cal.ay * y0 + cal.by) * fh;
  const x = Math.max(0, Math.floor(Math.min(ua, ub))), y = Math.max(0, Math.floor(Math.min(va, vb)));
  return { x, y, w: Math.min(fw, Math.ceil(Math.max(ua, ub))) - x, h: Math.min(fh, Math.ceil(Math.max(va, vb))) - y };
}

/** Пятна цвета игрока: связные области пикселей, близких к цвету (4-связность), с рамкой */
function blobs(
  img: RgbaImage,
  color: [number, number, number],
  tol: number,
  bg: Uint8ClampedArray | null,
  bgTol: number,
  confused: Uint16Array | null,
  slotBit: number,
): Blob[] {
  const { width: w, height: h, data } = img;
  const mark = new Uint8Array(w * h);
  const dist = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const d = Math.abs(data[i * 4]! - color[0]) + Math.abs(data[i * 4 + 1]! - color[1]) + Math.abs(data[i * 4 + 2]! - color[2]);
    if (d < tol && bg) {
      // Пиксель как у неподвижного фона в этом месте (река, постройки, крипы у базы) — не значок
      if (Math.abs(data[i * 4]! - bg[i * 3]!) + Math.abs(data[i * 4 + 1]! - bg[i * 3 + 1]!) + Math.abs(data[i * 4 + 2]! - bg[i * 3 + 2]!) < bgTol) continue;
      // Опасная клетка для этого игрока (бывает его цвета без героя): значок на ней не отличить — не считаем
      if (confused && confused[i]! & slotBit) continue;
    }
    if (d < tol) {
      mark[i] = 1;
      dist[i] = d;
    }
  }
  const out: Blob[] = [];
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
      sd += dist[j]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (x > 0 && mark[j - 1] === 1) (mark[j - 1] = 2), stack.push(j - 1);
      if (x < w - 1 && mark[j + 1] === 1) (mark[j + 1] = 2), stack.push(j + 1);
      if (y > 0 && mark[j - w] === 1) (mark[j - w] = 2), stack.push(j - w);
      if (y < h - 1 && mark[j + w] === 1) (mark[j + w] = 2), stack.push(j + w);
    }
    out.push({ x: sx / n, y: sy / n, n, d: sd / n, w: x1 - x0 + 1, h: y1 - y0 + 1 });
  }
  return out;
}

type Blob = { x: number; y: number; n: number; d: number; w: number; h: number };

/** Склеивает пятна, центры которых ближе radius: крупные первыми, к ним — мелкие соседи */
function mergeNear(list: Blob[], radius: number): Blob[] {
  const sorted = [...list].sort((a, b) => b.n - a.n);
  type Group = Blob & { x0: number; x1: number; y0: number; y1: number };
  const out: Group[] = [];
  // Сетка клеток размером radius: соседей ищем в 3×3 клетках, а не среди всех групп (на пёстром кадре пятен тысячи)
  const cell = Math.max(1, radius);
  const grid = new Map<number, Group[]>();
  const keyOf = (x: number, y: number) => Math.floor(x / cell) * 65536 + Math.floor(y / cell);
  for (const b of sorted) {
    const box = { x0: b.x - b.w / 2, x1: b.x + b.w / 2, y0: b.y - b.h / 2, y1: b.y + b.h / 2 };
    let m: Group | undefined;
    const cx = Math.floor(b.x / cell), cy = Math.floor(b.y / cell);
    for (let dx = -1; dx <= 1 && !m; dx++)
      for (let dy = -1; dy <= 1 && !m; dy++) m = grid.get((cx + dx) * 65536 + cy + dy)?.find((o) => Math.hypot(o.x - b.x, o.y - b.y) <= radius);
    if (!m) {
      const g: Group = { ...b, ...box };
      out.push(g);
      const k = keyOf(b.x, b.y);
      grid.set(k, [...(grid.get(k) ?? []), g]);
      continue;
    }
    const n = m.n + b.n;
    m.x = (m.x * m.n + b.x * b.n) / n;
    m.y = (m.y * m.n + b.y * b.n) / n;
    m.d = (m.d * m.n + b.d * b.n) / n;
    m.n = n;
    m.x0 = Math.min(m.x0, box.x0);
    m.x1 = Math.max(m.x1, box.x1);
    m.y0 = Math.min(m.y0, box.y0);
    m.y1 = Math.max(m.y1, box.y1);
    m.w = m.x1 - m.x0;
    m.h = m.y1 - m.y0;
  }
  return out;
}

/**
 * Неподвижный фон мини-карты (медиана кадров набора, героев на нём нет) в координатах мира:
 * width×height клеток поверх границ world, RGB по строкам сверху вниз (север — верх).
 */
export interface MinimapBackground {
  world: [number, number, number, number];
  width: number;
  height: number;
  /** RGB, по 3 байта на клетку */
  rgb: Uint8ClampedArray;
  /** Пиксель ближе этого к фону (сумма модулей) значку не принадлежит */
  tolerance: number;
  /** Опасные клетки по игрокам: 10 слоёв width×height (1 — клетка бывает цвета игрока без героя рядом) */
  confusable: Uint8Array | null;
}

/** Фон из файла данных: rgb в base64 (atob есть и в браузере, и в Node) */
export function decodeMinimapBackground(json: {
  world: [number, number, number, number];
  width: number;
  height: number;
  tolerance: number;
  rgb: string;
  confusable?: string;
}): MinimapBackground {
  const bytes = (b64: string) => {
    const bin = atob(b64);
    const out = new Uint8ClampedArray(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  return {
    world: json.world,
    width: json.width,
    height: json.height,
    rgb: bytes(json.rgb),
    tolerance: json.tolerance,
    confusable: json.confusable ? new Uint8Array(bytes(json.confusable)) : null,
  };
}

/** Фон, разложенный по пикселям прямоугольника мини-карты для данной калибровки (кэш на последнюю пару) */
let bgCache: { key: string; rgb: Uint8ClampedArray; confused: Uint16Array } | null = null;
function backgroundFor(
  bg: MinimapBackground,
  cal: MinimapCalibration,
  rect: { x: number; y: number; w: number; h: number },
  fw: number,
  fh: number,
): { rgb: Uint8ClampedArray; confused: Uint16Array } {
  const key = `${cal.ax},${cal.bx},${cal.ay},${cal.by},${rect.x},${rect.y},${rect.w},${rect.h},${fw},${fh},${bg.width}`;
  if (bgCache?.key === key) return bgCache;
  const out = new Uint8ClampedArray(rect.w * rect.h * 3);
  /** Биты 0–9: пиксель в опасной клетке для игрока с этим номером */
  const confused = new Uint16Array(rect.w * rect.h);
  const layer = bg.width * bg.height;
  const [x0, y0, x1, y1] = bg.world;
  for (let y = 0; y < rect.h; y++)
    for (let x = 0; x < rect.w; x++) {
      const wx = ((rect.x + x + 0.5) / fw - cal.bx) / cal.ax, wy = ((rect.y + y + 0.5) / fh - cal.by) / cal.ay;
      const u = Math.floor(((wx - x0) / (x1 - x0)) * bg.width), v = Math.floor(((y1 - wy) / (y1 - y0)) * bg.height);
      if (u < 0 || v < 0 || u >= bg.width || v >= bg.height) continue;
      const s = (v * bg.width + u) * 3, o = (y * rect.w + x) * 3;
      out[o] = bg.rgb[s]!;
      out[o + 1] = bg.rgb[s + 1]!;
      out[o + 2] = bg.rgb[s + 2]!;
      if (bg.confusable) {
        let bits = 0;
        for (let slot = 0; slot < 10; slot++) if (bg.confusable[slot * layer + v * bg.width + u]) bits |= 1 << slot;
        confused[y * rect.w + x] = bits;
      }
    }
  bgCache = { key, rgb: out, confused };
  return bgCache;
}

export function readMinimap(
  frame: FrameAccess,
  layout: MinimapLayout | undefined,
  cal: MinimapCalibration | null,
  opts: { now?: () => number; background?: MinimapBackground | null } = {},
): MinimapReading {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  if (!layout || !cal) return { supported: false, heroes: [], rect: null, durationMs: now() - t0 };
  const rect = minimapRect(cal, layout.world, frame.width, frame.height);
  if (rect.w < 40 || rect.h < 40) return { supported: false, heroes: [], rect: null, durationMs: now() - t0 };
  const img = frame.read(rect);
  const area = rect.w * rect.h;
  const [minA, maxA] = layout.markerArea.map((a) => a * area) as [number, number];
  const side = Math.min(rect.w, rect.h);
  const [minS, maxS] = layout.markerSide.map((a) => a * side) as [number, number];
  const bgMap = opts.background ? backgroundFor(opts.background, cal, rect, frame.width, frame.height) : null;
  const bg = bgMap?.rgb ?? null;
  const confused = opts.background?.confusable && bgMap ? bgMap.confused : null;
  const bgTol = opts.background?.tolerance ?? 0;
  const heroes: MinimapHero[] = [];
  for (let slot = 0; slot < 10; slot++) {
    const color = layout.colors[slot];
    if (!color) continue;
    const tol = layout.colorToleranceBySlot?.[String(slot)] ?? layout.colorTolerance;
    // Значок: подходящая площадь, размер рамки и точность цвета (пятна местности и крипов отсеиваются).
    // Сначала соседние пятна одного цвета склеиваются: значок рассечён тёмным кольцом (герой под камерой)
    // или перекрыт другими значками
    const cand = mergeNear(blobs(img, color, tol, bg, bgTol, confused, 1 << slot), maxS * 0.6).filter(
      (b) =>
        b.n >= minA &&
        b.n <= maxA &&
        b.d <= layout.maxMeanDistance &&
        b.w >= minS &&
        b.w <= maxS &&
        b.h >= minS &&
        b.h <= maxS,
    );
    if (!cand.length) continue;
    // Из нескольких — самое крупное (значок частично перекрыт соседями — берём остаток побольше)
    const b = cand.reduce((a, c) => (c.n > a.n ? c : a));
    const px = rect.x + b.x + 0.5, py = rect.y + b.y + 0.5;
    // Второй значок не меньше половины первого — это иллюзия или клон того же игрока: где герой, неизвестно
    const ambiguous = cand.some((c) => c !== b && c.n >= 0.5 * b.n);
    // Уверенность: чем ближе цвет и чем меньше соперников — тем выше
    const confidence = Math.max(0, Math.min(1, (1 - b.d / tol) * (ambiguous ? 0.3 : cand.length === 1 ? 1 : 0.7)));
    const toWorld = (c: Blob) => ({ x: ((rect.x + c.x + 0.5) / frame.width - cal.bx) / cal.ax, y: ((rect.y + c.y + 0.5) / frame.height - cal.by) / cal.ay, n: c.n });
    heroes.push({
      slot,
      team: slot < 5 ? 'radiant' : 'dire',
      x: (px / frame.width - cal.bx) / cal.ax,
      y: (py / frame.height - cal.by) / cal.ay,
      px,
      py,
      confidence,
      ambiguous,
      others: cand.filter((c) => c !== b).map(toWorld),
    });
  }
  return { supported: true, heroes, rect, durationMs: now() - t0 };
}

/**
 * Калибровка по своему герою: пары «пиксель значка ↔ координаты из GSI» за матч. Подгонка устойчивая
 * (перебор пар точек, затем уточнение по согласным), принимается, только когда согласных точек достаточно
 * и они разнесены по карте — иначе null (позиции «не определены», а не угаданы).
 */
export function calibrateFromPairs(
  pairs: { px: number; py: number; wx: number; wy: number }[],
  fw: number,
  fh: number,
  opts: { minInliers?: number; minSpread?: number; tolPx?: number } = {},
): MinimapCalibration | null {
  const minInliers = opts.minInliers ?? 12, minSpread = opts.minSpread ?? 4000, tol = opts.tolPx ?? 3;
  if (pairs.length < minInliers) return null;
  let best: { ax: number; bx: number; ay: number; by: number } | null = null;
  let bestIn: typeof pairs = [];
  // Детерминированный перебор пар (без случайности — одинаковый результат в тестах)
  const step = Math.max(1, Math.floor(pairs.length / 60));
  for (let i = 0; i < pairs.length; i += step)
    for (let j = i + 1; j < pairs.length; j += step) {
      const p = pairs[i]!, q = pairs[j]!;
      if (Math.abs(q.wx - p.wx) < 1500 || Math.abs(q.wy - p.wy) < 1500) continue;
      const ax = (q.px - p.px) / (q.wx - p.wx), ay = (q.py - p.py) / (q.wy - p.wy);
      if (!(ax > 0) || !(ay < 0) || Math.abs(ax + ay) > 0.3 * ax) continue; // масштаб по осям одинаковый, y вниз
      const m = { ax, bx: p.px - ax * p.wx, ay, by: p.py - ay * p.wy };
      const inl = pairs.filter((r) => Math.hypot(m.ax * r.wx + m.bx - r.px, m.ay * r.wy + m.by - r.py) <= tol);
      if (inl.length > bestIn.length) {
        best = m;
        bestIn = inl;
      }
    }
  if (!best || bestIn.length < minInliers) return null;
  const xs = bestIn.map((r) => r.wx), ys = bestIn.map((r) => r.wy);
  if (Math.max(...xs) - Math.min(...xs) < minSpread || Math.max(...ys) - Math.min(...ys) < minSpread) return null;
  const fit = (a: number[], b: number[]) => {
    const n = a.length, ma = a.reduce((s, v) => s + v, 0) / n, mb = b.reduce((s, v) => s + v, 0) / n;
    let sab = 0, saa = 0;
    for (let i = 0; i < n; i++) (sab += (a[i]! - ma) * (b[i]! - mb)), (saa += (a[i]! - ma) ** 2);
    const k = sab / saa;
    return { k, c: mb - k * ma };
  };
  const fx = fit(xs, bestIn.map((r) => r.px)), fy = fit(ys, bestIn.map((r) => r.py));
  return { ax: fx.k / fw, bx: fx.c / fw, ay: fy.k / fh, by: fy.c / fh, source: 'self' };
}
