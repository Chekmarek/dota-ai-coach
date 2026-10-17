import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../scripts/png.mjs';
import { frameAccessFromImage } from '../../src/core/vision/image.ts';
import { recognizeHud } from '../../src/core/vision/recognize-hud.ts';
import { abilitySlotCount, readCooldown } from '../../src/core/vision/abilities.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';

const ROOT = join(import.meta.dirname, '../..');
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const layout: HudLayout = json('src/data/hud-layouts/dota2-default-16x9.json');
const model: GlyphModel = json('src/data/hud-layouts/glyphs-default.json');
const cooldownModel: GlyphModel = json('src/data/hud-layouts/glyphs-cooldown.json');
const CD = join(ROOT, 'tests/fixtures/cooldown');
const HUD = join(ROOT, 'tests/fixtures/hud');

describe('способности', () => {
  it('число ячеек зависит от ширины панели (ступень 29 px)', () => {
    expect(abilitySlotCount(667, 1920)).toBe(6);
    expect(abilitySlotCount(696, 1920)).toBe(5);
    expect(abilitySlotCount(638, 1920)).toBe(7);
  });

  it('секунды перезарядки: все подписанные иконки, ни одной ошибки', () => {
    const labels: { frames: { file: string; cooldown: string; split: string }[] } = json('tests/fixtures/cooldown/labels.json');
    const errors: string[] = [];
    let ok = 0;
    for (const fr of labels.frames) {
      const r = readCooldown(decodePng(readFileSync(join(CD, fr.file))), cooldownModel);
      if (r.value === null) continue;
      if (String(r.value) === fr.cooldown) ok++;
      else errors.push(`${fr.file}: ${r.value} ≠ ${fr.cooldown}`);
    }
    expect(errors).toEqual([]);
    expect(ok / labels.frames.length).toBeGreaterThanOrEqual(0.95);
  });

  const states = (file: string) => {
    const r = recognizeHud(frameAccessFromImage(decodePng(readFileSync(join(HUD, file)))), layout, model, 0, { cooldownModel });
    return r.abilities?.map((a) => `${a.state}${a.cooldown !== null ? `:${a.cooldown}` : ''}/${a.level}`);
  };

  it.skipIf(!existsSync(join(HUD, 'game4/v5-t030.png')))('Shadow Fiend 20:02: D на перезарядке 4 с, у R две точки уровня', () => {
    expect(states('game4/v5-t030.png')).toEqual(['ready/4', 'ready/4', 'ready/4', 'cooldown:4/4', 'ready/4', 'ready/2']);
  });

  it.skipIf(!existsSync(join(HUD, 'v1-t01.png')))('Kez: яркая иконка с белыми бликами — не перезарядка', () => {
    expect(states('v1-t01.png')).toEqual(['cooldown:10/4', 'cooldown:7/4', 'ready/4', 'ready/0', 'unlearned/0', 'cooldown:27/3']);
  });

  it.skipIf(!existsSync(join(HUD, 'v3-t01.png')))('Monkey King: бирюзовая иконка — не «нет маны»', () => {
    expect(states('v3-t01.png')?.every((s) => s.startsWith('ready'))).toBe(true);
  });

  // Панель из 4 крупных ячеек (край 712), Hero Demo 2026-10-17; эталон — по вырезам ячеек.
  // Белое лезвие Queen of Pain и вихрь Juggernaut — не перезарядка; синие иконки при нехватке маны — «нет маны»
  const WIDE: [string, string[]][] = [
    ['ab-jugg-1.png', ['ready/1', 'ready/1', 'unlearned/0', 'unlearned/0']],
    ['ab-jugg-2.png', ['cooldown:21/1', 'cooldown:53/1', 'unlearned/0', 'unlearned/0']],
    ['ab-qop-1.png', ['ready/1', 'ready/1', 'ready/1', 'unlearned/0']],
    ['ab-qop-4.png', ['ready/1', 'cooldown:1/1', 'ready/1', 'unlearned/0']],
    ['ab-qop-7.png', ['no-mana/1', 'no-mana/1', 'cooldown:1/1', 'unlearned/0']],
    ['ab-qop-8.png', ['no-mana/1', 'ready/1', 'no-mana/1', 'unlearned/0']],
    ['ab-qop-10.png', ['ready/4', 'ready/4', 'ready/4', 'no-mana/3']],
    ['ab-qop-11.png', ['ready/4', 'ready/4', 'ready/4', 'cooldown:70/3']],
  ];
  for (const [file, want] of WIDE)
    it.skipIf(!existsSync(join(HUD, file)))(`4 крупные ячейки: ${file}`, () => {
      expect(states(file)).toEqual(want);
    });

  // Отложенная проверка: белая молния Anti-Mage (готова) и перезарядка на светлой иконке E у Zeus неотличимы —
  // такие ячейки отдаются с уверенностью 0 (модель матча их не принимает), но не как неверный ответ
  const confident = (file: string) =>
    recognizeHud(frameAccessFromImage(decodePng(readFileSync(join(HUD, file)))), layout, model, 0, { cooldownModel }).abilities?.map((a) =>
      a.confidence >= 0.5 ? `${a.state}${a.cooldown !== null ? `:${a.cooldown}` : ''}` : '?',
    );
  it.skipIf(!existsSync(join(HUD, 'h2-am-1.png')))('4 крупные ячейки: молния Anti-Mage — не перезарядка «4»', () => {
    expect(confident('h2-am-1.png')?.[1]).toBe('?');
  });
  it.skipIf(!existsSync(join(HUD, 'h3-zeus-1.png')))('4 крупные ячейки: перезарядка на светлой иконке Zeus — «не знаю», а не «готова»', () => {
    expect(confident('h3-zeus-1.png')).toEqual(['?', '?', '?', 'cooldown:122']);
  });
});
