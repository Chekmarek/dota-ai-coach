import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { frameAccessFromImage, type FrameAccess } from '../../src/core/vision/image.ts';
import { recognizeHud } from '../../src/core/vision/recognize-hud.ts';

/**
 * Бюджет зрения о союзниках и врагах: все новые читатели вместе — не больше 15 мс на кадр 1920×1080
 * (средний процессор, без видеокарты). Сюда добавляется каждый новый читатель (верхняя панель, мини-карта,
 * полоски здоровья). Кадр синтетический (шум): время не зависит от содержимого больше, чем от размера.
 */
const NEW_VISION_BUDGET_MS = 15;

const ROOT = join(import.meta.dirname, '../..');
const data = (f: string) => JSON.parse(readFileSync(join(ROOT, 'src/data', f), 'utf8'));

function noiseFrame(w: number, h: number): FrameAccess {
  const px = new Uint8ClampedArray(w * h * 4);
  let s = 12345;
  for (let i = 0; i < px.length; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    px[i] = i % 4 === 3 ? 255 : s >>> 24;
  }
  return frameAccessFromImage({ width: w, height: h, data: px });
}

/** Новые читатели этапов 1–3 (пока нет ни одного) */
const NEW_READERS: { id: string; run: (f: FrameAccess) => unknown }[] = [];

function median(fn: () => void, runs = 15): number {
  fn(); // прогрев
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  return t.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
}

describe('скорость зрения (бенчмарк)', () => {
  const frame = noiseFrame(1920, 1080);

  it(`новые читатели вместе ≤ ${NEW_VISION_BUDGET_MS} мс на кадр 1920×1080`, () => {
    const total = median(() => NEW_READERS.forEach((r) => r.run(frame)));
    console.log(`[бенчмарк] новые читатели (${NEW_READERS.map((r) => r.id).join(', ') || 'нет'}): ${total.toFixed(2)} мс`);
    expect(total).toBeLessThanOrEqual(NEW_VISION_BUDGET_MS);
  });

  it('существующее зрение (нижняя панель и часы) — для сравнения', () => {
    const layout = data('hud-layouts/dota2-default-16x9.json');
    const model = data('hud-layouts/glyphs-default.json');
    const t = median(() => recognizeHud(frame, layout, model, 0));
    console.log(`[бенчмарк] нижняя панель и часы: ${t.toFixed(2)} мс`);
    expect(t).toBeGreaterThan(0);
  });
});
