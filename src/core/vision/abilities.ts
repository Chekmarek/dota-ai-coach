// Способности на нижней панели: состояние каждой ячейки, секунды перезарядки и уровень (точки под иконкой).
// Панель показывает ВЫБРАННОГО юнита: если выбран не свой герой, это его способности (см. selectedUnit).
import { readText, type GlyphModel } from '../ocr/glyph-ocr.ts';
import type { FrameAccess, RgbaImage } from './image.ts';
import { legacyGeometry, type HudGeometry } from './hud-geometry.ts';
import { EXTRA_EDGES, isGridEdge } from './hud-anchors.ts';

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

/** Раскладка ячеек способностей на нижней панели (координаты 1920×1080, от края полосы маны) */
export interface AbilityPanel {
  first: number;
  pitch: number;
  icon: { dx: number; y: number; w: number; h: number };
  pipY: number;
  /** Ширина строки, в которой считаются точки уровня одной ячейки */
  pipW: number;
}

/** Панель из 5–7 ячеек: края 667 + 29·k */
export const GRID_PANEL: AbilityPanel = { first: FIRST, pitch: PITCH, icon: ICON, pipY: PIP_Y, pipW: 56 };

/**
 * Панель из 4 ячеек (край 712; Hero Demo 2026-10-17: Queen of Pain, Juggernaut, Axe, Faceless Void):
 * ячейки крупнее — первая так же на 113 px правее края, но шаг 65 px, иконка 56×51 (y 949–1000),
 * точки уровня (8 px, шаг 12 px) — строка y ≈ 1008.
 */
export const WIDE_PANEL: AbilityPanel = { first: 113, pitch: 65, icon: { dx: 3, y: 949, w: 56, h: 51 }, pipY: 1008, pipW: 60 };

/** Раскладка ячеек для найденного края панели; null — край вне известных (способности не читаем) */
export function abilityPanel(barLeft: number, geo: HudGeometry): { panel: AbilityPanel; slots: number } | null {
  if (isGridEdge(barLeft, geo)) return { panel: GRID_PANEL, slots: abilitySlotCount(barLeft, 0, geo) };
  const ref = geo.refX(barLeft);
  if (EXTRA_EDGES.some((e) => Math.abs(ref - e) <= 1)) return { panel: WIDE_PANEL, slots: 4 };
  return null;
}

/** Пороги по 1290 ячейкам игры 4: перезарядка — белых пикселей ≥ 17 (у прочих ≤ 12, это стоимость маны);
 *  не изучена — средняя насыщенность < 0.22; нехватка маны — синих пикселей ≥ 25 % (у прочих ~0 %, у синих ≥ 30 %) */
const MIN_WHITE = 15;
const MAX_UNLEARNED_SAT = 0.22;
const MIN_BLUE = 0.25;
/** Ячейка на перезарядке затемнена (средняя яркость ≤ ~80); яркая иконка с белыми бликами (у Kez — 147) — не перезарядка */
const MAX_COOLDOWN_LUM = 110;
/** Нехватка маны — тёмно-синяя заливка (яркость 22–41); бирюзовая иконка сама по себе (Monkey King, 87) — нет */
const MAX_NO_MANA_LUM = 60;
/**
 * Крупная ячейка, перезарядка без прочитанных секунд. Цифры всегда стоят в строках 15–30 из 51 (0.29–0.59),
 * иконка под ними затемнена (яркость 40–75 на 20 ячейках). Белые лезвия и завитки на самих иконках (Queen of Pain,
 * Juggernaut, Faceless Void, Nature's Prophet) выходят за эту полосу, бывают ниже цифр и светлее (74–132).
 */
const DIGITS_BAND = { top: 0.25, bottom: 0.63, minH: 0.22, maxH: 0.37 };
const WIDE_MAX_COOLDOWN_LUM = 65;
/** Крупная ячейка: секунды перезарядки принимаются только с такой уверенностью */
const WIDE_MIN_CD_CONFIDENCE = 0.8;

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
  // Край вне известных — как раньше, по сетке (вызывающий код сам решает, читать ли: см. abilityPanel)
  const known = abilityPanel(barLeft, geo);
  const P = known?.panel ?? GRID_PANEL;
  const n = known?.slots ?? abilitySlotCount(barLeft, frame.width, geo);
  // Пороги заданы для иконки 48×45; у крупной ячейки поля и площадь цифр пропорционально больше
  const kx = P.icon.w / ICON.w, ky = P.icon.h / ICON.h;
  const slots: AbilitySlot[] = [];
  for (let i = 0; i < n; i++) {
    const left = barLeft + Math.round((P.first + P.pitch * i) * s);
    const rect = { x: left + Math.round(P.icon.dx * s), y: Math.round(geo.y(P.icon.y)), w: Math.round(P.icon.w * s), h: Math.round(P.icon.h * sy) };
    const img = frame.read(rect);
    let sat = 0, lum = 0, white = 0, blue = 0, whiteTop = Infinity, whiteBottom = -1;
    const W = img.width, H = img.height;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const p = (y * W + x) * 4;
        const r = img.data[p]!, g = img.data[p + 1]!, b = img.data[p + 2]!;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        sat += mx ? (mx - mn) / mx : 0;
        lum += 0.299 * r + 0.587 * g + 0.114 * b;
        // Цифры перезарядки — в центре; низ ячейки занят стоимостью маны, угол — буквой клавиши
        if (x > 8 * kx * s && x < W - 8 * kx * s && y > 6 * ky * sy && y < H - 14 * ky * sy && r > 200 && g > 200 && b > 200) {
          white++;
          whiteTop = Math.min(whiteTop, y);
          whiteBottom = Math.max(whiteBottom, y);
        }
        if (b > r + 15 && b >= g) blue++;
      }
    const area = W * H;
    sat /= area;
    lum /= area;
    const blueShare = blue / area;
    const level = countPips(frame, left, Math.round(P.pipW * s), Math.round(geo.y(P.pipY)), geo);

    let state: AbilityState, confidence: number, cooldown: number | null = null;
    const minWhite = MIN_WHITE * s * sy * kx * ky;
    const read = white >= minWhite && cooldownModel ? readCooldown(img, cooldownModel) : null;
    let cd = read?.value ?? null;
    let digitLike = true;
    let uncertain = false;
    if (P !== GRID_PANEL) {
      // Крупная ячейка: белое на самой иконке легко принять за цифры (молния Anti-Mage читалась как «4»
      // с уверенностью 0.51; настоящие секунды — 0.91–1.0). Секунды берём только уверенные; без них перезарядка —
      // лишь на затемнённой иконке, и только если цифры прочитались текстом или белое лежит в полосе цифр
      if (read && read.confidence < WIDE_MIN_CD_CONFIDENCE) cd = null;
      const iconH = P.icon.h * sy, whiteH = whiteBottom - whiteTop + 1;
      const inBand =
        whiteTop >= DIGITS_BAND.top * iconH &&
        whiteBottom <= DIGITS_BAND.bottom * iconH &&
        whiteH >= DIGITS_BAND.minH * iconH &&
        whiteH <= DIGITS_BAND.maxH * iconH;
      const readAsDigits = !!read && /^\d{1,3}$/.test(read.text);
      digitLike = lum <= WIDE_MAX_COOLDOWN_LUM && (inBand || readAsDigits);
      // Белое в центре есть, но перезарядку подтвердить нельзя: это рисунок иконки (молния, лезвие) — или
      // перезарядка на светлой иконке (E у Zeus: яркость 83–97, цифры сливаются с рисунком). Отличить нельзя —
      // состояние отдаём с уверенностью 0, модель матча его не примет
      uncertain = white >= minWhite && cd === null && !digitLike;
    }
    // Перезарядка: белые цифры на затемнённой иконке (если секунды прочитаны — яркость не важна)
    if (white >= minWhite && (cd !== null || (lum <= MAX_COOLDOWN_LUM && digitLike))) {
      state = 'cooldown';
      confidence = cd !== null ? 1 : Math.min(1, white / (30 * s * sy * kx * ky));
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
    if (uncertain) confidence = 0;
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
