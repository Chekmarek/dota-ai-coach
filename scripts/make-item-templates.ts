// Шаблоны предметов для распознавания инвентаря: иконки (после scripts/download-icons.mjs и icons-to-rgba)
// сжимаются в сетку 12×9 нормализованных цветов. В проект попадают только эти числа, не картинки Valve.
//   node scripts/make-item-templates.ts
// Результат: src/data/item-templates.json
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { GRID_H, GRID_W, TEMPLATE_SCALE, gridColors, normalizeGrid } from '../src/core/vision/item-grid.ts';

const root = join(import.meta.dirname, '..');
const patch: string = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8')).patch;
const items: { key: string; name: string }[] = JSON.parse(readFileSync(join(root, 'resources/data/kb', patch, 'items.json'), 'utf8'));
const dir = join(root, '.cache/icons', `${patch}-rgba`, 'items');
const files = new Set(readdirSync(dir));

const out: { key: string; name: string; aliases?: string[]; t: number[] }[] = [];
let skipped = 0;
for (const it of items) {
  const key = it.key.replace(/^item_/, '');
  // У всех рецептов одна и та же иконка-свиток — по картинке их не различить
  if (key.startsWith('recipe_')) {
    skipped++;
    continue;
  }
  if (!files.has(`${key}.png`)) {
    console.warn(`нет иконки: ${key}`);
    continue;
  }
  const v = normalizeGrid(gridColors(decodePng(readFileSync(join(dir, `${key}.png`)))));
  const t = Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * TEMPLATE_SCALE))));
  // Одинаковые иконки (Scepter и Scepter от Рошана и т. п.) по картинке не различить — один шаблон, несколько ключей
  const same = out.find((o) => o.t.reduce((d, x, i) => d + (x - t[i]!) ** 2, 0) / t.length / TEMPLATE_SCALE ** 2 < 0.05);
  if (same) {
    same.aliases = [...(same.aliases ?? []), key];
    continue;
  }
  out.push({ key, name: it.name, t });
}
writeFileSync(
  join(root, 'src/data/item-templates.json'),
  JSON.stringify({ patch, grid: [GRID_W, GRID_H], scale: TEMPLATE_SCALE, source: 'иконки предметов Dota 2 (cdn.cloudflare.steamstatic.com), сжатые до сетки 12×9', items: out }),
);
console.log(`Патч ${patch}: шаблонов ${out.length}, рецептов пропущено ${skipped}, объединено одинаковых: ${out.filter((o) => o.aliases).map((o) => [o.key, ...o.aliases!].join('=')).join(', ')}`);
