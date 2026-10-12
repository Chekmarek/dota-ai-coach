// Печатает способности (состояние, перезарядка, уровень) для кадров:  node scripts/abilities.ts <кадр.png> [...]
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from './png.mjs';
import { frameAccessFromImage } from '../src/core/vision/image.ts';
import { recognizeHud } from '../src/core/vision/recognize-hud.ts';
import type { HudLayout } from '../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../src/core/ocr/glyph-ocr.ts';

const root = join(import.meta.dirname, '..');
const layout: HudLayout = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const model: GlyphModel = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/glyphs-default.json'), 'utf8'));
const cooldownModel: GlyphModel = JSON.parse(readFileSync(join(root, 'src/data/hud-layouts/glyphs-cooldown.json'), 'utf8'));
const SHORT = { ready: 'готова', cooldown: 'перезарядка', 'no-mana': 'нет маны', unlearned: 'не изучена' } as const;
for (const f of process.argv.slice(2)) {
  const r = recognizeHud(frameAccessFromImage(decodePng(readFileSync(f))), layout, model, 0, { cooldownModel });
  const cells = r.abilities?.map((a) => `${SHORT[a.state]}${a.cooldown !== null ? ` ${a.cooldown}с` : ''} ур${a.level}`) ?? ['панель не найдена'];
  console.log(`${f.split(/[\\/]/).slice(-2).join('/')}: ${cells.join(' | ')}`);
}
