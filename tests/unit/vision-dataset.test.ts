import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MAX_GSI_AGE_MS, VisionDatasetWriter, type DatasetFrameMeta } from '../../src/main/dev/vision-dataset';
import { applySettingsPatch, defaultSettings, settingsPatchSchema, settingsSchema } from '../../src/shared/schemas/settings';

const spectator = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/gsi/spectator.json'), 'utf8'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const T = new Date(2026, 9, 14, 12, 30, 5, 250).getTime();

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true }).map(String).sort();
}

describe('набор кадров для проверки зрения (режим разработчика)', () => {
  it('кадр + разметка из GSI наблюдателя: 10 героев, ников и steamid нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const w = new VisionDatasetWriter(dir);
    w.noteGsi(spectator, T - 200);
    const png = w.save(PNG, 1920, 1080, T)!;
    expect(png).toMatch(/2026-10-14[\\/]123005-250-00001\.png$/);
    expect(new Uint8Array(readFileSync(png))).toEqual(PNG);
    const metaText = readFileSync(png.replace(/\.png$/, '.json'), 'utf8');
    const meta = JSON.parse(metaText) as DatasetFrameMeta;
    expect(meta).toMatchObject({ format: 1, wallMs: T, width: 1920, height: 1080, gsiAgeMs: 200 });
    expect(meta.spectator!.heroes).toHaveLength(10);
    expect(meta.spectator!.heroes[0]).toMatchObject({ heroKey: 'antimage', xpos: -6000, ypos: -5500 });
    // Ники («Ник игрока N»), steamid, accountid, provider — вырезаны
    expect(metaText).not.toMatch(/Ник игрока|steamid|accountid|7656119|provider/);
    expect(metaText).toContain('npc_dota_hero_antimage');
  });

  it('устаревшее или отсутствующее тело GSI — кадр без разметки', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const w = new VisionDatasetWriter(dir);
    const a = w.save(PNG, 1280, 720, T)!;
    w.noteGsi(spectator, T);
    const b = w.save(PNG, 1280, 720, T + MAX_GSI_AGE_MS + 1)!;
    for (const p of [a, b]) {
      const meta = JSON.parse(readFileSync(p.replace(/\.png$/, '.json'), 'utf8')) as DatasetFrameMeta;
      expect(meta).toMatchObject({ gsiAgeMs: null, spectator: null, body: null });
    }
    expect(files(dir).filter((f) => f.endsWith('.png'))).toHaveLength(2);
  });

  it('тело режима игрока — разметки героев нет, тело сохраняется', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-'));
    const w = new VisionDatasetWriter(dir);
    w.noteGsi({ map: { clock_time: 10 }, hero: { name: 'npc_dota_hero_axe' } }, T);
    const meta = JSON.parse(readFileSync(w.save(PNG, 10, 10, T)!.replace(/\.png$/, '.json'), 'utf8')) as DatasetFrameMeta;
    expect(meta.spectator).toBeNull();
    expect(meta.body).toEqual({ map: { clock_time: 10 }, hero: { name: 'npc_dota_hero_axe' } });
  });

  it('настройки: по умолчанию выключено, каждый 10-й кадр; старые файлы без раздела dev читаются', () => {
    expect(defaultSettings().dev).toEqual({ datasetRecord: false, datasetEveryN: 10 });
    expect(settingsSchema.parse({ gsi: { port: 53790 } }).dev.datasetRecord).toBe(false);
    expect(settingsSchema.parse({ dev: { datasetEveryN: 0 } }).dev.datasetEveryN).toBe(10);
    const patch = settingsPatchSchema.parse({ dev: { datasetRecord: true, datasetEveryN: 5 } });
    expect(applySettingsPatch(defaultSettings(), patch).dev).toEqual({ datasetRecord: true, datasetEveryN: 5 });
    expect(settingsPatchSchema.safeParse({ dev: { datasetEveryN: 0 } }).success).toBe(false);
  });
});
