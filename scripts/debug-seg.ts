// Отладка сегментации: node scripts/debug-seg.ts <кадр.png> <поле> <out.png>
// Печатает найденные символы и сохраняет увеличенную маску (белое — «текст», красные рамки — символы).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';
import { channel, crop, otsu, frameAccessFromImage } from '../src/core/vision/image.ts';
import { findBarAnchor } from '../src/core/vision/hud-anchors.ts';
import { heroNameRect } from '../src/core/vision/hero-name.ts';
import { segment } from '../src/core/vision/segment.ts';
import { scaleRect, type HudLayout } from '../src/core/vision/hud-layout.ts';

const [file, field, out] = process.argv.slice(2);
const root = join(import.meta.dirname, '..');
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const img = decodePng(readFileSync(file!));
// heroName — особая область (от опоры), режим можно указать 4-м аргументом
const isName = field === 'heroName';
const def = isName ? { mode: (process.argv[5] ?? 'luma') as 'luma' | 'white' | 'saturation', dropBorder: false, circleMask: false, firstRun: false } : layout.regions[field!]!;
const rect = isName
  ? heroNameRect(img.width, img.height, findBarAnchor(frameAccessFromImage(img)).barLeft ?? 667)
  : scaleRect(layout, layout.regions[field!]!, img.width, img.height);
const region = crop(img, rect);
const values = channel(region, def.mode);
const { threshold, separation } = otsu(values);
const seg = segment(region, { mode: def.mode, dropBorder: def.dropBorder, circleMask: def.circleMask, firstRun: def.firstRun, splitWide: !isName });
console.log(`порог ${threshold}, разделение ${separation.toFixed(0)}, символов ${seg.glyphs.length}`);
for (const g of seg.glyphs) console.log(`  x=${g.box.x} y=${g.box.y} ${g.box.w}×${g.box.h} relH=${g.relH.toFixed(2)} relTop=${g.relTop.toFixed(2)}`);

const S = 8, W = region.width * S, H = region.height * S;
const px = new Uint8Array(W * H * 4);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const v = values[Math.floor(y / S) * region.width + Math.floor(x / S)]!;
    const on = v > threshold;
    const src = (Math.floor(y / S) * region.width + Math.floor(x / S)) * 4;
    const i = (y * W + x) * 4;
    if (on) px.set([255, 255, 255, 255], i);
    else px.set([region.data[src]! / 3, region.data[src + 1]! / 3, region.data[src + 2]! / 3, 255], i);
  }
for (const g of seg.glyphs) {
  const { x, y, w, h } = g.box;
  for (let i = x * S; i < (x + w) * S; i++) {
    px.set([255, 0, 0, 255], (y * S * W + i) * 4);
    px.set([255, 0, 0, 255], (((y + h) * S - 1) * W + i) * 4);
  }
  for (let j = y * S; j < (y + h) * S; j++) {
    px.set([255, 0, 0, 255], (j * W + x * S) * 4);
    px.set([255, 0, 0, 255], (j * W + (x + w) * S - 1) * 4);
  }
}
writeFileSync(out!, encodePng(W, H, px));
