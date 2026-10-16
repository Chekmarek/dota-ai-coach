import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../scripts/png.mjs';
import { frameAccessFromImage } from '../../src/core/vision/image.ts';
import { recognizeHud, type HudReading } from '../../src/core/vision/recognize-hud.ts';
import { HUD_FIELDS, type HudFieldId } from '../../src/core/vision/hud-fields.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { GlyphModel } from '../../src/core/ocr/glyph-ocr.ts';
import type { HeroNameEntry } from '../../src/core/vision/hero-name.ts';
import type { ItemTemplates } from '../../src/core/vision/items.ts';
import { MatchStateModel, type MatchState } from '../../src/core/match-state/index.ts';

const ROOT = join(import.meta.dirname, '../..');
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const layout: HudLayout = json('src/data/hud-layouts/dota2-default-16x9.json');
const model: GlyphModel = json('src/data/hud-layouts/glyphs-default.json');
const opts = {
  heroName: { model: json('src/data/hud-layouts/glyphs-heroname.json') as GlyphModel, names: json('src/data/hero-names.json').names as HeroNameEntry[] },
  cooldownModel: json('src/data/hud-layouts/glyphs-cooldown.json') as GlyphModel,
  itemTemplates: json('src/data/item-templates.json') as ItemTemplates,
};

/**
 * Последовательности настоящих кадров игры: папки в tests/fixtures/frames (кроме synthetic — это не Dota)
 * и записи пользователя в tests/fixtures/hud/game*. Кадры с никами в общий репозиторий не входят — без них тест пропускается.
 * Внутри папки кадры идут по имени; «vN-tSSS» — запись N, секунда SSS (разные записи — разные последовательности).
 */
function sequences(): { name: string; files: { path: string; wallMs: number }[] }[] {
  const dirs: string[] = [];
  const add = (base: string, keep: (d: string) => boolean) => {
    if (!existsSync(base)) return;
    for (const d of readdirSync(base)) if (keep(d) && statSync(join(base, d)).isDirectory()) dirs.push(join(base, d));
  };
  add(join(ROOT, 'tests/fixtures/frames'), (d) => d !== 'synthetic');
  add(join(ROOT, 'tests/fixtures/hud'), (d) => /^game/.test(d));
  const out = new Map<string, { path: string; wallMs: number }[]>();
  for (const dir of dirs) {
    const pngs = readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    pngs.forEach((f, i) => {
      const m = /^(v\d+)-t(\d+)/.exec(f);
      const key = `${dir}:${m ? m[1] : ''}`;
      const list = out.get(key) ?? [];
      list.push({ path: join(dir, f), wallMs: m ? Number(m[2]) * 1000 : i * 1000 });
      out.set(key, list);
    });
  }
  return [...out.entries()].map(([name, files]) => ({ name, files: files.sort((a, b) => a.wallMs - b.wallMs) })).filter((s) => s.files.length >= 3);
}

const SEQS = sequences();

type Field = Exclude<HudFieldId, 'gameClock'>;
const FIELDS = HUD_FIELDS.filter((f): f is Field => f !== 'gameClock');

function accepted(s: MatchState, id: Field): unknown {
  switch (id) {
    case 'scoreRadiant':
      return s.match.scoreRadiant.value;
    case 'scoreDire':
      return s.match.scoreDire.value;
    default:
      return s.hero[id].value;
  }
}

describe.skipIf(SEQS.length === 0)('модель состояния на настоящих кадрах', () => {
  it('принятые значения меняются не чаще, чем исходные чтения', () => {
    for (const seq of SEQS) {
      const m = new MatchStateModel();
      const rawChanges = new Map<Field, number>();
      const accChanges = new Map<Field, number>();
      const lastRaw = new Map<Field, string>();
      const lastAcc = new Map<Field, string>();
      for (const fr of seq.files) {
        const r: HudReading = recognizeHud(frameAccessFromImage(decodePng(readFileSync(fr.path))), layout, model, fr.wallMs, opts);
        m.ingest(r, fr.wallMs);
        const s = m.snapshot(fr.wallMs);
        for (const id of FIELDS) {
          const o = r.fields[id];
          if (o.validity === 'valid' && o.value !== null) {
            const v = JSON.stringify(o.value);
            if (lastRaw.has(id) && lastRaw.get(id) !== v) rawChanges.set(id, (rawChanges.get(id) ?? 0) + 1);
            lastRaw.set(id, v);
          }
          const a = accepted(s, id);
          if (a !== null) {
            const v = JSON.stringify(a);
            if (lastAcc.has(id) && lastAcc.get(id) !== v) accChanges.set(id, (accChanges.get(id) ?? 0) + 1);
            lastAcc.set(id, v);
          }
        }
      }
      for (const id of FIELDS) {
        expect(`${seq.name} ${id}: ${accChanges.get(id) ?? 0}`).toBe(`${seq.name} ${id}: ${Math.min(accChanges.get(id) ?? 0, rawChanges.get(id) ?? 0)}`);
      }
    }
    // распознавание сотен полных кадров: при наборе кадров владельца (tests/fixtures/hud) дольше 5 с
  }, 60_000);
});
