// Проверка опоры HUD на кадрах:  node scripts/probe-anchor.ts <кадр.png> [...]
import { readFileSync } from 'node:fs';
import { decodePng } from './png.mjs';
import { frameAccessFromImage } from '../src/core/vision/image.ts';
import { findBarAnchor, selectedUnitRelation } from '../src/core/vision/hud-anchors.ts';

for (const f of process.argv.slice(2)) {
  const fa = frameAccessFromImage(decodePng(readFileSync(f)));
  const a = findBarAnchor(fa);
  const rel = a.barLeft !== null ? selectedUnitRelation(fa, a.barLeft) : null;
  console.log(`${f.split(/[\\/]/).pop()}: barLeft=${a.barLeft} (${a.confidence}) → центр уровня ${a.barLeft !== null ? a.barLeft - 191 : '—'}; юнит: ${rel?.value ?? '—'} ${rel ? rel.confidence.toFixed(2) : ''}`);
}
