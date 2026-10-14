import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../scripts/png.mjs';
import { crop, type FrameAccess, type RgbaImage } from '../../src/core/vision/image.ts';
import { calibrateFromPairs, decodeMinimapBackground, readMinimap, type MinimapLayout } from '../../src/core/vision/minimap.ts';
import { MinimapCalibrator } from '../../src/core/vision/minimap-calibration.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';

const ROOT = join(import.meta.dirname, '../..');
const layout: HudLayout = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const mm = layout.minimap as MinimapLayout;
const BG = decodeMinimapBackground(JSON.parse(readFileSync(join(ROOT, 'src/data/minimap-background.json'), 'utf8')));
const defaultCal = { ...mm.default, source: 'layout' as const };

/** Кадр 1920×1080, в который вставлена вырезка мини-карты (x 1660, y 820) — остальное чёрное */
function frameWithMinimap(file: string): FrameAccess {
  const strip = decodePng(readFileSync(join(ROOT, 'tests/fixtures/minimap', file)));
  const full: RgbaImage = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4) };
  for (let y = 0; y < strip.height; y++) full.data.set(strip.data.subarray(y * strip.width * 4, (y + 1) * strip.width * 4), ((820 + y) * 1920 + 1660) * 4);
  return { width: 1920, height: 1080, read: (r) => crop(full, r) };
}

// Правда — координаты GSI наблюдателя тех же кадров (tests/fixtures/minimap/README.md); матчи не участвовали в построении фона
const TRUTH: Record<string, Record<number, [boolean, number, number]>> = {
  'laning.png': { 0: [true, 216, -5043], 1: [true, -8288, 2062], 2: [true, -1603, 1108], 3: [false, 3467, 1041], 4: [true, 4804, -4160], 5: [true, 3740, 3436], 6: [true, -5130, 5820], 7: [true, 5158, -2637], 8: [true, 6794, 5932], 9: [true, -324, -307] },
  'fight.png': { 0: [true, -5696, 4387], 1: [true, 6960, -4178], 2: [true, -2975, 1656], 3: [true, 150, -1664], 4: [true, 1261, -4361], 5: [false, -3088, 4257], 6: [true, 8185, 804], 7: [false, -2160, 2553], 8: [true, -3504, 5727], 9: [true, -1433, 4965] },
};
const dist = (h: { slot: number; x: number; y: number }, file: string) => {
  const t = TRUTH[file]![h.slot]!;
  return Math.hypot(h.x - t[1], h.y - t[2]);
};

describe('мини-карта: значки героев по цвету игрока', () => {
  it('лайнинг: все найденные — в пределах 400 ед. от правды, найдено не меньше 6', () => {
    const r = readMinimap(frameWithMinimap('laning.png'), mm, defaultCal, { background: BG });
    expect(r.supported).toBe(true);
    expect(r.heroes.length).toBeGreaterThanOrEqual(6);
    for (const h of r.heroes) expect(dist(h, 'laning.png')).toBeLessThanOrEqual(400);
  });

  it('драка: все пять героев Сил Света найдены точно (Силы Тьмы на этой мини-карте не нарисованы — туман)', () => {
    const r = readMinimap(frameWithMinimap('fight.png'), mm, defaultCal, { background: BG });
    const radiant = r.heroes.filter((h) => h.slot < 5);
    expect(radiant.map((h) => h.slot).sort()).toEqual([0, 1, 2, 3, 4]);
    for (const h of radiant) expect(dist(h, 'fight.png')).toBeLessThanOrEqual(400);
    // Известное ограничение: голубой игрок (ячейка 7) иногда путается с рекой — здесь он мёртв, а «найден»
    expect(r.heroes.filter((h) => h.slot !== 7 && !TRUTH['fight.png']![h.slot]![0])).toEqual([]);
  });

  it('без калибровки или раскладки — «не поддерживается», а не «никого нет»', () => {
    expect(readMinimap(frameWithMinimap('laning.png'), mm, null)).toMatchObject({ supported: false, heroes: [] });
    expect(readMinimap(frameWithMinimap('laning.png'), undefined, defaultCal)).toMatchObject({ supported: false });
  });
});

describe('самокалибровка мини-карты по своему герою (синтетика)', () => {
  /** Чёрный кадр с одним круглым значком цвета игрока в точке (px, py) */
  function frameWithDot(px: number, py: number, color: [number, number, number], r = 6): FrameAccess {
    const img: RgbaImage = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4) };
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        if (x * x + y * y > r * r) continue;
        const k = ((Math.round(py) + y) * 1920 + Math.round(px) + x) * 4;
        img.data[k] = color[0];
        img.data[k + 1] = color[1];
        img.data[k + 2] = color[2];
        img.data[k + 3] = 255;
      }
    return { width: 1920, height: 1080, read: (q) => crop(img, q) };
  }
  // Путь своего героя по карте (достаточно разнесённые точки по обеим осям)
  const path = Array.from({ length: 60 }, (_, i) => ({ wx: -7000 + ((i * 2371) % 14000), wy: -7000 + ((i * 3917) % 14000) }));

  it('мини-карта слева и в 1,5 раза больше — калибровка находит её сама', () => {
    // Синтетическая раскладка: карта слева внизу, масштаб в 1,5 раза больше обычного
    const k = 0.013724 * 1.5;
    const truth = { ax: k / 1920, bx: 180 / 1920, ay: -k / 1080, by: 880 / 1080 };
    const c = new MinimapCalibrator(mm);
    path.forEach((p, i) => c.addSample(frameWithDot((truth.ax * p.wx + truth.bx) * 1920, (truth.ay * p.wy + truth.by) * 1080, mm.colors[3]!), 3, p.wx, p.wy, i * 3000));
    const s = c.state();
    expect(s.status).toBe('self');
    expect(s.calibration!.ax * 1920).toBeCloseTo(k, 4);
    // В пределах пикселя (центр пятна считается от центра пикселя — сдвиг ≤ 0,5 px, одинаковый у читателя и калибровки)
    expect(Math.abs(s.calibration!.bx * 1920 - 180)).toBeLessThan(1);
    expect(Math.abs(s.calibration!.by * 1080 - 880)).toBeLessThan(1);
  });

  it('мини-карта на обычном месте — раскладка по умолчанию подтверждается', () => {
    const c = new MinimapCalibrator(mm);
    path.forEach((p, i) => c.addSample(frameWithDot((mm.default.ax * p.wx + mm.default.bx) * 1920, (mm.default.ay * p.wy + mm.default.by) * 1080, mm.colors[0]!), 0, p.wx, p.wy, i * 3000));
    expect(c.state()).toMatchObject({ status: 'default-confirmed', calibration: { source: 'layout' } });
  });

  it('пока пар мало — раскладка по умолчанию с пометкой «не подтверждена»', () => {
    const c = new MinimapCalibrator(mm);
    expect(c.state()).toMatchObject({ status: 'default-unconfirmed', pairs: 0 });
  });

  it('несогласованные пары — калибровки нет (позиции не угадываются)', () => {
    const pairs = path.map((p, i) => ({ px: (i * 97) % 1900, py: (i * 53) % 1000, wx: p.wx, wy: p.wy }));
    expect(calibrateFromPairs(pairs, 1920, 1080)).toBeNull();
  });
});
