// Печатает распознанный инвентарь для кадров:  node scripts/items.ts <кадр.png> [...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { frameAccessFromImage } from '../src/core/vision/image.ts';
import { recognizeHud } from '../src/core/vision/recognize-hud.ts';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../src/core/ocr/glyph-ocr.ts';
import type { ItemTemplates } from '../src/core/vision/items.ts';

const root = join(import.meta.dirname, '..');
const data = (f: string) => JSON.parse(readFileSync(join(root, 'src/data', f), 'utf8'));
const layout: HudLayout = data('hud-layouts/dota2-default-16x9.json');
const model: GlyphModel = data('hud-layouts/glyphs-default.json');
const itemTemplates: ItemTemplates = data('item-templates.json');
for (const f of process.argv.slice(2)) {
  const r = recognizeHud(frameAccessFromImage(decodePng(readFileSync(f))), layout, model, 0, { itemTemplates });
  const cells = r.items?.map((i) => `${i.slot}:${i.empty ? '—' : i.item ? i.item.key : `?(${i.distance})`}`) ?? ['панель не найдена'];
  console.log(`${f.split(/[\\/]/).slice(-2).join('/')}: ${cells.join(' ')}`);
}
