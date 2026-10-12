// Шаблоны крупных цифр перезарядки способностей из размеченных иконок (tests/fixtures/cooldown, split = train)
// и проверка на всех иконках.   node scripts/train-cooldown.ts
// Результат: src/data/hud-layouts/glyphs-cooldown.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { GLYPH_H, GLYPH_W, segment } from '../src/core/vision/segment.ts';
import { readCooldown } from '../src/core/vision/abilities.ts';
import type { GlyphModel, GlyphSample } from '../src/core/ocr/glyph-ocr.ts';
import type { RgbaImage } from '../src/core/vision/image.ts';

const root = join(import.meta.dirname, '..');
const dir = join(root, 'tests/fixtures/cooldown');
const labels: { frames: { file: string; cooldown: string; split: 'train' | 'test' }[] } = JSON.parse(readFileSync(join(dir, 'labels.json'), 'utf8'));
const MAX_PER_CHAR = 32;
const load = (f: string): RgbaImage => decodePng(readFileSync(join(dir, f)));

// Сегментация та же, что в readCooldown: модель с одним «пустым» образцом нужна только чтобы получить глифы
const samples: GlyphSample[] = [];
let skipped = 0;
for (const fr of labels.frames.filter((f) => f.split === 'train')) {
  const icon = load(fr.file);
  const glyphs = glyphsOf(icon);
  if (glyphs.length !== fr.cooldown.length) {
    skipped++;
    console.warn(`  ! ${fr.file}: символов ${glyphs.length}, ожидалось ${fr.cooldown.length} («${fr.cooldown}»)`);
    continue;
  }
  glyphs.forEach((g, i) =>
    samples.push({
      ch: fr.cooldown[i]!,
      vec: Array.from(g.vec, (v) => Math.round(v * 100) / 100),
      aspect: Math.round(g.aspect * 1000) / 1000,
      relH: Math.round(g.relH * 1000) / 1000,
      relTop: Math.round(g.relTop * 1000) / 1000,
      source: `${fr.file}[${i}]`,
    }),
  );
}
const byChar = new Map<string, GlyphSample[]>();
for (const s of samples) byChar.set(s.ch, [...(byChar.get(s.ch) ?? []), s]);
const kept: GlyphSample[] = [];
for (const [, list] of [...byChar].sort(([a], [b]) => a.localeCompare(b))) {
  const step = Math.max(1, list.length / MAX_PER_CHAR);
  for (let i = 0; i < list.length && kept.filter((k) => k.ch === list[0]!.ch).length < MAX_PER_CHAR; i += step) kept.push(list[Math.floor(i)]!);
}
const model: GlyphModel = { version: 1, grid: [GLYPH_W, GLYPH_H], trainedAt: new Date().toISOString(), samples: kept };
writeFileSync(join(root, 'src/data/hud-layouts/glyphs-cooldown.json'), JSON.stringify(model));
console.log(`Образцов: ${samples.length} → сохранено ${kept.length}; символы: ${[...byChar.keys()].sort().join(' ')}; пропущено иконок: ${skipped}`);

const stats = { train: { ok: 0, wrong: 0, nul: 0 }, test: { ok: 0, wrong: 0, nul: 0 } };
for (const fr of labels.frames) {
  const r = readCooldown(load(fr.file), model);
  const st = stats[fr.split];
  if (r.value === null) {
    st.nul++;
    console.log(`${fr.split} ${fr.file}: ∅ («${r.text}» c=${r.confidence.toFixed(2)}, должно ${fr.cooldown})`);
  } else if (String(r.value) === fr.cooldown) st.ok++;
  else {
    st.wrong++;
    console.log(`${fr.split} ${fr.file}: ОШИБКА ${r.value} ≠ ${fr.cooldown} (c=${r.confidence.toFixed(2)})`);
  }
}
console.log('Итог:', JSON.stringify(stats));

/** Глифы так же, как их видит readCooldown (через временную модель-заглушку не идём — повторяем обработку) */
function glyphsOf(icon: RgbaImage) {
  const k = icon.width / 48;
  const x = Math.round(4 * k), y = Math.round(9 * k), w = icon.width - Math.round(8 * k), h = icon.height - Math.round(21 * k);
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++)
    for (let i = 0; i < w; i++) {
      const p = ((y + j) * icon.width + x + i) * 4, q = (j * w + i) * 4;
      if (icon.data[p]! > 190 && icon.data[p + 1]! > 190 && icon.data[p + 2]! > 190) data.set(icon.data.subarray(p, p + 3), q);
      data[q + 3] = 255;
    }
  return segment({ width: w, height: h, data }, { mode: 'white', minSeparation: 40 }).glyphs;
}
