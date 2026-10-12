// Собирает шаблоны символов из размеченных кадров (split = train) и проверяет распознавание на всех кадрах.
//   node scripts/train-glyphs.ts
// Результат: src/data/hud-layouts/glyphs-default.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { crop, frameAccessFromImage, type RgbaImage } from '../src/core/vision/image.ts';
import { segment } from '../src/core/vision/segment.ts';
import { GLYPH_H, GLYPH_W } from '../src/core/vision/segment.ts';
import { scaleRect, type HudLayout } from '../src/core/vision/hud-layout.ts';
import { HUD_FIELDS, formatClock, type Pool } from '../src/core/vision/hud-fields.ts';

/** Значение в формате разметки */
function asLabel(id: string, v: unknown): string {
  if (id === 'gameClock') return formatClock(v as number);
  if (id === 'health' || id === 'mana') return `${(v as Pool).current}/${(v as Pool).max}`;
  return String(v);
}
import { recognizeHud } from '../src/core/vision/recognize-hud.ts';
import { glyphDistance, type GlyphModel, type GlyphSample } from '../src/core/ocr/glyph-ocr.ts';

const root = join(import.meta.dirname, '..');
const fixtures = join(root, 'tests/fixtures/hud');
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const labels = JSON.parse(readFileSync(join(fixtures, 'labels.json'), 'utf8'));
const MAX_PER_CHAR = 24;

const images = new Map<string, RgbaImage>();
const load = (f: string) => {
  if (!images.has(f)) images.set(f, decodePng(readFileSync(join(fixtures, f))));
  return images.get(f)!;
};

const samples: GlyphSample[] = [];
let mismatches = 0;
for (const fr of labels.frames.filter((f: { split: string }) => f.split === 'train')) {
  const img = load(fr.file);
  for (const id of HUD_FIELDS) {
    const truth: string = fr.fields[id].replace(/\s/g, '');
    const def = layout.regions[id]!;
    const region = crop(img, scaleRect(layout, def, img.width, img.height));
    const seg = segment(region, { mode: def.mode, dropBorder: def.dropBorder, circleMask: def.circleMask, firstRun: def.firstRun });
    if (seg.glyphs.length !== truth.length) {
      mismatches++;
      console.warn(`  ! ${fr.file} ${id}: символов ${seg.glyphs.length}, ожидалось ${truth.length} («${truth}»), разделение ${seg.separation.toFixed(0)}`);
      continue;
    }
    seg.glyphs.forEach((g, i) =>
      samples.push({
        ch: truth[i]!,
        vec: Array.from(g.vec, (v) => Math.round(v * 100) / 100),
        aspect: Math.round(g.aspect * 1000) / 1000,
        relH: Math.round(g.relH * 1000) / 1000,
        relTop: Math.round(g.relTop * 1000) / 1000,
        source: `${fr.file}#${id}[${i}]`,
      }),
    );
  }
}

// Ограничиваем число образцов на символ, сохраняя разнообразие (берём равномерно по списку)
const byChar = new Map<string, GlyphSample[]>();
for (const s of samples) byChar.set(s.ch, [...(byChar.get(s.ch) ?? []), s]);
const kept: GlyphSample[] = [];
for (const [, list] of [...byChar].sort(([a], [b]) => a.localeCompare(b))) {
  const step = Math.max(1, list.length / MAX_PER_CHAR);
  for (let i = 0; i < list.length && kept.filter((k) => k.ch === list[0]!.ch).length < MAX_PER_CHAR; i += step) kept.push(list[Math.floor(i)]!);
}

const model: GlyphModel = { version: 1, grid: [GLYPH_W, GLYPH_H], trainedAt: new Date().toISOString(), samples: kept };
writeFileSync(join(root, 'src/data/hud-layouts/glyphs-default.json'), JSON.stringify(model));
console.log(`Образцов: ${samples.length} → сохранено ${kept.length}; символы: ${[...byChar.keys()].sort().join(' ')}; пропущено полей: ${mismatches}`);

// --- Проверка на всех кадрах ---
const stats = { train: { ok: 0, wrong: 0, nul: 0, confWrong: 0 }, test: { ok: 0, wrong: 0, nul: 0, confWrong: 0 } };
for (const fr of labels.frames) {
  const img = load(fr.file);
  const r = recognizeHud(frameAccessFromImage(img), layout, model, 0);
  const line: string[] = [];
  for (const id of HUD_FIELDS) {
    const o = r.fields[id];
    const truth: string = fr.fields[id];
    const st = stats[fr.split as 'train' | 'test'];
    const got = o.raw;
    if (o.value === null) {
      st.nul++;
      line.push(`${id}=∅(${o.validity}:${got} c=${o.confidence.toFixed(2)})`);
    } else if (asLabel(id, o.value) === truth) {
      st.ok++;
      if (process.env.VERBOSE) line.push(`${id}:${o.confidence.toFixed(2)}`);
    } else {
      st.wrong++;
      if (o.confidence >= 0.8) st.confWrong++;
      line.push(`${id}=«${got}»≠«${truth}» c=${o.confidence.toFixed(2)}`);
    }
  }
  if ('selectedUnit' in fr) {
    const su = r.selectedUnit.value;
    if (su !== null && su !== fr.selectedUnit) line.push(`selectedUnit=«${su}»≠«${fr.selectedUnit}» ОШИБКА`);
    else if (process.env.VERBOSE) line.push(`юнит:${su ?? '∅'}`);
  }
  console.log(`${fr.split.padEnd(5)} ${fr.file}  ${r.durationMs.toFixed(1)} мс  ${line.join('  ') || 'всё верно'}`);
}
console.log('Итог:', JSON.stringify(stats));

// --- Анализ для калибровки уверенности (ANALYZE=1): расстояние до верного символа и до ближайшего неверного ---
if (process.env.ANALYZE) {
  const rows: { split: string; dTrue: number; dOther: number }[] = [];
  for (const fr of labels.frames) {
    const img = load(fr.file);
    for (const id of HUD_FIELDS) {
      const truth: string = fr.fields[id].replace(/\s/g, '');
      const def = layout.regions[id]!;
      const seg = segment(crop(img, scaleRect(layout, def, img.width, img.height)), { mode: def.mode, dropBorder: def.dropBorder, circleMask: def.circleMask, firstRun: def.firstRun });
      if (seg.glyphs.length !== truth.length) continue;
      seg.glyphs.forEach((g, i) => {
        let dTrue = Infinity, dOther = Infinity;
        for (const s of model.samples) {
          if (s.source.startsWith(`${fr.file}#`)) continue; // свой же образец не считаем
          const d = glyphDistance(g, s);
          if (s.ch === truth[i]) dTrue = Math.min(dTrue, d);
          else dOther = Math.min(dOther, d);
        }
        rows.push({ split: fr.split, dTrue, dOther });
      });
    }
  }
  for (const split of ['train', 'test']) {
    const r = rows.filter((x) => x.split === split);
    const q = (arr: number[], p: number) => arr.sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))]!.toFixed(4);
    const ratio = r.map((x) => x.dTrue / x.dOther);
    console.log(`${split}: n=${r.length} dTrue p50=${q(r.map((x) => x.dTrue), 0.5)} p95=${q(r.map((x) => x.dTrue), 0.95)} max=${q(r.map((x) => x.dTrue), 1)} | dOther p5=${q(r.map((x) => x.dOther), 0.05)} min=${q(r.map((x) => x.dOther), 0)} | ratio p50=${q(ratio, 0.5)} p95=${q(ratio, 0.95)} max=${q(ratio, 1)}`);
  }
}
