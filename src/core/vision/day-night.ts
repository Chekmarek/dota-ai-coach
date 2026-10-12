import type { FrameAccess } from './image.ts';

export type DayNight = 'day' | 'night';

/**
 * День или ночь — по значку над часами: жёлто-оранжевое солнце или бледно-голубая луна.
 * Замеры (1920×1080, игра 12.10.2026): у луны ~93 «лунных» пикселя в области, у солнца ~15 «солнечных»,
 * пересечений нет. Область привязана к часам в центре верхней панели.
 */
export const DAY_NIGHT_RECT = { x: 940, y: 4, w: 40, h: 20 };
const MIN_SUN = 8;
const MIN_MOON = 30;

export function readDayNight(frame: FrameAccess): { value: DayNight | null; confidence: number; rect: typeof DAY_NIGHT_RECT } {
  const s = frame.width / 1920, sy = frame.height / 1080;
  const rect = { x: Math.round(DAY_NIGHT_RECT.x * s), y: Math.round(DAY_NIGHT_RECT.y * sy), w: Math.round(DAY_NIGHT_RECT.w * s), h: Math.round(DAY_NIGHT_RECT.h * sy) };
  const img = frame.read(rect);
  let sun = 0, moon = 0;
  for (let i = 0; i < img.width * img.height; i++) {
    const r = img.data[i * 4]!, g = img.data[i * 4 + 1]!, b = img.data[i * 4 + 2]!;
    if (r > 190 && g > 120 && b < 110 && r - b > 100) sun++;
    if (b > 150 && b >= r + 10 && g > 140) moon++;
  }
  // Пороги заданы для 1920×1080 — пересчитываем на площадь
  const k = s * sy;
  if (sun >= MIN_SUN * k && moon < 5 * k) return { value: 'day', confidence: Math.min(1, sun / (15 * k)), rect };
  if (moon >= MIN_MOON * k && sun < 3 * k) return { value: 'night', confidence: Math.min(1, moon / (90 * k)), rect };
  return { value: null, confidence: 0, rect };
}

/**
 * До горна Дота показывает обратный отсчёт БЕЗ минуса, но с луной («1:19» ночью).
 * После горна первые 5 минут — день, поэтому «луна и время ≤ 1:30» однозначно означает отсчёт до горна.
 */
export const PRE_HORN_MAX_SEC = 90;
export function isPreHorn(clockSec: number, dayNight: DayNight | null): boolean {
  return dayNight === 'night' && clockSec <= PRE_HORN_MAX_SEC;
}
