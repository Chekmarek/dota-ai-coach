import type { Rect } from '../../shared/types/observation.ts';
import type { ChannelMode } from './image.ts';

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

/** Подходит ли раскладка к кадру. Другое соотношение сторон — HUD расположен иначе, гадать не будем. */
export function layoutFits(layout: HudLayout, w: number, h: number): boolean {
  const ref = layout.reference.w / layout.reference.h;
  return w > 0 && h > 0 && Math.abs(w / h - ref) / ref <= layout.aspectTolerance;
}

/** Переводит область из эталонного разрешения в разрешение кадра */
export function scaleRect(layout: HudLayout, def: HudRegionDef, w: number, h: number): Rect {
  const sx = w / layout.reference.w, sy = h / layout.reference.h;
  const [x, y, rw, rh] = def.rect;
  return { x: Math.round(x * sx), y: Math.round(y * sy), w: Math.round(rw * sx), h: Math.round(rh * sy) };
}
