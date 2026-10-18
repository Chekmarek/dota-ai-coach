// Ускоренный classify (досрочный отсев образцов) обязан давать то же, что полный перебор glyphDistance:
// тот же символ и те же score/margin до бита — на зашумлённых образцах всех моделей (всегда, в т. ч. в CI)
// и на символах кадров HUD (кадры с никами в репозиторий не входят — эта часть только локально).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../scripts/png.mjs';
import { classify, glyphDistance, type GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';
import { frameAccessFromImage } from '../../src/core/vision/image.ts';
import { scaleRect, type HudLayout } from '../../src/core/vision/hud-layout.ts';
import { segment, type Glyph } from '../../src/core/vision/segment.ts';

const ROOT = join(import.meta.dirname, '../..');
const data = <T>(f: string): T => JSON.parse(readFileSync(join(ROOT, 'src/data', f), 'utf8')) as T;
const layout = data<HudLayout>('hud-layouts/dota2-default-16x9.json');
const models = ['glyphs-default.json', 'glyphs-cooldown.json', 'glyphs-heroname.json'].map((f) => data<GlyphModel>(`hud-layouts/${f}`));

/** Прежний classify (до ускорения) — эталон */
function reference(model: GlyphModel, g: Glyph): { ch: string; score: number; margin: number } {
  let best = Infinity, bestCh = '?';
  const perChar = new Map<string, number>();
  for (const s of model.samples) {
    const d = glyphDistance(g, s);
    if (d < (perChar.get(s.ch) ?? Infinity)) perChar.set(s.ch, d);
    if (d < best) {
      best = d;
      bestCh = s.ch;
    }
  }
  let second = Infinity;
  for (const [ch, d] of perChar) if (ch !== bestCh && d < second) second = d;
  const margin = Number.isFinite(second) ? Math.max(0, Math.min(1, 1 - best / Math.max(second, 1e-9))) : 1;
  const score = Math.min(Math.sqrt(margin), Math.max(0, 1 - best / 0.25));
  return { ch: bestCh, score, margin };
}

function hudGlyphs(): Glyph[] {
  const dir = HUD_DIR;
  const out: Glyph[] = [];
  // каждый третий кадр: разные герои, предметы, числа — и тест укладывается в пару секунд
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.png')).filter((_, i) => i % 3 === 0)) {
    const img = decodePng(readFileSync(join(dir, file)));
    const f = frameAccessFromImage(img);
    for (const def of Object.values(layout.regions)) {
      const region = f.read(scaleRect(layout, def, img.width, img.height));
      for (const mode of [def.mode, ...(def.altModes ?? [])]) out.push(...segment(region, { mode, dropBorder: def.dropBorder, circleMask: def.circleMask, firstRun: def.firstRun }).glyphs);
    }
  }
  return out;
}

/** Псевдослучайный шум (повторяемый) */
function noisy(g: Glyph, seed: number, amp: number): Glyph {
  let x = seed;
  const rnd = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  return { ...g, vec: Float32Array.from(g.vec, (v) => Math.min(1, Math.max(0, v + rnd() * amp))), aspect: g.aspect + rnd() * amp * 0.5 };
}

/** Символы из образцов модели с шумом: в репозитории кадров HUD нет, а перебор надо проверить и в CI */
function sampleGlyphs(model: GlyphModel): Glyph[] {
  return model.samples.map((s) => ({ vec: Float32Array.from(s.vec), aspect: s.aspect, relH: s.relH, relTop: s.relTop, box: { x: 0, y: 0, w: 1, h: 1 } }) as Glyph);
}

function same(model: GlyphModel, glyphs: Glyph[]): number {
  let checked = 0;
  glyphs.forEach((g, i) => {
    for (const q of [g, noisy(g, i + 1, 0.3), noisy(g, i + 7, 1)]) {
      const a = classify(model, q), b = reference(model, q);
      if (a.ch !== b.ch || !Object.is(a.score, b.score) || !Object.is(a.margin, b.margin)) expect({ i, a }).toEqual({ i, a: b });
      checked++;
    }
  });
  return checked;
}

const HUD_DIR = join(ROOT, 'tests/fixtures/hud');

describe('распознавание символов: ускоренный перебор = полный перебор', () => {
  it('образцы всех моделей, чистые и зашумлённые — тот же символ, score и margin до бита', () => {
    let checked = 0;
    for (const model of models) checked += same(model, sampleGlyphs(model));
    expect(checked).toBeGreaterThan(2000);
  });

  it.skipIf(!existsSync(HUD_DIR))('символы кадров HUD (локально) — то же до бита', () => {
    const glyphs = hudGlyphs();
    expect(glyphs.length).toBeGreaterThan(500);
    let checked = 0;
    for (const model of models) if (model.samples[0]!.vec.length === glyphs[0]!.vec.length) checked += same(model, glyphs);
    expect(checked).toBeGreaterThan(1500);
  });
});
