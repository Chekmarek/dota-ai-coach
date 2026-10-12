// Распознаёт HUD на всех PNG-кадрах папки (рекурсивно) и печатает таблицу — для проверки на длинной записи:
//   node scripts/batch-recognize.ts <папка> [> отчёт.tsv]
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { decodePng } from './png.mjs';
import { frameAccessFromImage } from '../src/core/vision/image.ts';
import { recognizeHud } from '../src/core/vision/recognize-hud.ts';
import { HUD_FIELDS } from '../src/core/vision/hud-fields.ts';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../src/core/ocr/glyph-ocr.ts';
import type { HeroNameEntry } from '../src/core/vision/hero-name.ts';

const root = join(import.meta.dirname, '..');
const data = (f: string) => JSON.parse(readFileSync(join(root, 'src/data', f), 'utf8'));
const layout: HudLayout = data('hud-layouts/dota2-default-16x9.json');
const model: GlyphModel = data('hud-layouts/glyphs-default.json');
const cooldownModel = data('hud-layouts/glyphs-cooldown.json') as GlyphModel;
const itemTemplates = data('item-templates.json');
const heroName = { model: data('hud-layouts/glyphs-heroname.json') as GlyphModel, names: data('hero-names.json').names as HeroNameEntry[] };

const dir = process.argv[2]!;
const files: string[] = [];
const walk = (d: string) => {
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.png')) files.push(p);
  }
};
walk(dir);

const show = (v: unknown) => (v === null || v === undefined ? '-' : typeof v === 'object' ? Object.values(v as object).join('/') : String(v));
console.log(['кадр', ...HUD_FIELDS, 'панель', 'герой', 'день', 'способности', 'мс'].join('\t'));
for (const f of files) {
  const r = recognizeHud(frameAccessFromImage(decodePng(readFileSync(f))), layout, model, 0, { heroName, cooldownModel, itemTemplates });
  const cells = HUD_FIELDS.map((id) => show(r.fields[id].value));
  console.log([relative(dir, f), ...cells, show(r.selectedUnit.value), show(r.heroName.value?.name), show(r.dayNight.value), r.abilities?.map((a) => a.state[0] + (a.cooldown ?? '') + a.level).join(' ') ?? '-', r.durationMs.toFixed(0)].join('\t'));
}
