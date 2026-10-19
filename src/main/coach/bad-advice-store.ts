// Отметки «плохой совет» (горячая клавиша): файл на отметку в <папка данных>/bad-advice/<запуск коуча>/.
// Собрать все отметки сессии в один файл для разбора: node scripts/collect-bad-advice.mjs (docs/BAD_ADVICE.md).
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BadAdviceRecord } from '@core/coach/bad-advice.ts';

const SAFE = /^[0-9A-Za-z_-]{1,100}$/;
/** Сколько запусков коуча с отметками хранить */
export const MAX_SESSIONS = 30;

/** Имя папки запуска: время запуска без двоеточий и точек */
export const sessionIdOf = (startedMs: number) => new Date(startedMs).toISOString().replace(/[:.]/g, '-');

export class BadAdviceStore {
  private readonly dir: string;

  constructor(dataDir: string, readonly sessionId: string) {
    this.dir = join(dataDir, 'bad-advice');
  }

  save(r: BadAdviceRecord): void {
    if (!SAFE.test(r.id) || !SAFE.test(this.sessionId)) return;
    const dir = join(this.dir, this.sessionId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${r.id}.json`);
    writeFileSync(`${file}.tmp`, JSON.stringify(r, null, 1), 'utf8');
    renameSync(`${file}.tmp`, file);
    this.prune();
  }

  private prune(): void {
    if (!existsSync(this.dir)) return;
    const sessions = readdirSync(this.dir).filter((d) => SAFE.test(d)).sort();
    for (const d of sessions.slice(0, Math.max(0, sessions.length - MAX_SESSIONS))) rmSync(join(this.dir, d), { recursive: true, force: true });
  }
}
