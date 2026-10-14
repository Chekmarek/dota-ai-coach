// Шаблоны портретов верхней панели. Источник картинок:
//  1) портреты из файлов Dota 2 (scripts/extract-game-portraits.mjs → .cache/icons/<патч>/game-portraits):
//     базовый облик и все облики героя (арканы, персоны: <ключ>_alt1, <ключ>_persona1 и т. п.);
//  2) если папки нет — картинки героев с сервера Valve (scripts/download-icons.mjs → heroes), только базовый облик.
// Картинка уменьшается так же, как портрет на экране, и сжимается в сетку нормализованных цветов и яркости.
// В проект попадают только эти числа, не картинки.
//   node scripts/make-portrait-templates.ts
// Результат: src/data/hero-portraits.json
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import { PORTRAIT_GRID_H, PORTRAIT_GRID_W, PORTRAIT_SCALE, cellSaturation, gridLuma, normalize, portraitGrid, type PortraitTemplate, type PortraitTemplates } from '../src/core/vision/top-bar.ts';

const root = join(import.meta.dirname, '..');
const patch: string = JSON.parse(readFileSync(join(root, 'resources/data/kb/current.json'), 'utf8')).patch;
const heroes: { key: string }[] = JSON.parse(readFileSync(join(root, 'resources/data/kb', patch, 'heroes.json'), 'utf8'));
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const tb = layout.topBar!;
const iconsDir = join(root, '.cache/icons', patch);
const gameDir = join(iconsDir, 'game-portraits');
const fromGame = existsSync(join(gameDir, 'manifest.json'));
const manifest = JSON.parse(readFileSync(join(fromGame ? gameDir : iconsDir, 'manifest.json'), 'utf8')) as { source: string; retrievedAt: string };

const q = (v: Float32Array) => Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * PORTRAIT_SCALE))));
function template(file: string, key: string, variant?: string): PortraitTemplate {
  const img = decodePng(readFileSync(file));
  // Портрет на экране — вся картинка, уменьшенная до w×h; roi задан в координатах портрета
  const sx = img.width / tb.w, sy = img.height / tb.h;
  const [rx, ry, rw, rh] = tb.roi;
  const grid = portraitGrid(img, rx * sx, ry * sy, rw * sx, rh * sy);
  const s = cellSaturation(img, rx * sx, ry * sy, rw * sx, rh * sy).sat;
  return { key, t: q(normalize(grid)), l: q(normalize(gridLuma(grid))), s: Math.round(s * 1000) / 1000, ...(variant ? { variant } : {}) };
}

const out: PortraitTemplates & { source: string; retrievedAt: string; note: string } = {
  patch,
  grid: [PORTRAIT_GRID_W, PORTRAIT_GRID_H],
  source: fromGame ? manifest.source : `${manifest.source}/heroes/<ключ>.png`,
  retrievedAt: manifest.retrievedAt,
  note: `Портреты героев, сжатые до сетки ${PORTRAIT_GRID_W}×${PORTRAIT_GRID_H} (часть портрета roi из раскладки topBar). Только числа, без картинок.`,
  heroes: [],
};
const keys = heroes.map((h) => h.key);
// Длинные ключи первыми: «skywrath_mage_alt1» — облик skywrath_mage, а не чего-то короче
const byLength = [...keys].sort((a, b) => b.length - a.length);
for (const key of keys) {
  const game = join(gameDir, `${key}.png`);
  out.heroes.push(template(fromGame && existsSync(game) ? game : join(iconsDir, 'heroes', `${key}.png`), key));
}
let variants = 0;
if (fromGame) {
  for (const f of readdirSync(gameDir).filter((x) => x.endsWith('.png')).sort()) {
    const name = f.slice(0, -4);
    if (keys.includes(name)) continue;
    const key = byLength.find((k) => name.startsWith(`${k}_`));
    if (!key) continue; // крипы, нейтралы, Рошан — не герои
    out.heroes.push(template(join(gameDir, f), key, `game:${name.slice(key.length + 1)}`));
    variants++;
  }
}
writeFileSync(join(root, 'src/data/hero-portraits.json'), JSON.stringify(out));
console.log(`Шаблонов портретов: ${out.heroes.length} (героев ${keys.length}, обликов ${variants}; источник: ${fromGame ? 'файлы игры' : 'сервер Valve'}; патч ${patch})`);
