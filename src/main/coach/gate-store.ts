// Память фильтра внимания между матчами: «не нужно» по типам подсказок и локальные метрики (показана / выполнена /
// проигнорирована). Один файл <папка данных>/coach-gate.json, в сеть ничего не уходит.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { GateMemoryState } from '@core/gate/index.ts';

const count = z.number().int().min(0).max(1e9).catch(0);
const schema = z.object({
  version: z.literal(1),
  mutes: z.record(z.string().max(80), z.array(z.string().max(80)).max(20)).catch({}),
  metrics: z.record(z.string().max(80), z.object({ shown: count, acted: count, ignored: count, muted: count, unclear: count })).catch({}),
});

export class GateStore {
  readonly file: string;

  constructor(dataDir: string) {
    this.file = join(dataDir, 'coach-gate.json');
  }

  /** Испорченный или чужой файл — как будто его нет (начать с чистой памяти) */
  load(): GateMemoryState | null {
    if (!existsSync(this.file)) return null;
    try {
      const r = schema.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return r.success ? r.data : null;
    } catch {
      return null;
    }
  }

  save(s: GateMemoryState): void {
    writeFileSync(`${this.file}.tmp`, JSON.stringify(s, null, 1), 'utf8');
    renameSync(`${this.file}.tmp`, this.file);
  }
}
