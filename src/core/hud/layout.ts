// Раскладка подсказок поверх игры (этап 3): зоны и запретные области HUD Dota в единицах экрана.
// Одна раскладка на любой экран: u = min(высота, ширина × 9/16) — так масштабируется HUD Dota
// (по высоте, а на экранах уже 16:9 — по ширине); якоря — края и середина экрана.
// Чистое ядро: только zod.
import { z } from 'zod';

export const HUD_ZONE_IDS = ['alert', 'decision', 'timing', 'review'] as const;
export type HudZoneId = (typeof HUD_ZONE_IDS)[number];

const anchorX = z.enum(['left', 'center', 'right']);
const anchorY = z.enum(['top', 'center', 'bottom']);
const unit = z.number().min(-2).max(2);
const size = z.number().min(0.01).max(2);

export const areaSchema = z.object({
  id: z.string().max(40),
  nameRu: z.string().max(80),
  ax: anchorX,
  ay: anchorY,
  x: unit,
  y: unit,
  w: size,
  h: size,
});
export type HudArea = z.infer<typeof areaSchema>;

export const zoneSchema = areaSchema.extend({
  id: z.enum(HUD_ZONE_IDS),
  /** С какого края выезжают карточки */
  from: z.enum(['top', 'bottom', 'left', 'right']),
  /** Куда растёт стопка */
  stack: z.enum(['down', 'up']),
  /** Компактно: только заголовки карточек */
  compact: z.boolean().optional(),
  /** Каким запретным областям зона может перекрываться (разбор — в центре, пока игрок мёртв) */
  allowOver: z.array(z.string().max(40)).max(10).optional(),
});
export type HudZone = z.infer<typeof zoneSchema>;

export const layoutSchema = z.object({
  schema: z.literal('dota-coach.hud-layout'),
  version: z.literal(1),
  id: z.string().max(40),
  nameRu: z.string().max(80),
  note: z.string().max(2000).optional(),
  forbidden: z.array(areaSchema).max(40),
  zones: z.array(zoneSchema).length(HUD_ZONE_IDS.length),
});
export type HudLayout = z.infer<typeof layoutSchema>;

/** Пользовательские сдвиги зон (режим расстановки): только положение, размер — из раскладки */
export const zoneOverridesSchema = z.partialRecord(z.enum(HUD_ZONE_IDS), z.object({ x: unit, y: unit }).strict());
export type ZoneOverrides = z.infer<typeof zoneOverridesSchema>;

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Единица раскладки в пикселях */
export function hudUnit(width: number, height: number): number {
  return Math.min(height, (width * 9) / 16);
}

/** Прямоугольник области в пикселях экрана width×height */
export function areaRect(a: Pick<HudArea, 'ax' | 'ay' | 'x' | 'y' | 'w' | 'h'>, width: number, height: number): Rect {
  const u = hudUnit(width, height);
  const w = a.w * u;
  const h = a.h * u;
  const x = a.ax === 'left' ? a.x * u : a.ax === 'right' ? width - a.x * u - w : width / 2 + a.x * u - w / 2;
  const y = a.ay === 'top' ? a.y * u : a.ay === 'bottom' ? height - a.y * u - h : height / 2 + a.y * u - h / 2;
  return { x, y, w, h };
}

export function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

export function applyOverrides(layout: HudLayout, o: ZoneOverrides | null | undefined): HudLayout {
  if (!o) return layout;
  return { ...layout, zones: layout.zones.map((z) => (o[z.id] ? { ...z, ...o[z.id] } : z)) };
}

export interface ResolvedZone {
  zone: HudZone;
  rect: Rect;
  /** С какими запретными областями пересекается (пусто — всё хорошо) */
  conflicts: string[];
  /** Зона выходит за край экрана */
  offscreen: boolean;
}

/**
 * Зоны в пикселях и их конфликты с HUD игры. Масштаб подсказок (настройка) меняет размер карточек внутри зоны,
 * а не саму зону: зона — безопасная область, карточки в неё помещаются или уходят в очередь.
 */
export function resolveLayout(layout: HudLayout, width: number, height: number): { zones: ResolvedZone[]; forbidden: { area: HudArea; rect: Rect }[] } {
  const forbidden = layout.forbidden.map((area) => ({ area, rect: areaRect(area, width, height) }));
  const zones = layout.zones.map((zone) => {
    const rect = areaRect(zone, width, height);
    const conflicts = forbidden.filter((f) => !(zone.allowOver ?? []).includes(f.area.id) && intersects(rect, f.rect)).map((f) => f.area.id);
    const offscreen = rect.x < 0 || rect.y < 0 || rect.x + rect.w > width + 0.5 || rect.y + rect.h > height + 0.5;
    return { zone, rect, conflicts, offscreen };
  });
  return { zones, forbidden };
}

/** Сдвиг зоны в пикселях (перетаскивание) → смещение от якоря в u */
export function moveZone(zone: HudZone, dxPx: number, dyPx: number, width: number, height: number): { x: number; y: number } {
  const u = hudUnit(width, height);
  const sx = zone.ax === 'right' ? -1 : 1;
  const sy = zone.ay === 'bottom' ? -1 : 1;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return { x: r3(zone.x + (sx * dxPx) / u), y: r3(zone.y + (sy * dyPx) / u) };
}

/** Типичные экраны для проверки и предпросмотра */
export const SCREENS: { id: string; nameRu: string; width: number; height: number }[] = [
  { id: '16x9', nameRu: '16:9 (1920×1080)', width: 1920, height: 1080 },
  { id: '16x10', nameRu: '16:10 (1920×1200)', width: 1920, height: 1200 },
  { id: '21x9', nameRu: '21:9 (3440×1440)', width: 3440, height: 1440 },
  { id: '32x9', nameRu: '32:9 (5120×1440)', width: 5120, height: 1440 },
  { id: '4x3', nameRu: '4:3 (1440×1080)', width: 1440, height: 1080 },
  { id: '4k', nameRu: 'Телевизор 4K (3840×2160)', width: 3840, height: 2160 },
  { id: '1366', nameRu: 'Ноутбук 1366×768', width: 1366, height: 768 },
];
