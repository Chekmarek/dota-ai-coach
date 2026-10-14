// Режим разработчика (DOTACOACH_DEV=1): запись набора кадров для проверки зрения.
// Без DOTACOACH_DEV=1 ничего не регистрируется и не пишется, даже если настройка включена.
import { ipcMain } from 'electron';
import { join } from 'node:path';
import { LIVE_IPC, type DatasetConfig } from '@shared/ipc';
import type { Settings } from '@shared/schemas/settings';
import { isLiveEngine, liveLog } from '../live/live';
import { VisionDatasetWriter } from './vision-dataset';

export const DEV_MODE = process.env.DOTACOACH_DEV === '1';

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** Кадр больше этого (байт) не принимаем: 3840×2160 PNG без сжатия ≈ 33 МБ */
const MAX_PNG_BYTES = 40 * 1024 * 1024;

export interface DevDataset {
  /** Тело GSI из приёмника — для разметки следующего кадра */
  noteGsi(body: Record<string, unknown>, wallMs: number): void;
  /** Что сообщить движку (по текущим настройкам) */
  config(settings: Settings): DatasetConfig;
}

export function setupDevDataset(dataDir: string, getSettings: () => Settings): DevDataset {
  if (!DEV_MODE) return { noteGsi: () => undefined, config: () => ({ everyN: 0 }) };
  const writer = new VisionDatasetWriter(join(dataDir, 'vision-dataset'), (line) => liveLog(line));
  let saved = 0;
  ipcMain.on(LIVE_IPC.datasetFrame, (e, arg: unknown) => {
    if (!isLiveEngine(e.sender) || !getSettings().dev.datasetRecord) return;
    const f = arg as { png?: unknown; width?: unknown; height?: unknown; wallMs?: unknown };
    if (!(f?.png instanceof ArrayBuffer) || f.png.byteLength > MAX_PNG_BYTES) return;
    const png = new Uint8Array(f.png);
    if (!PNG_SIGNATURE.every((b, i) => png[i] === b)) return;
    const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 10_000 ? v : null);
    const width = int(f.width);
    const height = int(f.height);
    const wallMs = typeof f.wallMs === 'number' && Number.isFinite(f.wallMs) ? f.wallMs : Date.now();
    if (!width || !height) return;
    if (writer.save(png, width, height, wallMs) && ++saved % 100 === 1) liveLog('набор кадров', { saved });
  });
  return {
    noteGsi: (body, wallMs) => writer.noteGsi(body, wallMs),
    config: (s) => ({ everyN: s.dev.datasetRecord ? s.dev.datasetEveryN : 0 }),
  };
}
