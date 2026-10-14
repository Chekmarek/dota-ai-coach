// Набор кадров для проверки зрения (только для разработчика, DOTACOACH_DEV=1; см. docs/VISION_DATASET.md).
// Кадр живого захвата (PNG) сохраняется вместе с последним телом GSI наблюдателя: в режиме наблюдателя (просмотр
// записи в клиенте Dota) GSI сообщает положение, здоровье, уровень и смерть всех 10 героев — это разметка кадра.
//   <папка данных>/vision-dataset/<ГГГГ-ММ-ДД>/<ЧЧММСС-ммм>-<номер>.png + .json
// Ники и steamid из тела вырезаются (как в записи сессий). Сами кадры могут содержать ники на экране —
// поэтому набор лежит только в папке данных и в репозиторий не попадает.
// Без Electron — модуль проверяется unit-тестами.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseSpectatorGsi, type SpectatorReading } from '@core/gsi/spectator.ts';
import { sanitizeGsiBody } from '../gsi/recorder';

/** Тело GSI старше этого (мс) к кадру не прикладывается: разметка была бы для другого момента */
export const MAX_GSI_AGE_MS = 1000;
/** Не больше стольких кадров в папке одного дня (≈ 3–4 МБ на кадр 1920×1080) */
export const MAX_FRAMES_PER_DAY = 5000;

export interface DatasetFrameMeta {
  /** Версия формата файла .json */
  format: 1;
  wallMs: number;
  width: number;
  height: number;
  /** Сколько мс между телом GSI и кадром; null — свежего тела не было */
  gsiAgeMs: number | null;
  /** Разобранная разметка (все 10 героев); null — не режим наблюдателя или GSI нет */
  spectator: SpectatorReading | null;
  /** Тело GSI без ников, steamid, provider и auth; null — не было свежего тела */
  body: Record<string, unknown> | null;
}

const pad = (n: number, w = 2) => String(n).padStart(w, '0');
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const stamp = (ms: number) => {
  const d = new Date(ms);
  return `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${pad(d.getMilliseconds(), 3)}`;
};

export class VisionDatasetWriter {
  private lastBody: { body: Record<string, unknown>; wallMs: number } | null = null;
  private seq = 0;
  private dayDir: string | null = null;
  private dayCount = 0;

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Каждое тело GSI (из приёмника) — запоминается последнее */
  noteGsi(body: Record<string, unknown>, wallMs: number): void {
    this.lastBody = { body, wallMs };
  }

  /**
   * Сохраняет кадр и разметку. Возвращает путь к PNG или null (предел дня, ошибка записи).
   * Кадр без свежего тела GSI тоже сохраняется (spectator: null) — он пригодится для проверки на ложные срабатывания.
   */
  save(png: Uint8Array, width: number, height: number, wallMs: number): string | null {
    try {
      const dir = join(this.dir, day(wallMs));
      if (dir !== this.dayDir) {
        mkdirSync(dir, { recursive: true });
        this.dayDir = dir;
        this.dayCount = readdirSync(dir).filter((f) => f.endsWith('.png')).length;
      }
      if (this.dayCount >= MAX_FRAMES_PER_DAY) return null;
      const fresh = this.lastBody && Math.abs(wallMs - this.lastBody.wallMs) <= MAX_GSI_AGE_MS ? this.lastBody : null;
      const meta: DatasetFrameMeta = {
        format: 1,
        wallMs,
        width,
        height,
        gsiAgeMs: fresh ? wallMs - fresh.wallMs : null,
        spectator: fresh ? parseSpectatorGsi(fresh.body) : null,
        body: fresh ? sanitizeGsiBody(fresh.body) : null,
      };
      const base = join(dir, `${stamp(wallMs)}-${pad(++this.seq, 5)}`);
      writeFileSync(`${base}.png`, png);
      writeFileSync(`${base}.json`, JSON.stringify(meta));
      this.dayCount++;
      return `${base}.png`;
    } catch (err) {
      this.log(`набор кадров: запись не удалась: ${(err as Error).message}`);
      return null;
    }
  }
}
