// «Опоры» HUD: элементы, положение которых зависит от героя.
// Нижняя панель меняет ширину (у героев разное число способностей), поэтому кружок уровня сдвигается.
// Опора — левый край полосы маны: от него до центра кружка уровня всегда ~191 px (при 1920×1080),
// проверено на Kez, Shadow Fiend, Monkey King, Morphling.
import type { FrameAccess } from './image.ts';
import { legacyGeometry, type HudGeometry } from './hud-geometry.ts';

export interface BarAnchor {
  /** x левого края полосы маны в координатах кадра; null — не найден */
  barLeft: number | null;
  confidence: number;
}

/**
 * Пиксель «полосы маны»: синий заметно больше красного и не меньше зелёного.
 * Подобрано по кадрам: полная полоса (66,106,206), у мёртвого героя (67,104,147),
 * пустая (21,35,69), пустая у мёртвого (21,17,39) — подходят; светлый край рамки (96,138,126)
 * и тёмная рамка (44,55,54) — нет. Важно соотношение каналов, а не яркость.
 */
function isManaPixel(r: number, g: number, b: number): boolean {
  return b - r >= 15 && b >= r * 1.6 && b >= g * 0.95 && b > 30;
}

/**
 * Ищет левый край полосы маны: идём от заведомо внутренней точки полосы влево,
 * пока столбцы в основном «синие». Координаты — в 1920×1080, в кадр их переводит geo (по умолчанию — растяжение 16:9).
 */
export function findBarAnchor(frame: FrameAccess, geo: HudGeometry = legacyGeometry(frame.width, frame.height)): BarAnchor {
  const y0 = Math.round(geo.y(1052)), y1 = Math.round(geo.y(1064));
  const xFrom = Math.round(geo.x(800)), xTo = Math.round(geo.x(560));
  const strip = frame.read({ x: xTo, y: y0, w: xFrom - xTo, h: y1 - y0 });
  const colFrac = (x: number) => {
    let n = 0;
    for (let y = 0; y < strip.height; y++) {
      const i = (y * strip.width + x) * 4;
      if (isManaPixel(strip.data[i]!, strip.data[i + 1]!, strip.data[i + 2]!)) n++;
    }
    return n / strip.height;
  };
  // Стартовая точка должна быть внутри полосы
  const start = strip.width - 1;
  if (colFrac(start) < 0.7) return { barLeft: null, confidence: 0 };
  let misses = 0;
  for (let x = start; x >= 0; x--) {
    if (colFrac(x) < 0.5) {
      if (++misses >= 3) {
        const edge = x + 3;
        // Край должен быть резким: левее несколько столбцов подряд не «синие»
        let outside = 0;
        for (let k = x; k >= Math.max(0, x - 6); k--) if (colFrac(k) < 0.3) outside++;
        return snapToSteps(xTo + edge, geo, outside >= 5 ? 0.95 : 0.6);
      }
    } else misses = 0;
  }
  return { barLeft: null, confidence: 0 };
}

export type UnitRelation = 'ally' | 'enemy';

/**
 * Чей юнит выбран: полоса здоровья зелёная — свой герой или союзник, красная — враг.
 * Пустая полоса (0 HP, тёмная) — определить нельзя.
 */
export function selectedUnitRelation(
  frame: FrameAccess,
  barLeft: number,
  geo: HudGeometry = legacyGeometry(frame.width, frame.height),
): { value: UnitRelation | null; confidence: number } {
  const s = geo.s, sy = geo.sy;
  const strip = frame.read({ x: barLeft + Math.round(4 * s), y: Math.round(geo.y(1024)), w: Math.round(40 * s), h: Math.round(12 * sy) });
  let green = 0, red = 0;
  const n = strip.width * strip.height;
  for (let i = 0; i < n; i++) {
    const r = strip.data[i * 4]!, g = strip.data[i * 4 + 1]!, b = strip.data[i * 4 + 2]!;
    if (g > 90 && g > r * 1.4 && g > b * 1.3) green++;
    else if (r > 110 && r > g * 1.8 && r > b * 1.8) red++;
  }
  const fg = green / n, fr = red / n;
  if (fg >= 0.6 && fr < 0.1) return { value: 'ally', confidence: Math.min(1, fg) };
  if (fr >= 0.6 && fg < 0.1) return { value: 'enemy', confidence: Math.min(1, fr) };
  return { value: null, confidence: 0 };
}

/**
 * Ширина нижней панели меняется ступеньками: каждая ячейка способности добавляет по ~29 px с каждой стороны
 * (замеры: 667 — Kez, Shadow Fiend, Monkey King; 696 — Morphling). Найденный край притягивается к ближайшей
 * ступеньке; если до неё дальше 5 px — край найден ненадёжно (например, рамка в посмертной окраске),
 * и опора не используется: лучше не прочитать уровень, чем прочитать его не в том месте.
 *
 * Шаг не везде 29 px: у героев с четырьмя способностями (Hero Demo 2026-10-17: Faceless Void, Timbersaw,
 * Juggernaut, Axe, Queen of Pain, Anti-Mage, Death Prophet, Nature's Prophet, Nyx Assassin) край — 712,
 * а ячейки способностей у них крупнее (шаг ~65 px вместо 58). Такие края — в EXTRA_EDGES.
 */
const STEP_BASE = 667;
const STEP = 29;
const SNAP_TOLERANCE = 5;
/** Проверенные края вне сетки 667 + 29·k (координаты 1920×1080) */
export const EXTRA_EDGES: readonly number[] = [712];

function snapToSteps(x: number, geo: HudGeometry, confidence: number): BarAnchor {
  const ref = geo.refX(x);
  const k = Math.round((ref - STEP_BASE) / STEP);
  const candidates = Math.abs(k) <= 4 ? [STEP_BASE + k * STEP, ...EXTRA_EDGES] : [...EXTRA_EDGES];
  const snapped = candidates.reduce((a, b) => (Math.abs(ref - b) < Math.abs(ref - a) ? b : a));
  if (Math.abs(ref - snapped) > SNAP_TOLERANCE) return { barLeft: null, confidence: 0 };
  return { barLeft: Math.round(geo.x(snapped)), confidence };
}

/** Край панели в координатах 1920×1080 — одна из ступенек 667 + 29·k (а не край из EXTRA_EDGES) */
export function isGridEdge(barLeft: number, geo: HudGeometry): boolean {
  const ref = geo.refX(barLeft);
  return Math.abs(ref - (STEP_BASE + Math.round((ref - STEP_BASE) / STEP) * STEP)) <= 1;
}