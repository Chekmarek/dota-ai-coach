// Инструмент разметки: вырезает прямоугольник из кадров и складывает увеличенные куски в один PNG.
//   node scripts/hud-crop.mjs <out.png> <x> <y> <w> <h> <scale> <кадр1.png> [кадр2.png ...]
import { readFileSync, writeFileSync } from 'node:fs';
import { decodePng, encodePng } from './png.mjs';

const [out, xs, ys, ws, hs, ss, ...files] = process.argv.slice(2);
const [x, y, w, h, s] = [xs, ys, ws, hs, ss].map(Number);
const gap = 4;
const W = w * s, H = (h * s + gap) * files.length;
const dst = new Uint8Array(W * H * 4).fill(255);
files.forEach((f, k) => {
  const img = decodePng(readFileSync(f));
  for (let j = 0; j < h * s; j++)
    for (let i = 0; i < W; i++) {
      const sx = x + Math.floor(i / s), sy = y + Math.floor(j / s);
      const si = (sy * img.width + sx) * 4, di = ((k * (h * s + gap) + j) * W + i) * 4;
      dst.set(img.data.subarray(si, si + 4), di);
    }
});
writeFileSync(out, encodePng(W, H, dst));
console.log(`${out}: ${W}×${H}`);
