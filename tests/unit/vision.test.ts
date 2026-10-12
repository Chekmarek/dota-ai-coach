import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { otsu, frameAccessFromImage, type RgbaImage } from '../../src/core/vision/image.ts';
import { components, segment } from '../../src/core/vision/segment.ts';
import { PARSERS, formatClock } from '../../src/core/vision/hud-fields.ts';
import { isPreHorn } from '../../src/core/vision/day-night.ts';
import { recognizeHud } from '../../src/core/vision/recognize-hud.ts';
import { layoutFits, scaleRect, type HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';
import { decodePng } from '../../scripts/png.mjs';

const ROOT = join(import.meta.dirname, '../..');
const layout: HudLayout = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const model: GlyphModel = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/glyphs-default.json'), 'utf8'));

function solid(w: number, h: number, rgb: [number, number, number]): RgbaImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([...rgb, 255], i * 4);
  return { width: w, height: h, data };
}

describe('разбор значений HUD', () => {
  it('время: с двоеточием и без (бледное двоеточие)', () => {
    expect(PARSERS.gameClock('44:19')).toEqual({ ok: true, value: 2659 });
    expect(PARSERS.gameClock('4426')).toEqual({ ok: true, value: 2666 });
    expect(PARSERS.gameClock('44:75')).toEqual({ ok: false, reason: 'out-of-range' });
    expect(PARSERS.gameClock('4:4:1')).toEqual({ ok: false, reason: 'unparsed' });
  });

  it('отсчёт до горна: луна и время ≤ 1:30; вывод с минусом', () => {
    expect(isPreHorn(79, 'night')).toBe(true);
    expect(isPreHorn(79, 'day')).toBe(false);
    expect(isPreHorn(305, 'night')).toBe(false);
    expect(isPreHorn(79, null)).toBe(false);
    expect(formatClock(-79)).toBe('-1:19');
    expect(formatClock(-9)).toBe('-0:09');
    expect(formatClock(2659)).toBe('44:19');
  });

  it('здоровье: текущее не больше максимума', () => {
    expect(PARSERS.health('1579/3222')).toEqual({ ok: true, value: { current: 1579, max: 3222 } });
    expect(PARSERS.health('0/3288')).toEqual({ ok: true, value: { current: 0, max: 3288 } });
    expect(PARSERS.health('5000/3222')).toEqual({ ok: false, reason: 'out-of-range' });
    expect(PARSERS.health('1579//3222')).toEqual({ ok: false, reason: 'unparsed' });
  });

  it('уровень 1..30, золото неотрицательное', () => {
    expect(PARSERS.level('27')).toEqual({ ok: true, value: 27 });
    expect(PARSERS.level('31')).toEqual({ ok: false, reason: 'out-of-range' });
    expect(PARSERS.gold('2523')).toEqual({ ok: true, value: 2523 });
  });
});

describe('обработка изображения', () => {
  it('Оцу разделяет два уровня яркости', () => {
    const v = new Float32Array([10, 12, 11, 200, 210, 205]);
    const r = otsu(v);
    expect(r.threshold).toBeGreaterThanOrEqual(12);
    expect(r.threshold).toBeLessThan(200);
    expect(r.separation).toBeGreaterThan(150);
  });

  it('связные области с 8-связностью', () => {
    // две диагональные точки — одна область, отдельная точка — другая
    const mask = new Uint8Array([1, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1]);
    const b = components(mask, 4, 3);
    expect(b).toHaveLength(2);
  });

  it('однотонная область — «текста нет», а не выдуманные символы', () => {
    const s = segment(solid(60, 20, [40, 40, 40]), { mode: 'luma' });
    expect(s.hasText).toBe(false);
  });
});

describe('recognizeHud', () => {
  it('кадр без HUD → все поля absent/null', () => {
    const r = recognizeHud(frameAccessFromImage(solid(1920, 1080, [30, 30, 30])), layout, model, 123);
    for (const o of Object.values(r.fields)) {
      expect(o.value).toBeNull();
      expect(o.validity).toBe('absent');
      expect(o.observedAt).toBe(123);
    }
  });

  it('другое соотношение сторон (4:3) → unsupported, без попыток угадать', () => {
    expect(layoutFits(layout, 1440, 1080)).toBe(false);
    const r = recognizeHud(frameAccessFromImage(solid(1440, 1080, [30, 30, 30])), layout, model, 0);
    expect(r.supported).toBe(false);
    expect(Object.values(r.fields).every((o) => o.validity === 'unsupported' && o.value === null)).toBe(true);
  });

  const SF_SHOP = join(ROOT, 'tests/fixtures/hud/s1-shadowfiend-shop.png');
  // Кадр с никами игроков в общий репозиторий не входит — без него тест пропускается
  it.skipIf(!existsSync(SF_SHOP))('обрезанная краем области цифра → значение отбрасывается, а не читается частично («14» ≠ «1»)', () => {
    const img = decodePng(readFileSync(SF_SHOP));
    // Нарочно узкая область: «4» упирается в правый край
    const narrow: HudLayout = { ...layout, regions: { ...layout.regions, level: { rect: [458, 1038, 27, 36], mode: 'luma', label: 'Уровень' } } };
    const r = recognizeHud(frameAccessFromImage(img), narrow, model, 0);
    expect(r.fields.level.value).toBeNull();
    // А в настоящей раскладке уровень читается целиком
    expect(recognizeHud(frameAccessFromImage(img), layout, model, 0).fields.level.value).toBe(14);
  });

  it('области масштабируются под 2560×1440 и 1280×720', () => {
    const def = layout.regions.gold!;
    expect(scaleRect(layout, def, 2560, 1440)).toEqual({ x: 2184, y: 1383, w: 84, h: 33 });
    expect(scaleRect(layout, def, 1280, 720)).toEqual({ x: 1092, y: 691, w: 42, h: 17 });
  });
});
