// Обучение букв имени героя и проверка распознавания имени.
//   node scripts/train-names.ts      → src/data/hud-layouts/glyphs-heroname.json
// Проверки: (1) все размеченные кадры; (2) «исключи одного героя» — модель без букв этого героя
// должна либо узнать его по остальным признакам, либо ответить «не знаю», но не назвать другого героя.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { crop, frameAccessFromImage, type RgbaImage } from '../src/core/vision/image.ts';
import { segment, GLYPH_H, GLYPH_W } from '../src/core/vision/segment.ts';
import { findBarAnchor } from '../src/core/vision/hud-anchors.ts';
import { heroNameRect, keepLetters, readHeroName, splitWords, type HeroNameEntry } from '../src/core/vision/hero-name.ts';
import type { GlyphModel, GlyphSample } from '../src/core/ocr/glyph-ocr.ts';

const root = join(import.meta.dirname, '..');
const fixtures = join(root, 'tests/fixtures/hud');
const labels = JSON.parse(readFileSync(join(fixtures, 'labels.json'), 'utf8'));
const names: HeroNameEntry[] = JSON.parse(readFileSync(join(root, 'src/data/hero-names.json'), 'utf8')).names;
const cache = new Map<string, RgbaImage>();
const load = (f: string) => cache.get(f) ?? (cache.set(f, decodePng(readFileSync(join(fixtures, f)))), cache.get(f)!);

/** Образцы букв с одного кадра (если разбиение совпало с разметкой по словам и буквам) */
export function samplesFrom(file: string, heroName: string): GlyphSample[] {
  const img = load(file);
  const anchor = findBarAnchor(frameAccessFromImage(img));
  if (anchor.barLeft === null) return [];
  const region = crop(img, heroNameRect(img.width, img.height, anchor.barLeft));
  const target = heroName.toUpperCase().split(' ');
  for (const mode of ['luma', 'white', 'saturation'] as const) {
    const seg = segment(region, { mode, splitWide: false, minSeparation: 45, dropBorder: true });
    const words = splitWords(keepLetters(seg.glyphs));
    if (words.length !== target.length || words.some((w, i) => w.length !== target[i]!.length)) continue;
    return words.flatMap((w, wi) =>
      w.map((g, i) => ({
        ch: target[wi]![i]!,
        vec: Array.from(g.vec, (v) => Math.round(v * 100) / 100),
        aspect: Math.round(g.aspect * 1000) / 1000,
        relH: Math.round(g.relH * 1000) / 1000,
        relTop: Math.round(g.relTop * 1000) / 1000,
        source: `${file}#heroName[${wi}:${i}]`,
      })),
    );
  }
  return [];
}

const model = (samples: GlyphSample[]): GlyphModel => ({ version: 1, grid: [GLYPH_W, GLYPH_H], trainedAt: new Date().toISOString(), samples });

const trainFiles: string[] = labels.heroNameTrain;
const all: GlyphSample[] = [];
for (const f of trainFiles) {
  const fr = labels.frames.find((x: { file: string }) => x.file === f);
  const s = samplesFrom(f, fr.heroName);
  if (!s.length) console.warn(`  ! ${f}: разбиение не совпало с «${fr.heroName}» — кадр пропущен`);
  all.push(...s);
}
const full = model(all);
writeFileSync(join(root, 'src/data/hud-layouts/glyphs-heroname.json'), JSON.stringify(full));
console.log(`Букв-образцов: ${all.length}; буквы: ${[...new Set(all.map((s) => s.ch))].sort().join('')}`);

function evaluate(m: GlyphModel, frames: { file: string; heroName: string }[], tag: string) {
  let ok = 0, nul = 0, wrong = 0;
  for (const fr of frames) {
    const img = load(fr.file);
    const fa = frameAccessFromImage(img);
    const r = readHeroName(fa, findBarAnchor(fa).barLeft, m, names, 0, 'test', '1');
    const v = r.observed.value?.name ?? null;
    if (v === null) nul++;
    else if (v === fr.heroName) ok++;
    else wrong++;
    if (process.env.VERBOSE || (v !== null && v !== fr.heroName))
      console.log(`  ${tag} ${fr.file}: ${v ?? '∅'} (c=${r.observed.confidence.toFixed(2)}, ${r.observed.raw}) кандидаты: ${r.candidates.map((c) => `${c.name}:${c.cost}`).join(', ')}${v !== null && v !== fr.heroName ? '  ОШИБКА' : ''}`);
  }
  return { ok, nul, wrong };
}

console.log('Все кадры:', JSON.stringify(evaluate(full, labels.frames, 'all')));
const heldOut = labels.frames.filter((f: { file: string }) => !trainFiles.includes(f.file));
console.log('Кадры вне обучения:', JSON.stringify(evaluate(full, heldOut, 'test')));
for (const hero of [...new Set(labels.frames.map((f: { heroName: string }) => f.heroName))] as string[]) {
  const without = model(all.filter((s) => !labels.frames.some((f: { file: string; heroName: string }) => f.heroName === hero && s.source.startsWith(`${f.file}#`))));
  const frames = labels.frames.filter((f: { heroName: string }) => f.heroName === hero);
  console.log(`Без букв героя ${hero}:`, JSON.stringify(evaluate(without, frames, `loo:${hero}`)));
}
