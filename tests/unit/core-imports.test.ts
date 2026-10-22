// Правило проекта (CLAUDE.md): src/core не импортирует electron, node:*, fs, path, http — ядро чистое, его гоняют
// unit-тесты и экзамены без Electron. Проверяются все импорты, в том числе динамические и require.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const CORE = join(import.meta.dirname, '../../src/core');
const FORBIDDEN = /^(electron|node:.*|fs|fs\/promises|path|http|https|net|child_process|os|worker_threads|crypto)$/;

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(ts|tsx|mts|js|mjs)$/.test(f) ? [p] : [];
  });
}

describe('src/core — без electron, node:*, fs, path, http', () => {
  it('ни одного запрещённого импорта', () => {
    const all = files(CORE);
    expect(all.length).toBeGreaterThan(50);
    const bad: string[] = [];
    for (const f of all) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)['"]([^'"]+)['"]/gm)) {
        if (FORBIDDEN.test(m[1]!)) bad.push(`${relative(CORE, f)}: ${m[1]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
