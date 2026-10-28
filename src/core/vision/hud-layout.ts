import type { Rect } from '../../shared/types/observation.ts';
import type { ChannelMode } from './image.ts';
import type { MinimapLayout } from './minimap.ts';
import type { HealthBarsLayout } from './health-bars.ts';
import type { AnchorX, AnchorY, HudGeometry } from './hud-geometry.ts';

export interface HudRegionDef {
  rect: [number, number, number, number];
  mode: ChannelMode;
  /** Запасные способы выделения текста (например, белые цифры на подсвеченной жёлтой панели золота) */
  altModes?: ChannelMode[];
  dropBorder?: boolean;
  circleMask?: boolean;
  firstRun?: boolean;
  /** Область привязана к опоре: x сдвигается на (найденная опора − эталонная) */
  anchor?: 'barLeft';
  /** К какому краю прижата область при пропорциях, отличных от 16:9 (src/core/vision/hud-geometry.ts); по умолчанию — центр */
  ax?: AnchorX;
  /** По умолчанию — к верху, если область в верхней половине, иначе к низу */
  ay?: AnchorY;
  label: string;
}

export interface HudLayout {
  id: string;
  schemaVersion: string;
  description?: string;
  reference: { w: number; h: number };
  aspectTolerance: number;
  /** Эталонные положения опор в координатах reference */
  anchors?: { barLeft?: number };
  regions: Record<string, HudRegionDef>;
  /** Верхняя панель с портретами героев (src/core/vision/top-bar.ts); нет — читатель честно «не поддерживается» */
  topBar?: TopBarLayout;
  /** Большие портреты на экране выбора героев (src/core/vision/draft-screen.ts) */
  draftBar?: DraftBarLayout;
  /** Мини-карта (src/core/vision/minimap.ts): калибровка по умолчанию, цвета значков игроков */
  minimap?: MinimapLayout;
  /** Полоски здоровья героев в 3D-виде (src/core/vision/health-bars.ts) */
  healthBars?: HealthBarsLayout;
}

/** Координаты в эталонном разрешении (reference) */
export interface TopBarLayout {
  /** Левый край первого портрета Сил Света и Сил Тьмы, шаг между портретами */
  radiantX: number;
  direX: number;
  step: number;
  /** Верх и размер портрета */
  y: number;
  w: number;
  h: number;
  /** Часть портрета для сравнения с шаблоном (x, y, w, h от левого верхнего угла портрета): без значков внизу */
  roi: [number, number, number, number];
  /** Таймер возрождения под портретом: x от левого края портрета, y от верха кадра, w, h */
  timer: [number, number, number, number];
}

/**
 * Экран выбора героев, координаты в эталонном разрешении: левый край области сравнения первого портрета Сил Света
 * и Сил Тьмы, шаг, верх и размер области (верхняя часть портрета без значков, как roi верхней панели).
 */
export interface DraftBarLayout {
  radiantX: number;
  direX: number;
  step: number;
  y: number;
  w: number;
  h: number;
}

/** Подходит ли раскладка к кадру. Другое соотношение сторон — HUD расположен иначе, гадать не будем. */
export function layoutFits(layout: HudLayout, w: number, h: number): boolean {
  const ref = layout.reference.w / layout.reference.h;
  return w > 0 && h > 0 && Math.abs(w / h - ref) / ref <= layout.aspectTolerance;
}

/**
 * Переводит область из эталонного разрешения в разрешение кадра.
 * geo — геометрия под пропорцию кадра; без неё или для 16:9 — прежнее растяжение по осям.
 */
export function scaleRect(layout: HudLayout, def: HudRegionDef, w: number, h: number, geo?: HudGeometry): Rect {
  if (geo && !geo.legacy) {
    const [x, y, rw, rh] = def.rect;
    return { x: Math.round(geo.x(x, def.ax)), y: Math.round(geo.y(y, def.ay)), w: Math.round(rw * geo.s), h: Math.round(rh * geo.sy) };
  }
  const sx = w / layout.reference.w, sy = h / layout.reference.h;
  const [x, y, rw, rh] = def.rect;
  return { x: Math.round(x * sx), y: Math.round(y * sy), w: Math.round(rw * sx), h: Math.round(rh * sy) };
}
