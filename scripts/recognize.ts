// Распознаёт числа HUD на одном PNG-кадре и печатает результат:  node scripts/recognize.ts <кадр.png>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { frameAccessFromImage } from '../src/core/vision/image.ts';
import { recognizeHud } from '../src/core/vision/recognize-hud.ts';
import { HUD_FIELDS } from '../src/core/vision/hud-fields.ts';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../src/core/ocr/glyph-ocr.ts';

const root = join(import.meta.dirname, '..');
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const model: GlyphModel = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/glyphs-default.json'), 'utf8'));
const img = decodePng(readFileSync(process.argv[2]!));
const r = recognizeHud(frameAccessFromImage(img), layout, model, 0);
for (const id of HUD_FIELDS) {
  const o = r.fields[id];
  console.log(`${id.padEnd(13)} ${JSON.stringify(o.value)?.padEnd(32)} текст «${o.raw}»  уверенность ${o.confidence.toFixed(2)}  ${o.validity}`);
}
console.log(`время ${r.durationMs.toFixed(1)} мс`);
