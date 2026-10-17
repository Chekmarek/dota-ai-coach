// Инвентарь на нижней панели: 6 основных ячеек и 3 ячейки рюкзака. Предмет узнаётся сравнением ячейки
// с шаблонами иконок (src/data/item-templates.json). Панель показывает ВЫБРАННОГО юнита — см. selectedUnit.
import type { FrameAccess } from './image.ts';
import { gridColors, gridDistance, normalizeGrid } from './item-grid.ts';
import { legacyGeometry, type HudGeometry } from './hud-geometry.ts';

export interface ItemTemplates {
  patch: string;
  /** aliases — предметы с той же иконкой (по картинке не различить) */
  items: { key: string; name: string; aliases?: string[]; t: number[] }[];
}

export interface ItemSlot {
  /** 'inv1'…'inv6' — основные ячейки слева направо, сверху вниз; 'bp1'…'bp3' — рюкзак */
  slot: string;
  /** null — ячейка пустая или предмет не узнан (см. empty) */
  item: { key: string; name: string; aliases?: string[] } | null;
  empty: boolean;
  /** Расстояние до лучшего шаблона и до второго — для диагностики */
  distance: number | null;
  confidence: number;
}

/**
 * Геометрия (1920×1080, замеры 2026-10-12): основные ячейки 60×44, левая верхняя — (1186, 943), шаг 66 × 48;
 * рюкзак — та же сетка по x, y = 1040, высота 31. Инвентарь сдвигается вместе с шириной панели:
 * x = 1186 − (barLeft − 667) (у Morphling, barLeft 696, — на 30 px левее).
 */
const BASE_BAR_LEFT = 667;
const X0 = 1186, Y0 = 943, DX = 66, DY = 48, W = 60, H = 44;
const BP_Y = 1040, BP_H = 31;

/** Пороги по игре 4 и старым записям: пустая ячейка — почти однородная тёмная (разброс ≤ 7); верный предмет —
 *  расстояние ≤ 0.16, неверные — обычно ≥ 0.25. Близкое совпадение принимаем с отрывом ≥ 0.1 (Aegis: 0.107 против 0.253),
 *  дальнее — только с большим отрывом. */
const EMPTY_MAX_SPREAD = 12;
const EMPTY_MAX_BRIGHTNESS = 40;
const CLOSE_DIST = 0.2;
const CLOSE_GAP = 0.1;
const MAX_DIST = 0.35;
const MIN_GAP = 0.2;

export function readItems(
  frame: FrameAccess,
  barLeft: number,
  templates: ItemTemplates,
  geo: HudGeometry = legacyGeometry(frame.width, frame.height),
): ItemSlot[] {
  const s = geo.s, sy = geo.sy;
  const shift = barLeft - Math.round(geo.x(BASE_BAR_LEFT));
  const cells: { slot: string; x: number; y: number; w: number; h: number }[] = [];
  for (let r = 0; r < 2; r++)
    for (let c = 0; c < 3; c++) cells.push({ slot: `inv${r * 3 + c + 1}`, x: X0 + DX * c, y: Y0 + DY * r, w: W, h: H });
  for (let c = 0; c < 3; c++) cells.push({ slot: `bp${c + 1}`, x: X0 + DX * c, y: BP_Y, w: W, h: BP_H });

  return cells.map((cell) => {
    const rect = { x: Math.round(geo.x(cell.x)) - shift, y: Math.round(geo.y(cell.y)), w: Math.round(cell.w * s), h: Math.round(cell.h * sy) };
    const raw = gridColors(frame.read(rect));
    let mean = 0;
    for (let i = 0; i < raw.length; i++) mean += raw[i]!;
    mean /= raw.length;
    let spread = 0;
    for (let i = 0; i < raw.length; i++) spread += (raw[i]! - mean) ** 2;
    spread = Math.sqrt(spread / raw.length);
    if (spread <= EMPTY_MAX_SPREAD && mean <= EMPTY_MAX_BRIGHTNESS) {
      return { slot: cell.slot, item: null, empty: true, distance: null, confidence: Math.min(1, (EMPTY_MAX_SPREAD - spread) / EMPTY_MAX_SPREAD + 0.5) };
    }
    const v = normalizeGrid(raw);
    let best = Infinity, second = Infinity, bestIdx = -1;
    templates.items.forEach((t, i) => {
      const d = gridDistance(v, t.t);
      if (d < best) {
        second = best;
        best = d;
        bestIdx = i;
      } else if (d < second) second = d;
    });
    const gap = second - best;
    const accepted = (best <= CLOSE_DIST && gap >= CLOSE_GAP) || (best <= MAX_DIST && gap >= MIN_GAP);
    const t = templates.items[bestIdx]!;
    return {
      slot: cell.slot,
      item: accepted ? { key: t.key, name: t.name, ...(t.aliases ? { aliases: t.aliases } : {}) } : null,
      empty: false,
      distance: Math.round(best * 1000) / 1000,
      confidence: accepted ? Math.min(1, (second - best) / 0.4) : 0,
    };
  });
}
