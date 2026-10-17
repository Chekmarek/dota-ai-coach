// Геометрия HUD под пропорции экрана. Все положения в читателях заданы в пикселях кадра 1920×1080 (ref)
// и переводятся в кадр отсюда.
// 16:9 — «legacy»: те же формулы, что были всегда (x = ref·w/1920, y = ref·h/1080), результат совпадает до пикселя.
// Другие пропорции: HUD Доты масштабируется по высоте кадра (k = h/1080) и прижат к краям —
// панели слева остаются слева, справа — справа, нижняя панель — по центру внизу.
// Замеры в Hero Demo 2026-10-17 (полоса маны у Phoenix; на 16:9 — край 699, верхняя строка 1046):
// 1920×1200 → 670 и 1162 (k = 1,111), 1440×1080 → 459 и 1046 (k = 1), 1834×786 → 725 и 761 (k = 0,728) —
// совпадает с k = h/1080 до 1–3 px. Вариант «вписать в 16:9», k = min(h, w·9/16)/1080, на 16:10 и 4:3 промахивается
// на 30–60 px.
// Список пропорций — src/data/hud-layouts/aspects.json; всё, кроме 16:9, на настоящей игре не проверено.

export const REF_W = 1920;
export const REF_H = 1080;

export type AnchorX = 'left' | 'center' | 'right';
export type AnchorY = 'top' | 'bottom';

export interface AspectDef {
  id: string;
  /** Пропорция w:h и допуск (доля), как у layoutFits */
  ratio?: [number, number];
  tolerance?: number;
  /** Или диапазон w/h включительно */
  range?: [number, number];
  /** Проверено на настоящей игре; false — по умолчанию «не поддерживается» */
  verified: boolean;
}

/** 16:9 — то же условие, что layoutFits для dota2-default-16x9 (допуск 2 %) */
export const ASPECT_16_9: AspectDef = { id: '16:9', ratio: [16, 9], tolerance: 0.02, verified: true };

export interface HudGeometry {
  /** Найденная пропорция; null — неизвестная (формулы как у 16:9, но распознавание «не поддерживается») */
  aspect: AspectDef | null;
  /** Формулы 16:9 (растяжение по осям) */
  legacy: boolean;
  /** Масштаб длин по x и по y (для legacy — w/1920 и h/1080, иначе оба k) */
  s: number;
  sy: number;
  /** Координата кадра по x для ref-координаты с привязкой к краю (по умолчанию центр) */
  x(refX: number, ax?: AnchorX): number;
  /** Координата кадра по y; по умолчанию — к верху, если ref < 540, иначе к низу */
  y(refY: number, ay?: AnchorY): number;
  /** Обратно: ref-координата по x для координаты кадра */
  refX(px: number, ax?: AnchorX): number;
}

export function matchAspect(w: number, h: number, aspects: readonly AspectDef[]): AspectDef | null {
  if (!(w > 0 && h > 0)) return null;
  const r = w / h;
  for (const a of aspects) {
    if (a.ratio) {
      const ref = a.ratio[0] / a.ratio[1];
      if (Math.abs(r - ref) / ref <= (a.tolerance ?? 0)) return a;
    } else if (a.range && r >= a.range[0] && r <= a.range[1]) return a;
  }
  return null;
}

/** Прежние формулы: растяжение 1920×1080 на кадр по каждой оси */
export function legacyGeometry(w: number, h: number, aspect: AspectDef | null = ASPECT_16_9): HudGeometry {
  const s = w / REF_W, sy = h / REF_H;
  return {
    aspect,
    legacy: true,
    s,
    sy,
    x: (ref) => ref * s,
    y: (ref) => ref * sy,
    refX: (px) => px / s,
  };
}

/** Геометрия под кадр w×h. aspects — список из aspects.json (без него известна только 16:9) */
export function hudGeometry(w: number, h: number, aspects: readonly AspectDef[] = [ASPECT_16_9]): HudGeometry {
  const aspect = matchAspect(w, h, aspects);
  if (!aspect || aspect.id === ASPECT_16_9.id) return legacyGeometry(w, h, aspect);
  const k = h / REF_H;
  return {
    aspect,
    legacy: false,
    s: k,
    sy: k,
    x: (ref, ax = 'center') => (ax === 'left' ? ref * k : ax === 'right' ? w - (REF_W - ref) * k : w / 2 + (ref - REF_W / 2) * k),
    y: (ref, ay) => ((ay ?? (ref < REF_H / 2 ? 'top' : 'bottom')) === 'top' ? ref * k : h - (REF_H - ref) * k),
    refX: (px, ax = 'center') => (ax === 'left' ? px / k : ax === 'right' ? REF_W - (w - px) / k : REF_W / 2 + (px - w / 2) / k),
  };
}
