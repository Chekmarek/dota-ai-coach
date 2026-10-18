// «История советов»: по файлу на матч в <папка данных>/history/ — показанные подсказки, ошибки, разборы смерти
// и матча. Ники, steamid и ключи сюда не попадают (их нет в данных движка). Хранятся последние MAX_FILES матчей.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { HistoryMatch, HistorySummary } from '@shared/types/history';
import { asGameModeInfo } from '@core/gsi/mode.ts';

export const MAX_FILES = 50;
const SAFE_ID = /^[0-9A-Za-z_-]{1,80}$/;

export class HistoryStore {
  private readonly dir: string;

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'history');
  }

  save(m: HistoryMatch): void {
    if (!SAFE_ID.test(m.id)) return;
    mkdirSync(this.dir, { recursive: true });
    const file = join(this.dir, `${m.id}.json`);
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify(m), 'utf8');
    renameSync(tmp, file);
    this.prune();
  }

  list(): HistorySummary[] {
    if (!existsSync(this.dir)) return [];
    const out: HistorySummary[] = [];
    for (const f of readdirSync(this.dir).filter((x) => x.endsWith('.json')).sort().reverse()) {
      try {
        const m = JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as HistoryMatch;
        out.push({ id: m.id, startedAt: m.startedAt, heroName: m.heroName, gameMode: asGameModeInfo(m.gameMode), result: m.result, durationSec: m.durationSec, hints: m.entries.filter((e) => e.kind === 'hint').length, mistakes: m.mistakes.length, deaths: m.deathReviews.length });
      } catch {
        // испорченный файл пропускаем
      }
    }
    return out;
  }

  /** Последние n матчей целиком (новые — первыми) — для профиля игрока */
  recent(n: number): HistoryMatch[] {
    if (!existsSync(this.dir)) return [];
    const out: HistoryMatch[] = [];
    for (const f of readdirSync(this.dir).filter((x) => x.endsWith('.json')).sort().reverse()) {
      if (out.length >= n) break;
      try {
        out.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as HistoryMatch);
      } catch {
        // испорченный файл пропускаем
      }
    }
    return out;
  }

  get(id: string): HistoryMatch | null {
    if (!SAFE_ID.test(id)) return null;
    const file = join(this.dir, `${id}.json`);
    if (!existsSync(file)) return null;
    try {
      return JSON.parse(readFileSync(file, 'utf8')) as HistoryMatch;
    } catch {
      return null;
    }
  }

  private prune(): void {
    const files = readdirSync(this.dir).filter((x) => x.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - MAX_FILES))) rmSync(join(this.dir, f), { force: true });
  }
}
