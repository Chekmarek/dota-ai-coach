// Польза предупреждения о смерти (docs/WARNING_WINDOW.md): «ещё можно уйти» за L с до смерти (ESC-таблица
// tests/unit/window-why.test.ts → .tmp/esc.json; нет файла — встроенная, замер 2026-10-20) и время реакции 2 с.
// Предупреждение за L с спасает с вероятностью ESC(min(L, 20) − 2). То же считает scripts/window-report.mjs.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ESC_BUILTIN: Record<'normal' | 'turbo', [number, number][]> = {
  normal: [[0, 0], [1, 3], [2, 6], [3, 10], [4, 16], [5, 22], [6, 27], [7, 34], [8, 39], [10, 49], [12, 54], [15, 64], [20, 73]],
  turbo: [[0, 0], [1, 0], [2, 2], [3, 5], [4, 9], [5, 13], [6, 14], [7, 21], [8, 25], [10, 36], [12, 48], [15, 62], [20, 67]],
};
export const REACTION_SEC = 2;

function escTables(): Record<'normal' | 'turbo', [number, number][]> {
  const f = join(import.meta.dirname, '../../.tmp/esc.json');
  try {
    const j = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : null;
    if (j?.normal?.length && j?.turbo?.length) return { normal: j.normal, turbo: j.turbo };
  } catch {
    // встроенная
  }
  return ESC_BUILTIN;
}
const ESC = escTables();

/** Вероятность, что предупреждение за lead с до смерти спасает игрока */
export function warnValue(mode: 'normal' | 'turbo', lead: number): number {
  const x = Math.min(20, lead) - REACTION_SEC;
  const t = ESC[mode];
  if (x <= 0) return 0;
  for (let i = 1; i < t.length; i++) if (x <= t[i]![0]) return (t[i - 1]![1] + ((x - t[i - 1]![0]) / (t[i]![0] - t[i - 1]![0])) * (t[i]![1] - t[i - 1]![1])) / 100;
  return t.at(-1)![1] / 100;
}
