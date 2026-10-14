// Верхняя панель матча: 10 портретов героев (5 Сил Света слева, 5 Сил Тьмы справа).
// Для каждой ячейки: какой герой (сравнение с шаблонами портретов), жив или мёртв (мёртвый — серый портрет),
// секунды до возрождения (белые цифры под портретом, тот же глифовый OCR, что у часов).
// Положения — в раскладке HUD (topBar), размечены по набору кадров наблюдателя 2026-10-14 (1920×1080, 16:9).
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { GlyphModel } from '../ocr/glyph-ocr.ts';
import { classify } from '../ocr/glyph-ocr.ts';
import { segment } from './segment.ts';
import type { HudLayout, TopBarLayout } from './hud-layout.ts';
import { layoutFits } from './hud-layout.ts';
import type { FrameAccess, RgbaImage } from './image.ts';

export type Team = 'radiant' | 'dire';

/** Сетка, по которой сравниваются портреты: верхняя часть портрета без значков в нижних углах */
export const PORTRAIT_GRID_W = 14;
export const PORTRAIT_GRID_H = 5;
/** Шаблоны хранятся целыми (×PORTRAIT_SCALE) */
export const PORTRAIT_SCALE = 25;

export interface PortraitTemplate {
  key: string;
  /** Нормализованные цвета сетки (RGB по клеткам), ×PORTRAIT_SCALE */
  t: number[];
  /** Нормализованная яркость сетки (для серого портрета мёртвого героя), ×PORTRAIT_SCALE */
  l: number[];
  /** Насыщенность картинки в той же части портрета (см. cellSaturation) — с ней сравнивается портрет на экране */
  s: number;
  /**
   * Откуда шаблон: нет поля — картинка героя Valve; «dataset:<матч>» — портрет, снятый с кадров набора
   * (другой облик героя: персона, аркана). У одного героя может быть несколько шаблонов.
   */
  variant?: string;
}

export interface PortraitTemplates {
  patch: string;
  grid: [number, number];
  heroes: PortraitTemplate[];
}

export interface TopBarSlot {
  /** Номер ячейки слева направо (0–4 — Силы Света, 5–9 — Силы Тьмы), как номер игрока в GSI */
  slot: number;
  team: Team;
  /** Союзник или враг игрока; null — своя команда неизвестна (наблюдатель, нет GSI) */
  side: 'ally' | 'enemy' | null;
  /** Герой; null — портрет не узнан уверенно (или ячейка пуста) */
  heroKey: string | null;
  heroConfidence: number;
  /** Жив; null — не определить (ячейка пуста или закрыта) */
  alive: boolean | null;
  aliveConfidence: number;
  /** Секунды до возрождения (только мёртвый и только если цифры прочитаны уверенно) */
  respawnSec: number | null;
  respawnConfidence: number;
}

export interface TopBarReading {
  /** false — кадр не 16:9 или в раскладке нет верхней панели: «не поддерживается», а не «пусто» */
  supported: boolean;
  slots: TopBarSlot[];
  durationMs: number;
}

export interface TopBarOptions {
  /** Своя команда из GSI (team_name); null — не знаем, союзников и врагов не различаем */
  ourTeam?: Team | null;
  now?: () => number;
}

/** Ниже этой уверенности герой ячейки не называется */
export const MIN_HERO_CONFIDENCE = 0.2;
/**
 * Портрет серый (герой мёртв), если его насыщенность ниже этой доли насыщенности картинки героя.
 * Порог относительный: у бледных героев (Tusk, Sven) и живой портрет почти бесцветный.
 * На наборе 2026-10-14 (3 матча): живые — от 0,73 (1-й перцентиль), мёртвые — 0,13 (медиана).
 */
export const DEAD_SATURATION_RATIO = 0.5;
/** Доля светлых пикселей, ниже которой ячейка не читается (панель тёмная — до горна, затемнение экрана) */
export const MIN_BRIGHT_SHARE = 0.2;
/** Таймер возрождения принимается при уверенности OCR не ниже этой */
export const MIN_RESPAWN_CONFIDENCE = 0.5;

/** Средний цвет по клеткам сетки (RGB) поверх прямоугольника изображения */
export function portraitGrid(img: RgbaImage, x0: number, y0: number, w: number, h: number): Float32Array {
  const out = new Float32Array(PORTRAIT_GRID_W * PORTRAIT_GRID_H * 3);
  for (let gy = 0; gy < PORTRAIT_GRID_H; gy++)
    for (let gx = 0; gx < PORTRAIT_GRID_W; gx++) {
      const xa = Math.floor(x0 + (gx * w) / PORTRAIT_GRID_W), xb = Math.max(xa + 1, Math.floor(x0 + ((gx + 1) * w) / PORTRAIT_GRID_W));
      const ya = Math.floor(y0 + (gy * h) / PORTRAIT_GRID_H), yb = Math.max(ya + 1, Math.floor(y0 + ((gy + 1) * h) / PORTRAIT_GRID_H));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = ya; y < yb; y++)
        for (let x = xa; x < xb; x++) {
          const i = (y * img.width + x) * 4;
          r += img.data[i]!;
          g += img.data[i + 1]!;
          b += img.data[i + 2]!;
          n++;
        }
      const k = (gy * PORTRAIT_GRID_W + gx) * 3;
      out[k] = r / n;
      out[k + 1] = g / n;
      out[k + 2] = b / n;
    }
  return out;
}

/** Яркость каждой клетки из RGB-сетки */
export function gridLuma(rgb: Float32Array): Float32Array {
  const o = new Float32Array(rgb.length / 3);
  for (let i = 0; i < o.length; i++) o[i] = 0.299 * rgb[i * 3]! + 0.587 * rgb[i * 3 + 1]! + 0.114 * rgb[i * 3 + 2]!;
  return o;
}

/** Вычесть среднее и разделить на разброс: яркость и контраст отрисовки не важны */
export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (const x of v) s += x;
  const m = s / v.length;
  let q = 0;
  for (const x of v) q += (x - m) ** 2;
  const sd = Math.sqrt(q / v.length) || 1;
  const o = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) o[i] = (v[i]! - m) / sd;
  return o;
}

function distance(a: Float32Array, t: ArrayLike<number>): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += (a[i]! - t[i]! / PORTRAIT_SCALE) ** 2;
  return d / a.length;
}

/**
 * Насыщенность как в HSV ((max−min)/max) по светлым пикселям и доля светлых пикселей.
 * Тёмные пиксели не учитываются: затемнённый, но цветной портрет не должен выглядеть серым.
 */
export function cellSaturation(img: RgbaImage, x0: number, y0: number, w: number, h: number): { sat: number; bright: number } {
  let s = 0, n = 0, all = 0;
  for (let y = Math.floor(y0); y < Math.floor(y0 + h); y++)
    for (let x = Math.floor(x0); x < Math.floor(x0 + w); x++) {
      const i = (y * img.width + x) * 4;
      const r = img.data[i]!, g = img.data[i + 1]!, b = img.data[i + 2]!;
      const mx = Math.max(r, g, b);
      all++;
      if (mx < 40) continue;
      s += (mx - Math.min(r, g, b)) / mx;
      n++;
    }
  return { sat: n ? s / n : 0, bright: all ? n / all : 0 };
}

/** Ближайший шаблон: по цветам (живой портрет) или по яркости (подходит и для серого портрета мёртвого) */
export function matchPortrait(grid: Float32Array, byLuma: boolean, templates: PortraitTemplates): { key: string | null; confidence: number; template: PortraitTemplate | null } {
  const v = byLuma ? normalize(gridLuma(grid)) : normalize(grid);
  // Лучшее расстояние по каждому герою (у героя может быть несколько шаблонов-обликов)
  const perHero = new Map<string, { d: number; t: PortraitTemplate }>();
  for (const h of templates.heroes) {
    const d = distance(v, byLuma ? h.l : h.t);
    const cur = perHero.get(h.key);
    if (!cur || d < cur.d) perHero.set(h.key, { d, t: h });
  }
  let best = Infinity, second = Infinity, key: string | null = null, template: PortraitTemplate | null = null;
  for (const [k, { d, t }] of perHero) {
    if (d < best) {
      second = best;
      best = d;
      key = k;
      template = t;
    } else if (d < second) second = d;
  }
  if (key === null || !Number.isFinite(second)) return { key: null, confidence: 0, template: null };
  // Уверенность — насколько лучший отрывается от второго (0 — неразличимы)
  const confidence = Math.max(0, Math.min(1, 1 - best / second));
  return { key, confidence, template };
}

function slotX(tb: TopBarLayout, slot: number): number {
  return slot < 5 ? tb.radiantX + slot * tb.step : tb.direX + (slot - 5) * tb.step;
}

export function readTopBar(frame: FrameAccess, layout: HudLayout, templates: PortraitTemplates, model: GlyphModel, opts: TopBarOptions = {}): TopBarReading {
  const now = opts.now ?? (() => performance.now());
  const t0 = now();
  const tb = layout.topBar;
  if (!tb || !layoutFits(layout, frame.width, frame.height)) return { supported: false, slots: [], durationMs: now() - t0 };
  const sx = frame.width / layout.reference.w, sy = frame.height / layout.reference.h;
  // Одна полоса на всю панель — меньше копирований
  const x0 = Math.round(tb.radiantX * sx), x1 = Math.round((tb.direX + 4 * tb.step + tb.w) * sx);
  const bottom = Math.round((tb.timer[1] + tb.timer[3]) * sy);
  const strip = frame.read({ x: x0, y: 0, w: x1 - x0, h: bottom });
  const ourTeam = opts.ourTeam ?? null;
  const slots: TopBarSlot[] = [];
  for (let slot = 0; slot < 10; slot++) {
    const team: Team = slot < 5 ? 'radiant' : 'dire';
    const cx = Math.round((slotX(tb, slot) - tb.radiantX) * sx);
    const [rx, ry, rw, rh] = tb.roi;
    const roi = { x: cx + Math.round(rx * sx), y: Math.round((tb.y + ry) * sy), w: Math.round(rw * sx), h: Math.round(rh * sy) };
    const side = ourTeam === null ? null : team === ourTeam ? 'ally' : 'enemy';
    const { sat, bright } = cellSaturation(strip, roi.x, roi.y, roi.w, roi.h);
    if (bright < MIN_BRIGHT_SHARE) {
      // Панель тёмная (до горна, затемнение): ни героя, ни «жив/мёртв» не утверждаем
      slots.push({ slot, team, side, heroKey: null, heroConfidence: 0, alive: null, aliveConfidence: 0, respawnSec: null, respawnConfidence: 0 });
      continue;
    }
    const grid = portraitGrid(strip, roi.x, roi.y, roi.w, roi.h);
    // Сначала по яркости (работает и для серого портрета), затем насыщенность сравнивается с картинкой этого героя
    const byLuma = matchPortrait(grid, true, templates);
    const ratio = byLuma.template && byLuma.template.s > 0 ? sat / byLuma.template.s : 1;
    // Таймер читается у каждой ячейки: сразу после смерти рамка с цифрами уже есть, а портрет ещё цветной.
    // У живых героев ложных таймеров на наборе 2026-10-14 — 0,13 % ячеек, и все они «1» в момент возрождения.
    let respawnSec: number | null = null;
    let respawnConfidence = 0;
    const [tx, ty, tw, th] = tb.timer;
    const seg = segment(cropStrip(strip, cx + Math.round(tx * sx), Math.round(ty * sy), Math.round(tw * sx), Math.round(th * sy)), { mode: 'white' });
    // Таймер — 1–3 цифры; больше пятен — не таймер (и не тратим время на сравнение каждого с образцами)
    if (seg.hasText && !seg.truncated && seg.glyphs.length <= 3) {
      const glyphs = seg.glyphs.map((g) => classify(model, g));
      const text = glyphs.map((g) => g.ch).join('');
      const confidence = Math.min(...glyphs.map((g) => g.score));
      const n = /^\d{1,3}$/.test(text) ? Number(text) : NaN;
      if (n >= 1 && n <= 200 && confidence >= MIN_RESPAWN_CONFIDENCE) {
        respawnSec = n;
        respawnConfidence = confidence;
      }
    }
    const grey = ratio < DEAD_SATURATION_RATIO;
    // Мёртв, если портрет серый или под ним таймер возрождения
    const dead = grey || respawnSec !== null;
    // Уверенность «жив/мёртв» — насколько отношение далеко от порога; таймер — отдельное подтверждение смерти
    const aliveConfidence = respawnSec !== null && !grey ? respawnConfidence : Math.min(1, Math.abs(ratio - DEAD_SATURATION_RATIO) / DEAD_SATURATION_RATIO);
    // Цветной портрет различаем по цветам — точнее, чем по яркости
    const m = grey ? byLuma : matchPortrait(grid, false, templates);
    const known = m.key !== null && m.confidence >= MIN_HERO_CONFIDENCE;
    slots.push({
      slot,
      team,
      side,
      heroKey: known ? m.key : null,
      heroConfidence: m.confidence,
      alive: !dead,
      aliveConfidence,
      respawnSec,
      respawnConfidence,
    });
  }
  return { supported: true, slots, durationMs: now() - t0 };
}

function cropStrip(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    const s = ((y + j) * img.width + x) * 4;
    out.set(img.data.subarray(s, s + w * 4), j * w * 4);
  }
  return { width: w, height: h, data: out };
}
