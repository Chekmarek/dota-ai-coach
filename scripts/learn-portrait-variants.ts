// УСТАРЕЛО (2026-10-14): облики героев теперь берутся из файлов игры (scripts/extract-game-portraits.mjs),
// и проверка на наборе остаётся честной. Этот скрипт оставлен для героев, чьих обликов нет в файлах игры.
// Варианты портретов верхней панели из набора кадров (docs/VISION_DATASET.md): если у героя в матче другой облик
// (персона, аркана) и картинка Valve его не узнаёт, портрет снимается с кадров (герой по ячейке известен из GSI
// наблюдателя) и добавляется в шаблоны как вариант «dataset:<матч>». В шаблоны идут только числа сетки, без кадров.
//   node scripts/learn-portrait-variants.ts <index.json> <матч,матч,...> [--out файл] [--step 2]
// Без --out дописывает в src/data/hero-portraits.json (прошлые варианты из набора удаляются).
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import {
  PORTRAIT_SCALE,
  cellSaturation,
  gridLuma,
  matchPortrait,
  normalize,
  portraitGrid,
  type PortraitTemplate,
  type PortraitTemplates,
} from '../src/core/vision/top-bar.ts';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const [indexFile, matchList] = args.filter((a) => !a.startsWith('--'));
const outArg = args.indexOf('--out');
const outFile = outArg >= 0 ? args[outArg + 1]! : join(root, 'src/data/hero-portraits.json');
const step = args.includes('--step') ? Number(args[args.indexOf('--step') + 1]) : 2;
if (!indexFile || !matchList) {
  console.error('Использование: node scripts/learn-portrait-variants.ts <index.json> <матч,матч> [--out файл] [--step 2]');
  process.exit(2);
}
const matches = new Set(matchList.split(','));
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const tb = layout.topBar!;
const templates: PortraitTemplates & Record<string, unknown> = JSON.parse(readFileSync(join(root, 'src/data/hero-portraits.json'), 'utf8'));
const base: PortraitTemplates = { ...templates, heroes: templates.heroes.filter((h) => !h.variant) };

type Frame = { png: string; matchId: string; heroes: { slot: number; heroKey: string | null; alive: boolean | null }[] };
const frames = (JSON.parse(readFileSync(indexFile, 'utf8')) as Frame[]).filter((f) => matches.has(f.matchId));
type Acc = { sum: Float32Array | null; n: number; sat: number; hit: number; total: number };
const acc = new Map<string, Acc>();
for (let i = 0; i < frames.length; i += step) {
  const f = frames[i]!;
  const img = decodePng(readFileSync(f.png));
  for (const h of f.heroes) {
    if (!h.heroKey || h.alive !== true) continue;
    const x = h.slot < 5 ? tb.radiantX + h.slot * tb.step : tb.direX + (h.slot - 5) * tb.step;
    const [rx, ry, rw, rh] = tb.roi;
    const { sat, bright } = cellSaturation(img, x + rx, tb.y + ry, rw, rh);
    if (bright < 0.2) continue;
    const grid = portraitGrid(img, x + rx, tb.y + ry, rw, rh);
    const k = `${h.heroKey}|${f.matchId}`;
    const a = acc.get(k) ?? { sum: null, n: 0, sat: 0, hit: 0, total: 0 };
    a.sum ??= new Float32Array(grid.length);
    for (let j = 0; j < grid.length; j++) a.sum[j]! += grid[j]!;
    a.n++;
    a.sat += sat;
    a.total++;
    if (matchPortrait(grid, false, base).key === h.heroKey) a.hit++;
    acc.set(k, a);
  }
}
const q = (v: Float32Array) => Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * PORTRAIT_SCALE))));
const variants: PortraitTemplate[] = [];
for (const [k, a] of acc) {
  const [key, matchId] = k.split('|') as [string, string];
  const rate = a.hit / a.total;
  if (rate >= 0.9 || a.n < 20) continue; // картинка Valve и так узнаёт, или мало кадров
  const mean = a.sum!.map((x) => x / a.n);
  variants.push({ key, t: q(normalize(mean)), l: q(normalize(gridLuma(mean))), s: Math.round((a.sat / a.n) * 1000) / 1000, variant: `dataset:${matchId}` });
  console.log(`  ${key} (матч ${matchId}): картинка Valve узнаёт ${(100 * rate).toFixed(0)}% из ${a.total} → вариант из ${a.n} кадров`);
}
const out = { ...templates, heroes: [...base.heroes, ...variants] };
writeFileSync(outFile, JSON.stringify(out));
console.log(`Вариантов: ${variants.length} → ${outFile}`);
