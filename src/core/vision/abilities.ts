// Способности на нижней панели: состояние каждой ячейки, секунды перезарядки и уровень (точки под иконкой).
// Панель показывает ВЫБРАННОГО юнита: если выбран не свой герой, это его способности (см. selectedUnit).
import { readText, type GlyphModel } from '../ocr/glyph-ocr.ts';
import type { FrameAccess, RgbaImage } from './image.ts';
import { legacyGeometry, type HudGeometry } from './hud-geometry.ts';

export type AbilityState = 'ready' | 'cooldown' | 'no-mana' | 'unlearned';

export interface AbilitySlot {
  /** Номер ячейки слева направо, с 0 */
  index: number;
  state: AbilityState;
  /** Секунды до готовности (только на перезарядке, если цифры прочитаны уверенно) */
  cooldown: number | null;
  /** Уровень способности — число горящих точек под ячейкой */
  level: number;
  /** Насколько уверенно определено состояние, 0..1 */
  confidence: number;
}

/**
 * Геометрия (1920×1080, замеры 2026-10-12 на Kez, Shadow Fiend, Monkey King, Morphling):
 * первая ячейка начинается на 113 px правее края полосы маны (barLeft), шаг 58 px, иконка 50×48 (y 947–994),
 * точки уровня — строка y ≈ 1004. Ширина панели меняется ступенькой 29 px на ячейку с каждой стороны:
 * при barLeft = 667 ячеек 6, при 696 — 5 и т. д.
 */
const BASE_BAR_LEFT = 667;
const BASE_SLOTS = 6;
const STEP = 29;
const FIRST = 113;
const PITCH = 58;
const ICON = { dx: 3, y: 949, w: 48, h: 45 };
const PIP_Y = 1004;

/** Пороги по 1290 ячейкам игры 4: перезарядка — белых пикселей ≥ 17 (у прочих ≤ 12, это стоимость маны);
 *  не изучена — средняя насыщенность < 0.22; нехватка маны — синих пикселей ≥ 25 % (у прочих ~0 %, у синих ≥ 30 %) */
const MIN_WHITE = 15;
const MAX_UNLEARNED_SAT = 0.22;
const MIN_BLUE = 0.25;
/** Ячейка на перезарядке затемнена (средняя яркость ≤ ~80); яркая иконка с белыми бликами (у Kez — 147) — не перезарядка */
const MAX_COOLDOWN_LUM = 110;
/** Нехватка маны — тёмно-синяя заливка (яркость 22–41); бирюзовая иконка сама по себе (Monkey King, 87) — нет */
const MAX_NO_MANA_LUM = 60;

export function abilitySlotCount(barLeft: number, frameWidth: number, geo: HudGeometry = legacyGeometry(frameWidth, (frameWidth * 9) / 16)): number {
  const k = Math.round((geo.refX(barLeft) - BASE_BAR_LEFT) / STEP);
  return Math.max(1, Math.min(8, BASE_SLOTS - k));
}

/**
 * Секунды перезарядки по изображению иконки (область 48×45 при 1920×1080): крупные белые цифры в центре.
 * model — шаблоны крупных цифр (glyphs-cooldown.json), обучаются отдельно от мелких цифр интерфейса.
 */
export function readCooldown(icon: RgbaImage, model: GlyphModel): { value: number | null; text: string; confidence: number } {
  const k = icon.width / ICON.w;
  const center = onlyWhite(cropImage(icon, Math.round(4 * k), Math.round(9 * k), icon.width - Math.round(8 * k), icon.height - Math.round(21 * k)));
  const t = readText(model, center, { mode: 'white', minSeparation: 40 });
  const ok = t.hasText && !t.truncated && /^\d{1,3}$/.test(t.text);
  return { value: ok && t.confidence >= 0.5 ? Number(t.text) : null, text: t.text, confidence: ok ? t.confidence : 0 };
}

function cropImage(img: RgbaImage, x: number, y: number, w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) data.set(img.data.subarray(((y + j) * img.width + x) * 4, ((y + j) * img.width + x + w) * 4), j * w * 4);
  return { width: w, height: h, data };
}

export function readAbilities(
  frame: FrameAccess,
  barLeft: number,
  cooldownModel: GlyphModel | null,
  geo: HudGeometry = legacyGeometry(frame.width, frame.height),
): AbilitySlot[] {
  const s = geo.s, sy = geo.sy;
  const n = abilitySlotCount(barLeft, frame.width, geo);
  const slots: AbilitySlot[] = [];
  for (let i = 0; i < n; i++) {
    const left = barLeft + Math.round((FIRST + PITCH * i) * s);
    const rect = { x: left + Math.round(ICON.dx * s), y: Math.round(geo.y(ICON.y)), w: Math.round(ICON.w * s), h: Math.round(ICON.h * sy) };
    const img = frame.read(rect);
    let sat = 0, lum = 0, white = 0, blue = 0;
    const W = img.width, H = img.height;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        const r = img.data[p]!, g = img.data[p + 1]!, b = img.data[p + 2]!;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sat += mx ? (mx - mn) / mx : 0;
        lum += 0.299 * r + 0.587 * g + 0.114 * b;
        // Цифры перезарядки — в центре; низ ячейки занят стоимостью маны, угол — буквой клавиши
        if (x > 8 * s && x < W - 8 * s && y > 6 * sy && y < H - 14 * sy && r > 200 && g > 200 && b > 200) white++;
        if (b > r + 15 && b >= g) blue++;
      }
    const area = W * H;
    sat /= area;
    lum /= area;
    const blueShare = blue / area;
    const level = countPips(frame, left, Math.round(56 * s), Math.round(geo.y(PIP_Y)), geo);

    let state: AbilityState, confidence: number, cooldown: number | null = null;
    const cd = white >= MIN_WHITE * s * sy && cooldownModel ? readCooldown(img, cooldownModel).value : null;
    // Перезарядка: белые цифры на затемнённой иконке (если секунды прочитаны — яркость не важна)
    if (white >= MIN_WHITE * s * sy && (cd !== null || lum <= MAX_COOLDOWN_LUM)) {
      state = 'cooldown';
      confidence = cd !== null ? 1 : Math.min(1, white / (30 * s * sy));
      cooldown = cd;
    } else if (sat < MAX_UNLEARNED_SAT) {
      state = 'unlearned';
      confidence = Math.min(1, (MAX_UNLEARNED_SAT - sat) / 0.1 + 0.5);
    } else if (blueShare >= MIN_BLUE && lum <= MAX_NO_MANA_LUM) {
      state = 'no-mana';
      confidence = Math.min(1, blueShare / 0.5);
    } else {
      state = 'ready';
      confidence = Math.min(1, (sat - MAX_UNLEARNED_SAT) / 0.3 + 0.5);
    }
    slots.push({ index: i, state, cooldown, level, confidence });
  }
  return slots;
}

/**
 * Цифры перезарядки чисто белые, а под ними — затемнённая, но местами светлая иконка. Автоматический порог
 * при маленькой цифре захватывает куски иконки, поэтому оставляем только почти белые пиксели.
 */
function onlyWhite(img: RgbaImage): RgbaImage {
  const data = new Uint8ClampedArray(img.data.length);
  for (let p = 0; p < data.length; p += 4) {
    const keep = img.data[p]! > 190 && img.data[p + 1]! > 190 && img.data[p + 2]! > 190;
    if (keep) data.set(img.data.subarray(p, p + 3), p);
    data[p + 3] = 255;
  }
  return { width: img.width, height: img.height, data };
}

/** Горящие точки уровня: светлые чёрточки длиной ≥ 4 px в строке под ячейкой */
function countPips(frame: FrameAccess, left: number, width: number, y: number, geo: HudGeometry = legacyGeometry(frame.width, frame.height)): number {
  const row = frame.read({ x: left, y, w: width, h: 1 });
  const minRun = Math.max(2, Math.round(4 * geo.s));
  let pips = 0, run = 0;
  for (let x = 0; x < row.width; x++) {
    const p = x * 4;
    const l = 0.299 * row.data[p]! + 0.587 * row.data[p + 1]! + 0.114 * row.data[p + 2]!;
    if (l > 120) run++;
    else {
      if (run >= minRun) pips++;
      run = 0;
    }
  }
  if (run >= minRun) pips++;
  return pips;
}
