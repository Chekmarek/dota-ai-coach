// Кэш признаков для обучения (DECISIONS.md п. 70): стенд экзамена (GSI + зрение → снимок коуча → признаки) считается
// один раз на героя матча, повторные обучения читают .tmp/features-<вид>-<версия>/<ключ>.bin (gzip JSON).
// Версия — хэш набора признаков и исходников всего, от чего признаки зависят (src/core, движок GSI, стенд экзамена)
// и файлов моделей, которые входят в признаки (риск опасности в модели драк). Изменили признак, стенд или модель —
// другая версия, старый кэш не читается. DOTACOACH_NO_FEATURE_CACHE=1 — считать заново.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '../..');

function walk(dir: string, out: string[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(ts|json)$/.test(e.name)) out.push(p);
  }
}

/** Версия кэша: признаки + исходники (src/core, src/engine/gsi.ts, стенд) + дополнительные файлы (модели) */
export function featureVersion(features: readonly string[], extraFiles: readonly string[] = []): string {
  const files: string[] = [];
  walk(join(root, 'src/core'), files);
  files.push(join(root, 'src/engine/gsi.ts'), join(root, 'tests/unit/exam-lib.ts'), ...extraFiles.map((f) => join(root, f)));
  const h = createHash('sha1').update(features.join(','));
  for (const f of files) if (existsSync(f) && statSync(f).isFile()) h.update(f.slice(root.length).replace(/\\/g, '/')).update(readFileSync(f));
  return h.digest('hex').slice(0, 12);
}

/**
 * Отпечаток данных матча для ключа кэша: размер файла матча и файла инвентаря (inv/). Докачали инвентарь — другой
 * ключ, признаки посчитаются заново.
 */
export function dataStamp(matchFile: string): string {
  const inv = join(matchFile, '..', 'inv', matchFile.split(/[\\/]/).pop()!);
  return `${statSync(matchFile).size.toString(36)}${existsSync(inv) ? `i${statSync(inv).size.toString(36)}` : ''}`;
}

export class FeatureCache {
  readonly dir: string;
  hits = 0;
  misses = 0;
  constructor(kind: string, version: string) {
    this.dir = join(root, '.tmp', `features-${kind}-${version}`);
    mkdirSync(this.dir, { recursive: true });
  }
  get<T>(key: string, compute: () => T): T {
    const file = join(this.dir, `${key}.bin`);
    if (!process.env.DOTACOACH_NO_FEATURE_CACHE && existsSync(file)) {
      try {
        const v = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as T;
        this.hits++;
        return v;
      } catch {
        // битый файл — считаем заново
      }
    }
    const v = compute();
    writeFileSync(file, gzipSync(JSON.stringify(v)));
    this.misses++;
    return v;
  }
}
