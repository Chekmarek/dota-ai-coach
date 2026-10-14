// Дополняет шаблоны цифр (glyphs-default.json) цифрами таймера возрождения с верхней панели — по набору кадров.
// Правильный ответ — respawn_seconds из GSI наблюдателя. Экран округляет вверх и отстаёт от GSI до 1 с, поэтому
// на кадре GSI+1 или GSI+2: подпись берётся, если прочитанное отличается от одного из этих вариантов не больше
// чем одной цифрой и такой вариант единственный (как в train-clock-glyphs.ts).
//   node scripts/train-respawn-glyphs.ts <index.json> <matchId> [--per-char 16] [--step 1]
import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { decodePng } from './png.mjs';
import { crop } from '../src/core/vision/image.ts';
import { segment } from '../src/core/vision/segment.ts';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import { classify, glyphDistance, type GlyphModel, type GlyphSample } from '../src/core/ocr/glyph-ocr.ts';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const [indexFile, matchId] = args.filter((a) => !a.startsWith('--'));
const opt = (name: string, def: number) => (args.includes(name) ? Number(args[args.indexOf(name) + 1]) : def);
const perChar = opt('--per-char', 16);
const step = opt('--step', 1);
if (!indexFile || !matchId) {
  console.error('Использование: node scripts/train-respawn-glyphs.ts <index.json> <matchId> [--per-char 16] [--step 1]');
  process.exit(2);
}
const PREFIX = 'dataset-respawn:';
const modelFile = join(root, 'src/data/hud-layouts/glyphs-default.json');
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const tb = layout.topBar!;
const model: GlyphModel = JSON.parse(readFileSync(modelFile, 'utf8'));
model.samples = model.samples.filter((s) => !s.source.startsWith(PREFIX));

type Frame = { png: string; matchId: string; heroes: { slot: number; alive: boolean | null; respawnSec: number | null }[] };
const frames = (JSON.parse(readFileSync(indexFile, 'utf8')) as Frame[]).filter(
  (f) => f.matchId === matchId && f.heroes.some((h) => h.alive === false && (h.respawnSec ?? 0) > 0),
);
const candidates: GlyphSample[] = [];
let used = 0;
for (let i = 0; i < frames.length; i += step) {
  const f = frames[i]!;
  const img = decodePng(readFileSync(f.png));
  for (const h of f.heroes) {
    if (h.alive !== false || !(h.respawnSec! > 0)) continue;
    const x = h.slot < 5 ? tb.radiantX + h.slot * tb.step : tb.direX + (h.slot - 5) * tb.step;
    const [tx, ty, tw, th] = tb.timer;
    const seg = segment(crop(img, { x: x + tx, y: ty, w: tw, h: th }), { mode: 'white' });
    if (!seg.hasText || seg.truncated) continue;
    const digits = seg.glyphs.map((g) => classify(model, g).ch).join('');
    const diff = (t: string) => (t.length !== digits.length ? Infinity : [...t].filter((c, k) => c !== digits[k]).length);
    const scored = [h.respawnSec! + 1, h.respawnSec! + 2].map(String).map((t) => ({ t, d: diff(t) }));
    const best = Math.min(...scored.map((s) => s.d));
    const winners = scored.filter((s) => s.d === best);
    if (best > 1 || winners.length !== 1) continue;
    const truth = winners[0]!.t;
    used++;
    seg.glyphs.forEach((g, k) =>
      candidates.push({
        ch: truth[k]!,
        vec: Array.from(g.vec, (v) => Math.round(v * 100) / 100),
        aspect: Math.round(g.aspect * 1000) / 1000,
        relH: Math.round(g.relH * 1000) / 1000,
        relTop: Math.round(g.relTop * 1000) / 1000,
        source: `${PREFIX}${matchId}#${basename(f.png)}[${h.slot}.${k}]`,
      }),
    );
  }
}
const added: GlyphSample[] = [];
for (const ch of [...new Set(candidates.map((c) => c.ch))].sort()) {
  const pool = candidates.filter((c) => c.ch === ch);
  const near = pool.map((c) => Math.min(Infinity, ...model.samples.filter((s) => s.ch === ch).map((s) => glyphDistance(c, s))));
  for (let n = 0; n < perChar && pool.length > 0; n++) {
    let best = 0;
    for (let j = 1; j < pool.length; j++) if (near[j]! > near[best]!) best = j;
    if (!(near[best]! > 0)) break;
    const pick = pool[best]!;
    added.push(pick);
    pool.splice(best, 1);
    near.splice(best, 1);
    for (let j = 0; j < pool.length; j++) near[j] = Math.min(near[j]!, glyphDistance(pool[j]!, pick));
  }
}
model.samples.push(...added);
model.trainedAt = new Date().toISOString();
writeFileSync(modelFile, JSON.stringify(model));
const byCh: Record<string, number> = {};
for (const a of added) byCh[a.ch] = (byCh[a.ch] ?? 0) + 1;
console.log(`Матч ${matchId}: кадров со смертями ${frames.length}, таймеров взято ${used}, добавлено образцов ${added.length}`, byCh);
