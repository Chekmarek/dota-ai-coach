// Делает тестовые кадры для обучения: оставляет только полосы интерфейса (верх и низ экрана), остальное — чёрное.
// В этих полосах нет ников игроков и чата, а файлы в несколько раз меньше.
//   node scripts/make-strip-fixtures.mjs <папка-назначения> <кадр.png>=<имя.png> [...]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';

// Полосы для 1920×1080 (масштабируются по высоте кадра): верхняя панель со счётом, часами и У/С/П,
// нижняя панель героя, способностей, предметов и золота
const KEEP = [
  [0, 110],
  [880, 1080],
];

const [outDir, ...pairs] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
for (const pair of pairs) {
  const [src, name] = pair.split('=');
  const img = decodePng(readFileSync(src));
  const k = img.height / 1080;
  const out = new Uint8Array(img.width * img.height * 4);
  for (let i = 3; i < out.length; i += 4) out[i] = 255;
  for (const [a, b] of KEEP) {
    const y0 = Math.floor(a * k), y1 = Math.min(img.height, Math.ceil(b * k));
    out.set(img.data.subarray(y0 * img.width * 4, y1 * img.width * 4), y0 * img.width * 4);
  }
  writeFileSync(join(outDir, name), encodePng(img.width, img.height, out));
}
console.log(`${pairs.length} кадров → ${outDir}`);
