import type { Rect } from '@shared/types/observation';
import { crop, type FrameAccess, type RgbaImage } from '@core/vision/image.ts';
import { recognizeHud, type HudReading } from '@core/vision/recognize-hud.ts';
import { scaleRect, type HudLayout } from '@core/vision/hud-layout.ts';
import type { GlyphModel } from '@core/ocr/glyph-ocr.ts';
import layoutJson from '../data/hud-layouts/dota2-default-16x9.json';
import modelJson from '../data/hud-layouts/glyphs-default.json';

import nameModelJson from '../data/hud-layouts/glyphs-heroname.json';
import cooldownModelJson from '../data/hud-layouts/glyphs-cooldown.json';
import itemTemplatesJson from '../data/item-templates.json';
import type { ItemTemplates } from '@core/vision/items.ts';
import heroNamesJson from '../data/hero-names.json';
import type { HeroNameEntry } from '@core/vision/hero-name.ts';
import { DAY_NIGHT_RECT } from '@core/vision/day-night.ts';

const layout = layoutJson as unknown as HudLayout;
const model = modelJson as unknown as GlyphModel;
const nameModel = nameModelJson as unknown as GlyphModel;
const cooldownModel = cooldownModelJson as unknown as GlyphModel;
const itemTemplates = itemTemplatesJson as unknown as ItemTemplates;
const heroNames = heroNamesJson.names as HeroNameEntry[];

/** Полоса с именем героя над портретом: её положение зависит от ширины панели, берём с запасом (при 1920×1080) */
const NAME_BAND = { x: 340, y: 912, w: 480, h: 26 };

interface Band {
  rect: Rect;
  image: RgbaImage;
}

/**
 * Распознавание на стороне движка.
 * Копирование пикселей из видеопамяти дорого прежде всего синхронизацией, а не объёмом,
 * поэтому за кадр делается всего две копии — полосы верхней и нижней панели HUD
 * (вместо всего кадра в 8 МБ или семи отдельных мелких копий). Мелкие области вырезаются уже из памяти.
 */
export class VisionStage {
  private canvas = new OffscreenCanvas(64, 32);
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  run(bitmap: ImageBitmap, observedAt: number): HudReading {
    const { width, height } = bitmap;
    const bands = this.bandsFor(width, height).map((rect) => ({ rect, image: this.copy(bitmap, rect) }));
    const access: FrameAccess = {
      width,
      height,
      read: (r: Rect) => {
        const band = bands.find((b) => contains(b.rect, r));
        if (band) return crop(band.image, { x: r.x - band.rect.x, y: r.y - band.rect.y, w: r.w, h: r.h });
        return this.copy(bitmap, r); // область вне полос — отдельная копия
      },
    };
    return recognizeHud(access, layout, model, observedAt, { heroName: { model: nameModel, names: heroNames }, cooldownModel, itemTemplates });
  }

  private bandsCache: { key: string; bands: Rect[] } | null = null;

  /** Две полосы: объединение областей в верхней и в нижней половине кадра */
  private bandsFor(w: number, h: number): Rect[] {
    const key = `${w}x${h}`;
    if (this.bandsCache?.key === key) return this.bandsCache.bands;
    const s = w / layout.reference.w, sy = h / layout.reference.h;
    const rects = [
      ...Object.values(layout.regions).map((d) => scaleRect(layout, d, w, h)),
      // имя героя и сдвигаемые от опоры элементы — тоже в нижнюю полосу, чтобы не делать лишних копий
      { x: Math.round(NAME_BAND.x * s), y: Math.round(NAME_BAND.y * sy), w: Math.round(NAME_BAND.w * s), h: Math.round(NAME_BAND.h * sy) },
      // значок дня/ночи над часами — в верхнюю полосу (ячейки способностей и так внутри нижней)
      { x: Math.round(DAY_NIGHT_RECT.x * s), y: Math.round(DAY_NIGHT_RECT.y * sy), w: Math.round(DAY_NIGHT_RECT.w * s), h: Math.round(DAY_NIGHT_RECT.h * sy) },
    ];
    const bands = [rects.filter((r) => r.y < h / 2), rects.filter((r) => r.y >= h / 2)]
      .filter((g) => g.length)
      .map((g) => {
        const x0 = Math.max(0, Math.min(...g.map((r) => r.x)));
        const y0 = Math.max(0, Math.min(...g.map((r) => r.y)));
        const x1 = Math.min(w, Math.max(...g.map((r) => r.x + r.w)));
        const y1 = Math.min(h, Math.max(...g.map((r) => r.y + r.h)));
        return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      });
    this.bandsCache = { key, bands };
    return bands;
  }

  private copy(bitmap: ImageBitmap, r: Rect): RgbaImage {
    const w = Math.max(1, Math.min(r.w, bitmap.width - r.x));
    const h = Math.max(1, Math.min(r.h, bitmap.height - r.y));
    if (this.canvas.width < w || this.canvas.height < h) {
      this.canvas.width = Math.max(this.canvas.width, w);
      this.canvas.height = Math.max(this.canvas.height, h);
    }
    this.ctx.clearRect(0, 0, w, h);
    this.ctx.drawImage(bitmap, r.x, r.y, w, h, 0, 0, w, h);
    const d = this.ctx.getImageData(0, 0, w, h);
    return { width: d.width, height: d.height, data: d.data };
  }
}

function contains(outer: Rect, r: Rect): boolean {
  return r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
}
