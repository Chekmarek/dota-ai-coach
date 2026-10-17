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
import { dayNightRect } from '@core/vision/day-night.ts';
import { legacyGeometry, type AspectDef, type HudGeometry } from '@core/vision/hud-geometry.ts';
import aspectsJson from '../data/hud-layouts/aspects.json';
import { readTopBar, type PortraitTemplates } from '@core/vision/top-bar.ts';
import portraitsJson from '../data/hero-portraits.json';
import { decodeMinimapBackground, minimapRect, readMinimap } from '@core/vision/minimap.ts';
import { MinimapCalibrator } from '@core/vision/minimap-calibration.ts';
import { MinimapTracker } from '@core/vision/minimap-track.ts';
import { readHealthBars } from '@core/vision/health-bars.ts';
import backgroundJson from '../data/minimap-background.json';

const layout = layoutJson as unknown as HudLayout;
const model = modelJson as unknown as GlyphModel;
const nameModel = nameModelJson as unknown as GlyphModel;
const cooldownModel = cooldownModelJson as unknown as GlyphModel;
const itemTemplates = itemTemplatesJson as unknown as ItemTemplates;
const heroNames = heroNamesJson.names as HeroNameEntry[];
const aspects = aspectsJson.aspects as AspectDef[];
const portraits = portraitsJson as unknown as PortraitTemplates;
const minimapBackground = decodeMinimapBackground(backgroundJson as unknown as Parameters<typeof decodeMinimapBackground>[0]);
/** Не чаще этого (мс) искать свой значок для самокалибровки мини-карты: это две большие копии углов кадра */
const CALIBRATION_EVERY_MS = 1000;

/** Свой герой из GSI (для самокалибровки мини-карты): ячейка — цвет значка, координаты — правда */
export interface OwnHero {
  slot: number;
  x: number;
  y: number;
}

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
  private readonly calibrator = layout.minimap ? new MinimapCalibrator(layout.minimap) : null;
  private lastCalibrationAt = -Infinity;
  /** Сопровождение значков мини-карты во времени: скачок на другой конец карты не принимается сразу (подмены) */
  private readonly minimapTracker = new MinimapTracker();
  private ctx = this.canvas.getContext('2d', { willReadFrequently: true })!;

  run(bitmap: ImageBitmap, observedAt: number, own: OwnHero | null = null): HudReading {
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
    const hud = recognizeHud(access, layout, model, observedAt, { heroName: { model: nameModel, names: heroNames }, cooldownModel, itemTemplates, aspects });
    // Верхняя панель (этап 1): герои обеих команд, смерть и таймер возрождения; время — в общем durationMs
    const t0 = performance.now();
    hud.topBar = readTopBar(access, layout, portraits, model);
    // Мини-карта (этап 2): самокалибровка по своему герою (если GSI прислал координаты), затем значки героев
    const now = performance.now();
    if (this.calibrator && own && now - this.lastCalibrationAt >= CALIBRATION_EVERY_MS) {
      this.lastCalibrationAt = now;
      this.calibrator.addSample(access, own.slot, own.x, own.y, Date.now());
    }
    const cal = this.calibrator?.state() ?? null;
    hud.minimap = this.minimapTracker.update(readMinimap(access, layout.minimap, cal?.calibration ?? null, { background: minimapBackground }), observedAt);
    if (cal) hud.minimap.calibration = cal.status;
    // Полоски здоровья героев (этап 3): 3D-вид между панелями — своя копия, в полосы HUD она не входит
    hud.healthBars = readHealthBars(access, layout, model);
    hud.durationMs += performance.now() - t0;
    return hud;
  }

  private bandsCache: { key: string; bands: Rect[] } | null = null;

  /**
   * Две полосы: объединение областей в верхней и в нижней половине кадра.
   * geo — геометрия HUD; по умолчанию растяжение 16:9 (другие пропорции движок не читает — «не поддерживается»).
   * Область вне полос всё равно читается — отдельной копией, так что неточная полоса стоит лишь скорости.
   */
  private bandsFor(w: number, h: number, geo: HudGeometry = legacyGeometry(w, h)): Rect[] {
    const key = `${w}x${h}${geo.legacy ? '' : ':' + geo.aspect?.id}`;
    if (this.bandsCache?.key === key) return this.bandsCache.bands;
    const s = w / layout.reference.w, sy = h / layout.reference.h;
    const rects = [
      ...Object.values(layout.regions).map((d) => scaleRect(layout, d, w, h, geo)),
      // имя героя и сдвигаемые от опоры элементы — тоже в нижнюю полосу, чтобы не делать лишних копий
      { x: Math.round(geo.x(NAME_BAND.x)), y: Math.round(geo.y(NAME_BAND.y)), w: Math.round(NAME_BAND.w * geo.s), h: Math.round(NAME_BAND.h * geo.sy) },
      // значок дня/ночи над часами — в верхнюю полосу (ячейки способностей и так внутри нижней)
      dayNightRect(geo),
      // верхняя панель с портретами — тоже в верхнюю полосу (иначе отдельная копия на каждый кадр); она и мини-карта — только 16:9
      ...(layout.topBar ? [topBarRect(layout.topBar, s, sy)] : []),
      // мини-карта по умолчанию — в нижнюю полосу (своя калибровка в другом месте даст отдельную копию)
      ...(layout.minimap ? [minimapRect(layout.minimap.default, layout.minimap.world, w, h)] : []),
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

/** Вся верхняя панель: от первого портрета Сил Света до последнего Сил Тьмы, сверху до низа таймера */
function topBarRect(tb: NonNullable<HudLayout['topBar']>, s: number, sy: number): Rect {
  const x0 = Math.round(tb.radiantX * s);
  return { x: x0, y: 0, w: Math.round((tb.direX + 4 * tb.step + tb.w) * s) - x0, h: Math.round((tb.timer[1] + tb.timer[3]) * sy) };
}

function contains(outer: Rect, r: Rect): boolean {
  return r.x >= outer.x && r.y >= outer.y && r.x + r.w <= outer.x + outer.w && r.y + r.h <= outer.y + outer.h;
}
