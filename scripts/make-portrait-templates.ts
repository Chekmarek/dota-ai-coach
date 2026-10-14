// Шаблоны портретов верхней панели: картинки героев 256×144 (после scripts/download-icons.mjs, папка heroes)
// уменьшаются так же, как портрет на экране, и сжимаются в сетку нормализованных цветов и яркости.
// В проект попадают только эти числа, не картинки Valve.
//   node scripts/make-portrait-templates.ts
// Результат: src/data/hero-portraits.json
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import { PORTRAIT_GRID_H, PORTRAIT_GRID_W, PORTRAIT_SCALE, cellSaturation, gridLuma, normalize, portraitGrid, type PortraitTemplates } from '../src/core/vision/top-bar.ts';

const root = join(import.meta.dirname, '..');
const patch: string = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8')).patch;
const heroes: { key: string }[] = JSON.parse(readFileSync(join(root, 'resources/data/kb', patch, 'heroes.json'), 'utf8'));
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const tb = layout.topBar!;
const iconsDir = join(root, '.cache/icons', patch);
const manifest = JSON.parse(readFileSync(join(iconsDir, 'manifest.json'), 'utf8')) as { source: string; retrievedAt: string };

const q = (v: Float32Array) => Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * PORTRAIT_SCALE))));
const out: PortraitTemplates & { source: string; retrievedAt: string; note: string } = {
  patch,
  grid: [PORTRAIT_GRID_W, PORTRAIT_GRID_H],
  source: `${manifest.source}/heroes/<ключ>.png`,
  retrievedAt: manifest.retrievedAt,
  note: `Портреты героев Valve, сжатые до сетки ${PORTRAIT_GRID_W}×${PORTRAIT_GRID_H} (часть портрета roi из раскладки topBar). Только числа, без картинок.`,
  heroes: [],
};
for (const h of heroes) {
  const img = decodePng(readFileSync(join(iconsDir, 'heroes', `${h.key}.png`)));
  // Портрет на экране — вся картинка, уменьшенная до w×h; roi задан в координатах портрета
  const sx = img.width / tb.w, sy = img.height / tb.h;
  const [rx, ry, rw, rh] = tb.roi;
  const grid = portraitGrid(img, rx * sx, ry * sy, rw * sx, rh * sy);
  const s = cellSaturation(img, rx * sx, ry * sy, rw * sx, rh * sy).sat;
  out.heroes.push({ key: h.key, t: q(normalize(grid)), l: q(normalize(gridLuma(grid))), s: Math.round(s * 1000) / 1000 });
}
writeFileSync(join(root, 'src/data/hero-portraits.json'), JSON.stringify(out));
console.log(`Шаблонов портретов: ${out.heroes.length} (патч ${patch}, сетка ${PORTRAIT_GRID_W}×${PORTRAIT_GRID_H})`);
