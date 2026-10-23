import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FrameRecordWriter, RECORD_GSI_MAX_AGE_MS } from '../../src/main/dev/frame-records';
import { applySettingsPatch, defaultSettings, settingsPatchSchema, settingsSchema } from '../../src/shared/schemas/settings';

const spectator = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/gsi/spectator.json'), 'utf8'));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const T = new Date(2026, 9, 23, 18, 4, 9, 500).getTime();
const frame = (wallMs: number, crops = true) => ({
  png: PNG,
  minimap: crops ? PNG : null,
  topBar: crops ? PNG : null,
  width: 2560,
  height: 1440,
  wallMs,
  diag: { sourceFrame: { width: 2560, height: 1440 }, visionFrame: { width: 1920, height: 1080 } },
  host: { windowClient: { x: 0, y: 0, width: 2560, height: 1440 }, display: { scaleFactor: 1.25 } },
});

describe('отладочная запись кадров («Живая игра» → «Записывать кадры»)', () => {
  it('кадр, вырезки и замеры в папке записи; ников и steamid в GSI нет', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-'));
    const w = new FrameRecordWriter(dir);
    w.noteGsi(spectator, T - 300);
    const png = w.save(frame(T))!;
    expect(png).toMatch(/2026-10-23_180409[\\/]00001\.png$/);
    const names = readdirSync(join(dir, '2026-10-23_180409')).sort();
    expect(names).toEqual(['00001-minimap.png', '00001-topbar.png', '00001.json', '00001.png']);
    const text = readFileSync(png.replace(/\.png$/, '.json'), 'utf8');
    const meta = JSON.parse(text);
    expect(meta).toMatchObject({ format: 1, frame: '00001', width: 2560, height: 1440, gsiAgeMs: 300 });
    expect(meta.capture.visionFrame).toEqual({ width: 1920, height: 1080 });
    expect(meta.host.display.scaleFactor).toBe(1.25);
    expect(text).not.toMatch(/Ник игрока|steamid|accountid|7656119|provider/);
  });

  it('без вырезок и со старым GSI — только кадр и замеры; выключение начинает новую папку', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fr-'));
    const w = new FrameRecordWriter(dir);
    w.noteGsi(spectator, T - RECORD_GSI_MAX_AGE_MS - 1);
    const first = w.save(frame(T, false))!;
    expect(JSON.parse(readFileSync(first.replace(/\.png$/, '.json'), 'utf8')).gsi).toBeNull();
    expect(w.save(frame(T + 2000, false))).toMatch(/00002\.png$/);
    w.endSession();
    expect(w.save(frame(T + 60_000, false))).toMatch(/2026-10-23_180509[\\/]00001\.png$/);
  });

  it('настройка: по умолчанию выключена, старый settings.json без поля читается, патч из интерфейса проходит', () => {
    expect(defaultSettings().live.recordFrames).toBe(false);
    const old = settingsSchema.parse({ live: { autoStart: false, fps: 5, overlay: true, overlayCorner: 'top-left' } });
    expect(old.live).toMatchObject({ autoStart: false, fps: 5, recordFrames: false });
    const patch = settingsPatchSchema.parse({ live: { recordFrames: true } });
    expect(applySettingsPatch(defaultSettings(), patch).live.recordFrames).toBe(true);
    expect(settingsSchema.parse({ live: { recordFrames: 'да' } }).live.recordFrames).toBe(false);
  });
});
