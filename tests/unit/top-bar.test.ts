import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodePng } from '../../scripts/png.mjs';
import { crop, type FrameAccess, type RgbaImage } from '../../src/core/vision/image.ts';
import { readTopBar, type PortraitTemplates } from '../../src/core/vision/top-bar.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';

const ROOT = join(import.meta.dirname, '../..');
const data = (f: string) => JSON.parse(readFileSync(join(ROOT, 'src/data', f), 'utf8'));
const layout: HudLayout = data('hud-layouts/dota2-default-16x9.json');
const model: GlyphModel = data('hud-layouts/glyphs-default.json');
const portraits: PortraitTemplates = data('hero-portraits.json');

/** Кадр 1920×1080, в который вставлена полоса верхней панели (x 540, y 0) — остальное чёрное */
function frameWithStrip(file: string, w = 1920, h = 1080): FrameAccess {
  const strip = decodePng(readFileSync(join(ROOT, 'tests/fixtures/topbar', file)));
  const full: RgbaImage = { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
  for (let y = 0; y < strip.height; y++) full.data.set(strip.data.subarray(y * strip.width * 4, (y + 1) * strip.width * 4), (y * w + 540) * 4);
  return { width: w, height: h, read: (r) => crop(full, r) };
}

// Полосы вырезаны из настоящих кадров набора 2026-10-14 (tests/fixtures/topbar/README.md)
describe('верхняя панель: герои, смерть, таймер', () => {
  it('мёртвый герой: серый портрет и таймер возрождения', () => {
    const r = readTopBar(frameWithStrip('dead-timer.png'), layout, portraits, model);
    expect(r.supported).toBe(true);
    expect(r.slots.map((s) => s.heroKey)).toEqual(['spirit_breaker', 'ember_spirit', 'techies', 'shredder', 'sven', 'necrolyte', 'earth_spirit', 'meepo', 'rubick', 'ringmaster']);
    expect(r.slots[8]).toMatchObject({ team: 'dire', alive: false, respawnSec: 32 });
    // Necrolyte по GSI уже мёртв, но на кадре портрет ещё цветной и таймера нет — читаем то, что видно
    expect(r.slots.filter((s) => s.slot !== 8).every((s) => s.alive === true && s.respawnSec === null)).toBe(true);
  });

  it('все живы; другой облик героя (Nevermore) узнаётся по облику из файлов игры', () => {
    const r = readTopBar(frameWithStrip('all-alive.png'), layout, portraits, model);
    expect(r.slots.map((s) => s.heroKey)).toEqual(['mirana', 'necrolyte', 'dark_willow', 'nevermore', 'sven', 'winter_wyvern', 'hoodwink', 'lycan', 'ember_spirit', 'muerta']);
    expect(r.slots.every((s) => s.alive === true && s.respawnSec === null)).toBe(true);
  });

  it('своя команда из GSI: союзники и враги; без неё — не различаем', () => {
    const f = frameWithStrip('all-alive.png');
    const dire = readTopBar(f, layout, portraits, model, { ourTeam: 'dire' });
    expect(dire.slots.map((s) => s.side)).toEqual([...Array(5).fill('enemy'), ...Array(5).fill('ally')]);
    expect(readTopBar(f, layout, portraits, model).slots.every((s) => s.side === null)).toBe(true);
  });

  it('тёмная панель (до горна) — ни героя, ни «жив/мёртв»', () => {
    const black: RgbaImage = { width: 1920, height: 1080, data: new Uint8ClampedArray(1920 * 1080 * 4) };
    const r = readTopBar({ width: 1920, height: 1080, read: (x) => crop(black, x) }, layout, portraits, model);
    expect(r.slots).toHaveLength(10);
    expect(r.slots.every((s) => s.heroKey === null && s.alive === null && s.respawnSec === null)).toBe(true);
  });

  it('кадр не 16:9 — «не поддерживается», а не пустая панель', () => {
    const r = readTopBar(frameWithStrip('all-alive.png', 1920, 1200), layout, portraits, model);
    expect(r).toMatchObject({ supported: false, slots: [] });
  });

  it('шаблоны: 127 героев и их облики из файлов игры, без картинок', () => {
    expect(portraits.heroes.filter((h) => !h.variant)).toHaveLength(127);
    // Облики (арканы, персоны) — из файлов игры, не выучены с кадров набора: проверка на наборе честная
    expect(portraits.heroes.filter((h) => h.variant).every((h) => h.variant!.startsWith('game:'))).toBe(true);
    expect(portraits.heroes.some((h) => h.key === 'nevermore' && h.variant)).toBe(true);
    expect(portraits.grid).toEqual([14, 5]);
  });
});
