import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../scripts/png.mjs';
import { frameAccessFromImage } from '../../src/core/vision/image.ts';
import { recognizeHud } from '../../src/core/vision/recognize-hud.ts';
import { HUD_FIELDS, formatHudLabel, type HudFieldId } from '../../src/core/vision/hud-fields.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';

const ROOT = join(import.meta.dirname, '../..');
const FIX = join(ROOT, 'tests/fixtures/hud');
const layout: HudLayout = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/dota2-default-16x9.json'), 'utf8'));
const model: GlyphModel = JSON.parse(readFileSync(join(ROOT, 'src/data/hud-layouts/glyphs-default.json'), 'utf8'));
// Кадры с никами игроков в общий репозиторий не входят — без них тест пропускается
const HAS_FIX = existsSync(join(FIX, 'labels.json'));
const labels = (HAS_FIX ? JSON.parse(readFileSync(join(FIX, 'labels.json'), 'utf8')) : { frames: [] }) as {
  frames: { file: string; split: 'train' | 'test'; selectedUnit?: 'ally' | 'enemy' | null; fields: Record<string, string> }[];
};

/** Приводит распознанное значение к строке в формате разметки */
const asLabel = (id: string, v: unknown) => formatHudLabel(id as HudFieldId, v);

function evaluate(split: 'train' | 'test') {
  let ok = 0, wrong = 0, missing = 0, confidentWrong = 0;
  const errors: string[] = [];
  for (const fr of labels.frames.filter((f) => f.split === split)) {
    const img = decodePng(readFileSync(join(FIX, fr.file)));
    const r = recognizeHud(frameAccessFromImage(img), layout, model, 0);
    // Чей юнит на панели: ошибиться нельзя (иначе данные врага примутся за данные игрока)
    if (fr.selectedUnit !== undefined && r.selectedUnit.value !== null && r.selectedUnit.value !== fr.selectedUnit) {
      wrong++;
      errors.push(`${fr.file} selectedUnit: ${r.selectedUnit.value} ≠ ${fr.selectedUnit}`);
    }
    for (const id of HUD_FIELDS) {
      if (fr.fields[id] === undefined) continue; // кадр подписан частично (например, только время)
      const o = r.fields[id];
      if (o.value === null) {
        missing++;
        continue;
      }
      if (asLabel(id, o.value) === fr.fields[id]) ok++;
      else {
        wrong++;
        if (o.confidence >= 0.8) confidentWrong++;
        errors.push(`${fr.file} ${id}: ${asLabel(id, o.value)} ≠ ${fr.fields[id]}`);
      }
    }
  }
  return { ok, wrong, missing, confidentWrong, errors, total: ok + wrong + missing };
}

describe.skipIf(!HAS_FIX)('распознавание HUD на кадрах из записей пользователя', () => {
  it('обучающие кадры (запись 1) распознаются полностью', () => {
    const r = evaluate('train');
    expect(r.errors).toEqual([]);
    // 95 %, а не 100 %: на кадрах мёртвого героя (посмертная окраска) опора панели ненадёжна,
    // и уровень сознательно не читается — лучше пропуск, чем значение не из той области
    expect(r.ok / r.total).toBeGreaterThanOrEqual(0.95);
  });

  it('день/ночь по значку над часами и отсчёт до горна (игра 4)', () => {
    const errors: string[] = [];
    let checked = 0, unknown = 0;
    for (const fr of labels.frames.filter((f) => f.file.startsWith('game4/'))) {
      const r = recognizeHud(frameAccessFromImage(decodePng(readFileSync(join(FIX, fr.file)))), layout, model, 0);
      const label = fr.fields.gameClock;
      if ((fr as { preHorn?: boolean }).preHorn) {
        // До горна: луна, а прочитанное время — отрицательное
        if (r.dayNight.value !== 'night') errors.push(`${fr.file}: до горна ожидалась ночь, получено ${r.dayNight.value}`);
        if (r.fields.gameClock.value !== null && r.fields.gameClock.value >= 0) errors.push(`${fr.file}: до горна время ${r.fields.gameClock.value} ≥ 0`);
        checked++;
        continue;
      }
      if (!label) continue;
      const [m, s] = label.split(':').map(Number);
      const sec = m! * 60 + s!;
      if (sec % 300 < 3 || sec % 300 > 297) continue; // на границе смены дня и ночи значок меняется не мгновенно
      const expected = Math.floor(sec / 300) % 2 === 0 ? 'day' : 'night';
      // «Не знаю» допустимо (значок перекрыт), неверный ответ — нет
      if (r.dayNight.value === null) unknown++;
      else if (r.dayNight.value !== expected) errors.push(`${fr.file} (${label}): ${r.dayNight.value} ≠ ${expected}`);
      checked++;
    }
    expect(errors).toEqual([]);
    expect(checked).toBeGreaterThan(50);
    expect(unknown / checked).toBeLessThanOrEqual(0.05);
  }, 60_000);

  it('новые кадры (запись 2, не участвовали в обучении): ни одного неверного значения, ≥ 85 % распознано', () => {
    const r = evaluate('test');
    // Главное правило: лучше «не знаю», чем неправда
    expect(r.errors).toEqual([]);
    expect(r.confidentWrong).toBe(0);
    expect(r.ok / r.total).toBeGreaterThanOrEqual(0.85);
  });
});
