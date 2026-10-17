import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { frameAccessFromImage, type RgbaImage } from '../../src/core/vision/image.ts';
import { segment, type Glyph } from '../../src/core/vision/segment.ts';
import { nameCost, nameWordVariants } from '../../src/core/vision/hero-name.ts';
import { EXTRA_EDGES, findBarAnchor, isGridEdge } from '../../src/core/vision/hud-anchors.ts';
import { legacyGeometry } from '../../src/core/vision/hud-geometry.ts';
import { recognizeHud } from '../../src/core/vision/recognize-hud.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';

const ROOT = join(import.meta.dirname, '../..');
const layout: HudLayout = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const model: GlyphModel = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/glyphs-default.json'), 'utf8'));

function black(w: number, h: number): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data[i * 4 + 3] = 255;
  return { width: w, height: h, data };
}

function fill(img: RgbaImage, x0: number, x1: number, y0: number, y1: number, rgb: [number, number, number]): void {
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) img.data.set(rgb, (y * img.width + x) * 4);
}

/** Кадр 1920×1080 с полосой маны (и зелёной полосой здоровья) от barLeft */
function withBars(barLeft: number): RgbaImage {
  const img = black(1920, 1080);
  fill(img, barLeft, 1050, 1047, 1070, [66, 106, 206]);
  fill(img, barLeft, 1050, 1019, 1043, [40, 180, 40]);
  return img;
}

describe('имя героя с дефисом и апострофом', () => {
  it('варианты разбиения на слова', () => {
    expect(nameWordVariants('Anti-Mage')).toEqual([['ANTIMAGE'], ['ANTI', 'MAGE']]);
    expect(nameWordVariants("Nature's Prophet")).toEqual([['NATURES', 'PROPHET'], ['NATURE', 'S', 'PROPHET']]);
    // Имена без знаков — как раньше, один вариант
    expect(nameWordVariants('Queen of Pain')).toEqual([['QUEEN', 'OF', 'PAIN']]);
    expect(nameWordVariants('Kez')).toEqual([['KEZ']]);
  });

  // Буквы без образцов стоят нейтрально — здесь проверяется только форма: число слов и букв
  const glyph = { box: { x: 0, y: 0, w: 5, h: 10 }, vec: new Float32Array(140), aspect: 0.5, relH: 1, relTop: 0 } as Glyph;
  const words = (...lens: number[]) => lens.map((n) => Array.from({ length: n }, () => glyph));
  const empty: GlyphModel = { ...model, samples: [] };

  it('Anti-Mage: и «ANTI MAGE» (4+4), и «ANTIMAGE» (8) совпадают по форме; 9 букв — нет', () => {
    expect(nameCost(words(4, 4), 'Anti-Mage', empty)).not.toBeNull();
    expect(nameCost(words(8), 'Anti-Mage', empty)).not.toBeNull();
    expect(nameCost(words(9), 'Anti-Mage', empty)).toBeNull();
  });

  it("Nature's Prophet: 6+1+7 и 7+7 совпадают по форме; 8+7 — нет", () => {
    expect(nameCost(words(6, 1, 7), "Nature's Prophet", empty)).not.toBeNull();
    expect(nameCost(words(7, 7), "Nature's Prophet", empty)).not.toBeNull();
    expect(nameCost(words(8, 7), "Nature's Prophet", empty)).toBeNull();
  });
});

describe('опора: край панели у героев с четырьмя способностями', () => {
  it('край 712 принимается, но не считается ступенькой сетки', () => {
    expect(EXTRA_EDGES).toContain(712);
    const r = findBarAnchor(frameAccessFromImage(withBars(712)));
    expect(r.barLeft).toBe(712);
    const geo = legacyGeometry(1920, 1080);
    expect(isGridEdge(712, geo)).toBe(false);
    expect(isGridEdge(667, geo)).toBe(true);
    expect(isGridEdge(696, geo)).toBe(true);
  });

  it('края 667 и 696 — как раньше; край между ступеньками (704) не принимается', () => {
    expect(findBarAnchor(frameAccessFromImage(withBars(667))).barLeft).toBe(667);
    expect(findBarAnchor(frameAccessFromImage(withBars(696))).barLeft).toBe(696);
    expect(findBarAnchor(frameAccessFromImage(withBars(704))).barLeft).toBeNull();
  });

  it('на краю 712 способности не читаются (ячейки другого размера), а панель и уровень — да', () => {
    const r = recognizeHud(frameAccessFromImage(withBars(712)), layout, model, 0);
    expect(r.selectedUnit.value).toBe('ally');
    expect(r.abilities).toBeNull();
    // Кружок уровня сдвинут вместе с краем панели: 458 + (712 − 667)
    expect(r.fields.level.sourceRegion.rect.x).toBe(503);
    expect(recognizeHud(frameAccessFromImage(withBars(667)), layout, model, 0).abilities).not.toBeNull();
  });
});

describe('сегментация с постоянным порогом', () => {
  // Белые «буквы» на голубой воде и на тёмной земле: Оцу по белизне отделяет тёмное от светлого,
  // и вода сливается с буквами; постоянный порог 200 оставляет только буквы
  const img = black(80, 20);
  fill(img, 0, 40, 0, 20, [185, 235, 245]);
  fill(img, 40, 80, 0, 20, [35, 35, 30]);
  for (const x0 of [6, 18, 30, 46, 58]) fill(img, x0, x0 + 6, 4, 16, [250, 250, 250]);

  it('порог 200 находит все пять букв', () => {
    const s = segment(img, { mode: 'white', threshold: 200, splitWide: false, dropBorder: true });
    expect(s.hasText).toBe(true);
    expect(s.glyphs.map((g) => g.box.x)).toEqual([6, 18, 30, 46, 58]);
  });

  it('без постоянного порога (Оцу) буквы на воде не отделяются', () => {
    const s = segment(img, { mode: 'white', splitWide: false, dropBorder: true });
    expect(s.glyphs.length).not.toBe(5);
  });

  it('выше порога ничего нет — «текста нет»', () => {
    expect(segment(black(40, 20), { mode: 'white', threshold: 200 }).hasText).toBe(false);
  });
});
