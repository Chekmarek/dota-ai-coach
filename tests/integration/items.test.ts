import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../scripts/png.mjs';
import { frameAccessFromImage } from '../../src/core/vision/image.ts';
import { recognizeHud } from '../../src/core/vision/recognize-hud.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';
import type { ItemTemplates } from '../../src/core/vision/items.ts';

const ROOT = join(import.meta.dirname, '../..');
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const layout: HudLayout = json('src/data/hud-layouts/dota2-default-16x9.json');
const model: GlyphModel = json('src/data/hud-layouts/glyphs-default.json');
const itemTemplates: ItemTemplates = json('src/data/item-templates.json');
const HUD = join(ROOT, 'tests/fixtures/hud');

/** Инвентарь кадра: ключ предмета, «—» — пусто, «?» — не узнан */
const items = (file: string) =>
  recognizeHud(frameAccessFromImage(decodePng(readFileSync(join(HUD, file)))), layout, model, 0, { itemTemplates }).items?.map((i) =>
    i.empty ? '—' : (i.item?.key ?? '?'),
  );

/**
 * Эталоны проверены глазами по увеличенным вырезкам. «?» в ожидании — ячейка, где предмет активирован или
 * на перезарядке и сознательно не узнаётся; там допустим и «?», и только верный ответ, но не другой предмет.
 */
const CASES: [string, string, string[]][] = [
  ['game4/v1-t180.png', 'Shadow Fiend, начало игры', ['slippers', 'tango', 'enchanted_mango', 'circlet', '—', '—', '—', '—', '—']],
  ['game4/v5-t030.png', 'Shadow Fiend, 20:02', ['?', 'enchanted_mango', 'bottle', 'claymore', 'dragon_lance', 'boots', '?', '?', '?']],
  ['v3-t13.png', 'Morphling — инвентарь сдвинут на 30 px', ['skadi', 'manta', 'satanic', 'greater_crit', '?', 'butterfly', '—', '—', '—']],
  ['v1-t01.png', 'Kez: Aegis с таймером', ['?', 'desolator', '?', 'aegis', 'phase_boots', 'greater_crit', '—', '—', '—']],
];

describe('инвентарь', () => {
  it('одинаковые иконки объединены, рецептов нет', () => {
    const scepter = itemTemplates.items.find((t) => t.key === 'ultimate_scepter_2');
    expect(scepter?.aliases).toContain('ultimate_scepter_roshan');
    expect(itemTemplates.items.some((t) => t.key.startsWith('recipe_'))).toBe(false);
  });

  for (const [file, title, expected] of CASES) {
    it.skipIf(!existsSync(join(HUD, file)))(title, () => {
      const got = items(file)!;
      expected.forEach((e, k) => {
        if (e === '?') expect(got[k] === '?' || got[k] === '—', `${file} ячейка ${k + 1}: ${got[k]}`).toBe(true);
        else expect(got[k], `${file} ячейка ${k + 1}`).toBe(e);
      });
    });
  }
});
