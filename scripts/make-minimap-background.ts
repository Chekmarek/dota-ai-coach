// Неподвижный фон мини-карты: медиана по кадрам набора (docs/VISION_DATASET.md) в координатах мира.
// Значки героев двигаются — медиана их убирает; остаются река, местность, постройки. Читатель мини-карты
// не считает значком пиксель, совпадающий с фоном в этом месте (ложные «герои» на реке и местности).
// Плюс «опасные клетки» по каждому игроку: клетка часто бывает цвета игрока, когда самого героя рядом нет
// (по GSI наблюдателя) — например, светло-голубая вода и голубой игрок. В них пиксели этому игроку не засчитываются.
//   node scripts/make-minimap-background.ts <index.json> <матч,матч> [--size 122] [--frames 61]
// Результат: src/data/minimap-background.json (RGB в base64, только цвета клеток карты — без героев и ников)
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const [indexFile, matchList] = args.filter((a) => !a.startsWith('--'));
const opt = (n: string, d: number) => (args.includes(n) ? Number(args[args.indexOf(n) + 1]) : d);
const size = opt('--size', 122), nFrames = opt('--frames', 61);
if (!indexFile || !matchList) {
  console.error('Использование: node scripts/make-minimap-background.ts <index.json> <матч,матч> [--size 122] [--frames 61]');
  process.exit(2);
}
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const mm = layout.minimap!;
const cal = mm.default;
const matches = new Set(matchList.split(','));
type Frame = {
  png: string;
  matchId: string;
  clock: number | null;
  width: number;
  height: number;
  heroes: { slot: number; alive: boolean | null; xpos: number | null; ypos: number | null }[];
};
const frames = (JSON.parse(readFileSync(indexFile, 'utf8')) as Frame[]).filter((f) => matches.has(f.matchId) && (f.clock ?? -1) > 0);
const [x0, y0, x1, y1] = mm.world;
const samples: Uint8Array[] = [];
/** Сколько раз клетка была цвета игрока без героя рядом, по игрокам */
const confusedCount = new Uint16Array(10 * size * size);
let confusedFrames = 0;
const cellWorld = (u: number, v: number) => [x0 + ((u + 0.5) / size) * (x1 - x0), y1 - ((v + 0.5) / size) * (y1 - y0)] as const;
for (let i = 0; i < frames.length; i += Math.max(1, Math.floor(frames.length / 400))) {
  const f = frames[i]!;
  const img = decodePng(readFileSync(f.png));
  confusedFrames++;
  for (let v = 0; v < size; v++)
    for (let u = 0; u < size; u++) {
      const [wx, wy] = cellWorld(u, v);
      const px = Math.round((cal.ax * wx + cal.bx) * img.width), py = Math.round((cal.ay * wy + cal.by) * img.height);
      const k = (py * img.width + px) * 4;
      for (let slot = 0; slot < 10; slot++) {
        const c = mm.colors[slot]!;
        const tol = mm.colorToleranceBySlot?.[String(slot)] ?? mm.colorTolerance;
        if (Math.abs(img.data[k]! - c[0]) + Math.abs(img.data[k + 1]! - c[1]) + Math.abs(img.data[k + 2]! - c[2]) >= tol) continue;
        const h = f.heroes.find((x) => x.slot === slot);
        // Герой рядом — это и есть его значок (значок ~20 px ≈ 1400 ед.), не путаница
        if (h?.alive && typeof h.xpos === 'number' && typeof h.ypos === 'number' && Math.hypot(h.xpos - wx, h.ypos - wy) < 900) continue;
        confusedCount[slot * size * size + v * size + u]!++;
      }
    }
}
/** Клетка опасна для игрока, если без героя бывала его цвета хотя бы в 3 % кадров */
const confusable = new Uint8Array(10 * size * size);
for (let i = 0; i < confusable.length; i++) confusable[i] = confusedCount[i]! / confusedFrames >= 0.03 ? 1 : 0;
const confusedBySlot = Array.from({ length: 10 }, (_, s) => confusable.subarray(s * size * size, (s + 1) * size * size).reduce((a, b) => a + b, 0));
for (let i = 0; i < nFrames; i++) {
  const f = frames[Math.floor((i * frames.length) / nFrames)]!;
  const img = decodePng(readFileSync(f.png));
  const a = new Uint8Array(size * size * 3);
  for (let v = 0; v < size; v++)
    for (let u = 0; u < size; u++) {
      // Центр клетки в координатах мира → пиксель кадра по калибровке по умолчанию
      const wx = x0 + ((u + 0.5) / size) * (x1 - x0), wy = y1 - ((v + 0.5) / size) * (y1 - y0);
      const px = Math.round((cal.ax * wx + cal.bx) * img.width), py = Math.round((cal.ay * wy + cal.by) * img.height);
      const k = (py * img.width + px) * 4, o = (v * size + u) * 3;
      a[o] = img.data[k]!;
      a[o + 1] = img.data[k + 1]!;
      a[o + 2] = img.data[k + 2]!;
    }
  samples.push(a);
}
const rgb = new Uint8Array(size * size * 3);
const tmp: number[] = new Array(samples.length);
for (let i = 0; i < rgb.length; i++) {
  for (let s = 0; s < samples.length; s++) tmp[s] = samples[s]![i]!;
  tmp.sort((a, b) => a - b);
  rgb[i] = tmp[tmp.length >> 1]!;
}
writeFileSync(
  join(root, 'src/data/minimap-background.json'),
  JSON.stringify({
    note: `Медианный фон мини-карты по ${samples.length} кадрам набора 2026-10-14 (матчи ${[...matches].join(', ')}), клетки ${size}×${size} поверх границ world. Без героев и ников.`,
    world: mm.world,
    width: size,
    height: size,
    tolerance: 30,
    rgb: Buffer.from(rgb).toString('base64'),
    // Опасные клетки по игрокам (0/1, 10 слоёв size×size), см. начало файла
    confusable: Buffer.from(confusable).toString('base64'),
  }),
);
console.log(`Фон мини-карты: ${size}×${size} по ${samples.length} кадрам (${[...matches].join(', ')}); опасных клеток по игрокам (по ${confusedFrames} кадрам):`, confusedBySlot.join(' '));
