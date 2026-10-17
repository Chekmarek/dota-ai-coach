import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameAccessFromImage, type FrameAccess, type RgbaImage } from '../../src/core/vision/image.ts';
import { recognizeHud, type RecognizeOptions } from '../../src/core/vision/recognize-hud.ts';
import { scaleRect, type HudLayout } from '../../src/core/vision/hud-layout.ts';
import { hudGeometry, matchAspect, type AspectDef, type HudGeometry } from '../../src/core/vision/hud-geometry.ts';
import { heroNameRect } from '../../src/core/vision/hero-name.ts';
import { abilitySlotCount } from '../../src/core/vision/abilities.ts';
import type { Rect } from '../../src/shared/types/observation.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';
import { decodePng } from '../../scripts/png.mjs';

const ROOT = join(import.meta.dirname, '../..');
const json = <T>(p: string): T => JSON.parse(readFileSync(join(ROOT, p), 'utf8')) as T;
const layout = json<HudLayout>('src/data/hud-layouts/dota2-default-16x9.json');
const model = json<GlyphModel>('src/data/hud-layouts/glyphs-default.json');
const aspects = json<{ aspects: AspectDef[] }>('src/data/hud-layouts/aspects.json').aspects;
const fullOpts: RecognizeOptions = {
  heroName: { model: json('src/data/hud-layouts/glyphs-heroname.json'), names: json<{ names: never[] }>('src/data/hero-names.json').names },
  cooldownModel: json('src/data/hud-layouts/glyphs-cooldown.json'),
  itemTemplates: json('src/data/item-templates.json'),
  aspects,
};

/** Снимок, сделанный ДО появления hud-geometry: какие области читал прежний код на 16:9 */
interface LegacySnap {
  w: number;
  h: number;
  bar: number;
  barLeft: number;
  reads: Rect[];
  sources: Record<string, Rect>;
  heroNameRect: Rect;
  slots: number;
}
const legacy = json<LegacySnap[]>('tests/fixtures/geometry/legacy-16x9.json');

function black(w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  return { width: w, height: h, data };
}

function fill(img: RgbaImage, x0: number, x1: number, y0: number, y1: number, rgb: [number, number, number]): void {
  for (let y = Math.round(y0); y < Math.round(y1); y++)
    for (let x = Math.round(x0); x < Math.round(x1); x++) img.data.set(rgb, (y * img.width + x) * 4);
}

/** Полоса маны (и зелёная полоса здоровья) там, где их ждёт раскладка; barRef — левый край в 1920×1080 */
function drawBars(img: RgbaImage, geo: HudGeometry, barRef = 667): void {
  fill(img, geo.x(barRef), geo.x(1050), geo.y(1047), geo.y(1070), [66, 106, 206]);
  fill(img, geo.x(barRef), geo.x(1050), geo.y(1019), geo.y(1043), [40, 180, 40]);
}

function recording(img: RgbaImage): { fa: FrameAccess; reads: Rect[] } {
  const base = frameAccessFromImage(img);
  const reads: Rect[] = [];
  return { reads, fa: { width: img.width, height: img.height, read: (r) => (reads.push({ ...r }), base.read(r)) } };
}

describe('геометрия HUD: 16:9 совпадает с прежним кодом до пикселя', () => {
  it.each(legacy.map((s) => [`${s.w}×${s.h}, полоса от ${s.bar}`, s] as const))('%s', (_, snap) => {
    const geo = hudGeometry(snap.w, snap.h, aspects);
    expect(geo.legacy).toBe(true);
    expect(geo.aspect?.id).toBe('16:9');
    // Каждая область раскладки
    for (const def of Object.values(layout.regions)) expect(scaleRect(layout, def, snap.w, snap.h, geo)).toEqual(scaleRect(layout, def, snap.w, snap.h));
    // Все чтения всех читателей (якорь, поля, чья панель, день/ночь, имя, способности, точки, предметы)
    const img = black(snap.w, snap.h);
    const s = snap.w / 1920, sy = snap.h / 1080;
    fill(img, Math.round(snap.bar * s), Math.round(1050 * s), Math.round(1047 * sy), Math.round(1070 * sy), [66, 106, 206]);
    fill(img, Math.round(snap.bar * s), Math.round(1050 * s), Math.round(1019 * sy), Math.round(1043 * sy), [40, 180, 40]);
    const { fa, reads } = recording(img);
    const r = recognizeHud(fa, layout, model, 0, fullOpts);
    expect(r.supported).toBe(true);
    expect(r.aspect).toBe('16:9');
    expect(r.selectedUnit.sourceRegion.rect.x).toBe(snap.barLeft);
    expect(reads).toEqual(snap.reads);
    const sources = {
      ...Object.fromEntries(Object.entries(r.fields).map(([k, o]) => [k, o.sourceRegion.rect])),
      selectedUnit: r.selectedUnit.sourceRegion.rect,
      dayNight: r.dayNight.sourceRegion.rect,
      heroName: r.heroName.sourceRegion.rect,
    };
    expect(sources).toEqual(snap.sources);
    expect(heroNameRect(snap.w, snap.h, snap.barLeft, geo)).toEqual(snap.heroNameRect);
    expect(abilitySlotCount(snap.barLeft, snap.w, geo)).toBe(snap.slots);
  });
});

describe('определение пропорции', () => {
  const cases: [number, number, string | null][] = [
    [1920, 1080, '16:9'],
    [1366, 768, '16:9'],
    [1600, 900, '16:9'],
    [1920, 1200, '16:10'],
    [1680, 1050, '16:10'],
    [1440, 1080, '4:3'],
    [1024, 768, '4:3'],
    [2560, 1080, '21:9'],
    [3440, 1440, '21:9'],
    [3840, 1600, '21:9'],
    [1280, 1024, null], // 5:4
    [3840, 1080, null], // 32:9
    [1080, 1920, null], // портретная
    [0, 0, null],
  ];
  it.each(cases)('%i×%i → %s', (w, h, id) => {
    expect(matchAspect(w, h, aspects)?.id ?? null).toBe(id);
  });

  it('без списка пропорций известна только 16:9', () => {
    expect(hudGeometry(1920, 1080).aspect?.id).toBe('16:9');
    expect(hudGeometry(1920, 1200).aspect).toBeNull();
  });

  it('проверена на игре только 16:9', () => {
    expect(aspects.filter((a) => a.verified).map((a) => a.id)).toEqual(['16:9']);
  });

  it('неизвестная пропорция — «не поддерживается», даже с экспериментальными пропорциями', () => {
    for (const [w, h] of [[1280, 1024], [3840, 1080]] as const) {
      const img = black(w, h);
      drawBars(img, hudGeometry(w, h, [{ id: 'x', range: [0.1, 10], verified: false }]));
      const r = recognizeHud(frameAccessFromImage(img), layout, model, 0, { aspects, experimentalAspects: true });
      expect(r.supported).toBe(false);
      expect(r.aspect).toBeNull();
      expect(Object.values(r.fields).every((o) => o.validity === 'unsupported' && o.value === null)).toBe(true);
    }
  });

  it('непроверенная пропорция без опции — «не поддерживается», даже с полосой маны на месте', () => {
    const img = black(2560, 1080);
    drawBars(img, hudGeometry(2560, 1080, aspects));
    const r = recognizeHud(frameAccessFromImage(img), layout, model, 0, { aspects });
    expect(r.supported).toBe(false);
    expect(r.aspect).toBe('21:9');
    expect(r.abilities).toBeNull();
  });
});

describe('на всех пропорциях области не выходят за кадр', () => {
  const sizes: [number, number][] = [
    [1920, 1080], [1280, 720], [3840, 2160],
    [1920, 1200], [1680, 1050], [2560, 1600], [1280, 800],
    [1440, 1080], [1024, 768], [1600, 1200], [800, 600],
    [2560, 1080], [3440, 1440], [3840, 1600],
  ];
  it.each(sizes)('%i×%i', (w, h) => {
    const geo = hudGeometry(w, h, aspects);
    const inside = (r: Rect) => r.x >= 0 && r.y >= 0 && r.w > 0 && r.h > 0 && r.x + r.w <= w && r.y + r.h <= h;
    for (const def of Object.values(layout.regions)) expect(inside(scaleRect(layout, def, w, h, geo)), def.label).toBe(true);
    // Все ступеньки ширины нижней панели (4 ячейки… 8 ячеек)
    for (const bar of [638 - 29, 638, 667, 696, 725]) {
      const img = black(w, h);
      drawBars(img, geo, bar);
      const { fa, reads } = recording(img);
      const r = recognizeHud(fa, layout, model, 0, { ...fullOpts, experimentalAspects: true });
      expect(r.supported, `полоса от ${bar}`).toBe(true);
      expect(r.selectedUnit.value).toBe('ally');
      expect(reads.filter((x) => !inside(x))).toEqual([]);
    }
  });
});

describe('синтетика: верхняя полоса 1080p в кадрах других пропорций (k = 1)', () => {
  // Полоса x 540…1380, y 0…64 настоящего кадра 1920×1080
  const strip = decodePng(readFileSync(join(ROOT, 'tests/fixtures/topbar/all-alive.png'))) as RgbaImage;

  function frame(w: number, h: number, mana: boolean): RgbaImage {
    const img = black(w, h);
    const geo = hudGeometry(w, h, aspects);
    if (!geo.legacy) expect(geo.s).toBe(1);
    const x0 = Math.round(geo.x(540)), y0 = Math.round(geo.y(0));
    for (let y = 0; y < strip.height; y++) img.data.set(strip.data.subarray(y * strip.width * 4, (y + 1) * strip.width * 4), ((y0 + y) * w + x0) * 4);
    if (mana) drawBars(img, geo);
    return img;
  }
  const read = (img: RgbaImage, experimentalAspects = true) =>
    recognizeHud(frameAccessFromImage(img), layout, model, 0, { aspects, experimentalAspects });

  const base = read(frame(1920, 1080, false));
  it('на 16:9 время и счёт читаются', () => {
    expect(base.supported).toBe(true);
    for (const id of ['gameClock', 'scoreRadiant', 'scoreDire'] as const) expect(base.fields[id].validity, id).toBe('valid');
  });

  it.each([[2560, 1080], [1920, 1200]] as const)('%i×%i: время и счёт — как на 16:9', (w, h) => {
    const r = read(frame(w, h, true));
    expect(r.supported).toBe(true);
    for (const id of ['gameClock', 'scoreRadiant', 'scoreDire'] as const) {
      expect(r.fields[id].value, id).toEqual(base.fields[id].value);
      expect(r.fields[id].validity, id).toBe('valid');
    }
  });

  it.each([[2560, 1080], [1920, 1200]] as const)('%i×%i без полосы маны — «не поддерживается»', (w, h) => {
    const r = read(frame(w, h, false));
    expect(r.supported).toBe(false);
    for (const id of ['gameClock', 'scoreRadiant', 'scoreDire'] as const) {
      expect(r.fields[id].value, id).toBeNull();
      expect(r.fields[id].validity, id).toBe('unsupported');
    }
  });

  it.each([[2560, 1080], [1920, 1200]] as const)('%i×%i без опции experimentalAspects — «не поддерживается»', (w, h) => {
    expect(read(frame(w, h, true), false).supported).toBe(false);
  });
});
