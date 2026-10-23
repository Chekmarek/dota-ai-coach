// Запись кадров для проверки зрения.
// 1) Набор разработчика (DOTACOACH_DEV=1): кадры + GSI наблюдателя; без DOTACOACH_DEV=1 не пишется, даже если настройка включена.
// 2) Отладочная запись «Живая игра» → «Записывать кадры» (live.recordFrames, по умолчанию выключено): раз в 2 с
//    кадр в полном разрешении, вырезки мини-карты и верхней панели и замеры захвата (frame-records.ts).
import { ipcMain } from 'electron';
import { join } from 'node:path';
import { LIVE_IPC, type DatasetConfig } from '@shared/ipc';
import type { Settings } from '@shared/schemas/settings';
import { dotaCaptureInfo, isLiveEngine, liveLog } from '../live/live';
import { VisionDatasetWriter } from './vision-dataset';
import { FrameRecordWriter } from './frame-records';

export const DEV_MODE = process.env.DOTACOACH_DEV === '1';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Кадр больше этого (байт) не принимаем: 3840×2160 PNG без сжатия ≈ 33 МБ */
const MAX_PNG_BYTES = 40 * 1024 * 1024;
/** Отладочная запись: кадр раз в столько мс */
export const RECORD_EVERY_MS = 2000;
/** Замеры движка к кадру — не больше стольких байт JSON (сводка зрения с 10 героями — несколько КБ) */
const MAX_DIAG_BYTES = 64 * 1024;

export interface DevDataset {
  /** Тело GSI из приёмника — для разметки следующего кадра */
  noteGsi(body: Record<string, unknown>, wallMs: number): void;
  /** Что сообщить движку (по текущим настройкам) */
  config(settings: Settings): DatasetConfig;
}

export function setupDevDataset(dataDir: string, getSettings: () => Settings): DevDataset {
  const writer = DEV_MODE ? new VisionDatasetWriter(join(dataDir, 'vision-dataset'), (line) => liveLog(line)) : null;
  const records = new FrameRecordWriter(join(dataDir, 'frame-records'), (line, extra) => liveLog(line, extra ?? ''));
  let saved = 0;
  const pngOf = (v: unknown): Uint8Array | null => {
    if (!(v instanceof ArrayBuffer) || v.byteLength > MAX_PNG_BYTES) return null;
    const png = new Uint8Array(v);
    return PNG_SIGNATURE.every((b, i) => png[i] === b) ? png : null;
  };
  ipcMain.on(LIVE_IPC.datasetFrame, (e, arg: unknown) => {
    if (!isLiveEngine(e.sender)) return;
    const f = arg as { png?: unknown; width?: unknown; height?: unknown; wallMs?: unknown; record?: unknown };
    const png = pngOf(f?.png);
    if (!png) return;
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10_000 ? v : null);
    const width = int(f.width);
    const height = int(f.height);
    const wallMs = typeof f.wallMs === 'number' && Number.isFinite(f.wallMs) ? f.wallMs : Date.now();
    if (!width || !height) return;
    if (f.record !== undefined) {
      if (!getSettings().live.recordFrames) return;
      const r = f.record as { minimap?: unknown; topBar?: unknown; diag?: unknown };
      let diag: Record<string, unknown> = {};
      try {
        const text = JSON.stringify(r?.diag ?? {});
        if (text.length <= MAX_DIAG_BYTES) diag = JSON.parse(text) as Record<string, unknown>;
      } catch {
        diag = {};
      }
      records.save({ png, minimap: pngOf(r?.minimap), topBar: pngOf(r?.topBar), width, height, wallMs, diag, host: dotaCaptureInfo() });
      return;
    }
    if (!writer || !getSettings().dev.datasetRecord) return;
    if (writer.save(png, width, height, wallMs) && ++saved % 100 === 1) liveLog('набор кадров', { saved });
  });
  return {
    noteGsi: (body, wallMs) => {
      writer?.noteGsi(body, wallMs);
      records.noteGsi(body, wallMs);
    },
    config: (s) => {
      if (!s.live.recordFrames) records.endSession();
      return { everyN: DEV_MODE && s.dev.datasetRecord ? s.dev.datasetEveryN : 0, recordMs: s.live.recordFrames ? RECORD_EVERY_MS : 0 };
    },
  };
}
