// Печатает средний цвет столбцов в полосе:  node scripts/probe-pixels.ts <кадр.png> <x0> <x1> <y0> <y1> [шаг]
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';

const [file, ...nums] = process.argv.slice(2);
const [x0, x1, y0, y1, step = 4] = nums.map(Number) as [number, number, number, number, number?];
const img = decodePng(readFileSync(file!));
const out: string[] = [];
for (let x = x0; x <= x1; x += step) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    const i = (y * img.width + x) * 4;
    r += img.data[i]!;
    g += img.data[i + 1]!;
    b += img.data[i + 2]!;
    n++;
  }
  out.push(`${x}:${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)}`);
}
console.log(out.join('  '));
