import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../scripts/png.mjs';
import { frameAccessFromImage } from '../../src/core/vision/image.ts';
import { findBarAnchor } from '../../src/core/vision/hud-anchors.ts';
import { readHeroName, type HeroNameEntry } from '../../src/core/vision/hero-name.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';

const ROOT = join(import.meta.dirname, '../..');
const FIX = join(ROOT, 'tests/fixtures/hud');
const model: GlyphModel = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/glyphs-heroname.json'), 'utf8'));
const names: HeroNameEntry[] = JSON.parse(readFileSync(join(ROOT, 'src/data/hero-names.json'), 'utf8')).names;
// Кадры с никами игроков в общий репозиторий не входят — без них тест пропускается
const HAS_FIX = existsSync(join(FIX, 'labels.json'));
const labels = (HAS_FIX ? JSON.parse(readFileSync(join(FIX, 'labels.json'), 'utf8')) : { heroNameTrain: [], frames: [] }) as {
  heroNameTrain: string[];
  frames: { file: string; heroName: string }[];
};

const read = (file: string, m: GlyphModel) => {
  const fa = frameAccessFromImage(decodePng(readFileSync(join(FIX, file))));
  return readHeroName(fa, findBarAnchor(fa).barLeft, m, names, 0, 'test', '1').observed.value?.name ?? null;
};

describe.skipIf(!HAS_FIX)('имя героя над портретом', () => {
  it('ни одного неверного героя; узнано не меньше 60 % кадров', () => {
    const results = labels.frames.map((f) => ({ f, got: read(f.file, model) }));
    expect(results.filter((r) => r.got !== null && r.got !== r.f.heroName).map((r) => `${r.f.file}: ${r.got}`)).toEqual([]);
    expect(results.filter((r) => r.got === r.f.heroName).length / results.length).toBeGreaterThanOrEqual(0.6);
  }, 60_000);

  it('«исключи одного героя»: без образцов его букв — либо узнан по остальным признакам, либо «не знаю», но не другой герой', () => {
    for (const hero of new Set(labels.frames.map((f) => f.heroName))) {
      const files = labels.frames.filter((f) => f.heroName === hero).map((f) => f.file);
      const without: GlyphModel = { ...model, samples: model.samples.filter((s) => !files.some((f) => s.source.startsWith(`${f}#`))) };
      for (const f of files) {
        const got = read(f, without);
        expect(got === null || got === hero, `${f}: ${got}`).toBe(true);
      }
    }
  }, 60_000);

  it('список имён совпадает с базой знаний (127 героев)', () => {
    expect(names).toHaveLength(127);
  });
});
