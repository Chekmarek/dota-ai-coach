// Запись сессий GSI: <папка данных>/gsi-sessions/<ГГГГ-ММ-ДД>.jsonl, по строке на запрос:
// {"t": <мс Unix>, "body": {...}}. Ники, steamid/accountid, блоки provider и auth вырезаются.
// Хранятся последние KEEP_FILES файлов. Нужны для разбора матчей и тестов без Dota (npm run gsi:replay).
// Без Electron — модуль проверяется unit-тестами.
import { appendFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const KEEP_FILES = 20;
const FILE_RE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
/** Ключи, которые удаляются на любом уровне: идентификаторы аккаунтов */
const ID_KEYS = new Set(['steamid', 'accountid', 'account_id', 'personaname']);

/**
 * Копия тела без личных данных: нет provider и auth, нет ников (name внутри player — в режиме наблюдателя
 * там вложенные игроки), нет steamid/accountid нигде.
 */
export function sanitizeGsiBody(body: Record<string, unknown>): Record<string, unknown> {
  const strip = (v: unknown, inPlayer: boolean): unknown => {
    if (Array.isArray(v)) return v.map((x) => strip(x, inPlayer));
    if (v === null || typeof v !== 'object') return v;
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
      if (ID_KEYS.has(k.toLowerCase())) continue;
      if (inPlayer && k === 'name') continue;
      out[k] = strip(x, inPlayer || k === 'player');
    }
    return out;
  };
  const { provider: _p, auth: _a, ...rest } = body;
  return strip(rest, false) as Record<string, unknown>;
}

function dayStamp(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class SessionRecorder {
  private currentFile: string | null = null;
  private failed = false;

  constructor(
    private readonly dir: string,
    private readonly log: (line: string) => void = () => undefined,
  ) {}

  /** Дописывает запрос в файл текущего дня (локальное время) */
  record(body: Record<string, unknown>, wallMs: number): void {
    try {
      const file = join(this.dir, `${dayStamp(wallMs)}.jsonl`);
      if (file !== this.currentFile) {
        mkdirSync(this.dir, { recursive: true });
        this.currentFile = file;
        appendFileSync(file, '', 'utf8');
        this.prune();
      }
      appendFileSync(file, `${JSON.stringify({ t: wallMs, body: sanitizeGsiBody(body) })}\n`, 'utf8');
      this.failed = false;
    } catch (err) {
      // Запись не должна мешать коучу; в журнал — один раз до следующей удачной записи
      if (!this.failed) this.log(`gsi запись сессии не удалась: ${(err as Error).message}`);
      this.failed = true;
    }
  }

  /** Оставляет последние KEEP_FILES файлов (по дате в имени) */
  prune(): void {
    let files: string[];
    try {
      files = readdirSync(this.dir).filter((f) => FILE_RE.test(f)).sort();
    } catch {
      return;
    }
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_FILES))) rmSync(join(this.dir, f), { force: true });
  }
}
