// Отладочная запись кадров для проверки зрения («Живая игра» → «Записывать кадры», по умолчанию выключено).
// В отличие от набора разработчика (vision-dataset.ts) работает без DOTACOACH_DEV=1 и пишет то, что нужно для разметки
// своей игры: кадр в полном разрешении окна (PNG без потерь), вырезки мини-карты и верхней панели и замеры захвата
// (размер окна и потока, формат кадра, масштаб Windows, настройки видео Доты, что зрение увидело в этот момент).
//   <папка данных>/frame-records/<ГГГГ-ММ-ДД_ЧЧММСС>/<номер>.png, <номер>-minimap.png, <номер>-topbar.png, <номер>.json
// На кадрах видны ники — папка остаётся только на компьютере пользователя, в репозиторий не попадает.
// Без Electron — модуль проверяется unit-тестами.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeGsiBody } from '../gsi/recorder';

/** Не больше стольких кадров за одну запись: раз в 2 с это ~1 ч 40 мин игры (кадр 1080p ≈ 3–4 МБ, всего ≈ 10 ГБ) */
export const MAX_RECORD_FRAMES = 3000;
/** Тело GSI старше этого (мс) к кадру не прикладывается */
export const RECORD_GSI_MAX_AGE_MS = 2000;

export interface RecordFrameInput {
  png: Uint8Array;
  minimap: Uint8Array | null;
  topBar: Uint8Array | null;
  width: number;
  height: number;
  wallMs: number;
  /** Замеры движка (поток, кадр, частота, что увидело зрение) */
  diag: Record<string, unknown>;
  /** Замеры main (окно Доты, монитор, video.txt) */
  host: Record<string, unknown>;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const sessionName = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

export class FrameRecordWriter {
  private sessionDir: string | null = null;
  private count = 0;
  private lastBody: { body: Record<string, unknown>; wallMs: number } | null = null;

  constructor(
    private readonly dir: string,
    private readonly log: (line: string, extra?: unknown) => void = () => undefined,
  ) {}

  /** Каждое тело GSI — запоминается последнее (свой герой: место, здоровье, время матча) */
  noteGsi(body: Record<string, unknown>, wallMs: number): void {
    this.lastBody = { body, wallMs };
  }

  /** Запись выключили — следующая начнётся в новой папке */
  endSession(): void {
    if (this.sessionDir) this.log('запись кадров: остановлена', { dir: this.sessionDir, frames: this.count });
    this.sessionDir = null;
    this.count = 0;
  }

  get currentDir(): string | null {
    return this.sessionDir;
  }

  /** Сохраняет кадр; возвращает путь к PNG или null (предел записи, ошибка диска) */
  save(f: RecordFrameInput): string | null {
    try {
      if (!this.sessionDir) {
        this.sessionDir = join(this.dir, sessionName(f.wallMs));
        mkdirSync(this.sessionDir, { recursive: true });
        this.count = 0;
        this.log('запись кадров: начата', { dir: this.sessionDir });
      }
      if (this.count >= MAX_RECORD_FRAMES) return null;
      const n = pad(++this.count, 5);
      const base = join(this.sessionDir, n);
      const fresh = this.lastBody && Math.abs(f.wallMs - this.lastBody.wallMs) <= RECORD_GSI_MAX_AGE_MS ? this.lastBody : null;
      writeFileSync(`${base}.png`, f.png);
      if (f.minimap) writeFileSync(`${base}-minimap.png`, f.minimap);
      if (f.topBar) writeFileSync(`${base}-topbar.png`, f.topBar);
      const meta = {
        format: 1,
        frame: n,
        wallMs: f.wallMs,
        width: f.width,
        height: f.height,
        capture: f.diag,
        host: f.host,
        gsiAgeMs: fresh ? f.wallMs - fresh.wallMs : null,
        gsi: fresh ? sanitizeGsiBody(fresh.body) : null,
      };
      writeFileSync(`${base}.json`, JSON.stringify(meta, null, 1));
      if (this.count === MAX_RECORD_FRAMES) this.log('запись кадров: достигнут предел', { frames: this.count });
      return `${base}.png`;
    } catch (err) {
      this.log(`запись кадров: не удалась: ${(err as Error).message}`);
      return null;
    }
  }
}
