import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../scripts/png.mjs';
import { crop, type FrameAccess, type RgbaImage } from '../../src/core/vision/image.ts';
import { barTeam, levelSquare, readHealthBars } from '../../src/core/vision/health-bars.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';

const ROOT = join(import.meta.dirname, '../..');
const layout: HudLayout = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const model: GlyphModel = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/glyphs-default.json'), 'utf8'));

/** Чёрный кадр 1920×1080 со вставленной на своё место вырезкой (tests/fixtures/healthbars/README.md) */
function frameWith(file: string, x: number, y: number): FrameAccess {
  const s = decodePng(readFileSync(join(ROOT, 'tests/fixtures/healthbars', file)));
  const full: RgbaImage = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4) };
  for (let j = 0; j < s.height; j++) full.data.set(s.data.subarray(j * s.width * 4, (j + 1) * s.width * 4), ((y + j) * 1920 + x) * 4);
  return { width: 1920, height: 1080, read: (r) => crop(full, r) };
}

describe('полоски здоровья героев', () => {
  it('три полоски друг над другом: две красные 15-го уровня и зелёная 12-го (GSI: 100 %, 100 %, 95 %)', () => {
    const r = readHealthBars(frameWith('bars-stack.png', 500, 70), layout, model);
    expect(r.supported).toBe(true);
    expect(r.bars.map((b) => [b.color, b.level])).toEqual([
      ['red', 15],
      ['red', 15],
      ['green', 12],
    ]);
    // Правда — GSI того же кадра; GSI отстаёт от экрана до ~0,3 с, в драке отсюда расхождение
    for (const [b, hp] of r.bars.map((b, k) => [b, [100, 100, 95][k]!] as const)) expect(Math.abs(b.hpPercent - hp)).toBeLessThanOrEqual(10);
  });

  it('линия: красная и зелёная полоски 2-го уровня, своя (зелёная) читается с уровнем', () => {
    const r = readHealthBars(frameWith('bars-lane.png', 820, 370), layout, model);
    expect(r.bars.map((b) => b.color)).toEqual(['red', 'green']);
    expect(r.bars[1]!.level).toBe(2);
    for (const b of r.bars) expect(b.hpPercent).toBeGreaterThan(40);
  });

  it('почти пустая полоска с белым куском недавнего урона — низкое здоровье, а не пропуск (GSI: 2 %)', () => {
    const r = readHealthBars(frameWith('bar-lowhp.png', 490, 775), layout, model);
    expect(r.bars).toHaveLength(1);
    expect(r.bars[0]).toMatchObject({ color: 'red' });
    expect(r.bars[0]!.hpPercent).toBeLessThanOrEqual(10);
  });

  it('камера отдалена: полоски короче (~80 px), всё равно находятся (GSI: 79 % и 91 %)', () => {
    const r = readHealthBars(frameWith('bars-zoomed-out.png', 760, 505), layout, model);
    expect(r.bars).toHaveLength(2);
    for (const b of r.bars) {
      expect(b.color).toBe('green');
      expect(b.length).toBeLessThan(90);
    }
    expect(Math.abs(r.bars[0]!.hpPercent - 79)).toBeLessThanOrEqual(5);
    expect(Math.abs(r.bars[1]!.hpPercent - 91)).toBeLessThanOrEqual(5);
  });

  it('однозначный уровень: квадрат уже окна, справа светлый фон — уровень всё равно читается (GSI: 1; STRATZ: 7)', () => {
    // В 0.14.1 в окно цифр попадала земля справа от квадрата («символ у края») — уровень отбрасывался
    const own = readHealthBars(frameWith('level-narrow-green.png', 940, 372), layout, model);
    expect(own.bars.map((b) => [b.color, b.level])).toEqual([['green', 1]]);
    const enemy = readHealthBars(frameWith('level-narrow-red.png', 770, 596), layout, model);
    expect(enemy.bars.map((b) => [b.color, b.level])).toEqual([['red', 7]]);
    expect(Math.abs(enemy.bars[0]!.hpPercent - 51)).toBeLessThanOrEqual(5);
  });

  it('квадрат уровня: окно сужается до квадрата и никогда не расширяется', () => {
    // Синтетика: тёмно-зелёный квадрат 14×22 в окне 29×22, справа светлая земля
    const img: RgbaImage = { width: 29, height: 22, data: new Uint8ClampedArray(29 * 22 * 4) };
    for (let y = 0; y < 22; y++)
      for (let x = 0; x < 29; x++) img.data.set(x < 14 ? [50, 110, 50, 255] : [150, 160, 120, 255], (y * 29 + x) * 4);
    const box = { x: 0, y: 0, w: 29, h: 22 };
    expect(levelSquare(img, box, 1)).toEqual({ x: 0, y: 0, w: 14, h: 22 });
    // Квадрат не узнан (цвет другой команды) — окно как есть
    expect(levelSquare(img, box, 2)).toEqual(box);
    // Квадрат во всё окно — окно как есть
    const full: RgbaImage = { width: 29, height: 22, data: new Uint8ClampedArray(29 * 22 * 4).map((_, i) => [90, 45, 45, 255][i % 4]!) };
    expect(levelSquare(full, box, 2)).toEqual(box);
  });

  it('пустой кадр — полосок нет; не 16:9 или нет раскладки — «не поддерживается»', () => {
    const black: FrameAccess = { width: 1920, height: 1080, read: (r) => ({ width: r.w, height: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) }) };
    expect(readHealthBars(black, layout, model)).toMatchObject({ supported: true, bars: [] });
    expect(readHealthBars({ ...black, width: 1280, height: 1024 }, layout, model)).toMatchObject({ supported: false, bars: [] });
    expect(readHealthBars(black, { ...layout, healthBars: undefined }, model)).toMatchObject({ supported: false });
  });

  it('команда по цвету: у игрока зелёные — свои, у наблюдателя зелёные — Силы Света', () => {
    expect(barTeam('green', null)).toBe('radiant');
    expect(barTeam('red', null)).toBe('dire');
    expect(barTeam('green', 'dire')).toBe('dire');
    expect(barTeam('red', 'dire')).toBe('radiant');
  });
});
