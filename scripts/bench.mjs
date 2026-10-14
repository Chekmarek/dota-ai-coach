// Бенчмарк скорости зрения отдельно от остальных тестов (среди параллельных тестов время завышено):
//   npm run bench
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const vitest = join(root, 'node_modules/vitest/vitest.mjs');
const r = spawnSync(process.execPath, [vitest, 'run', 'tests/unit/vision-bench.test.ts', '--reporter=verbose'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, DOTACOACH_BENCH: '1' },
});
process.exit(r.status ?? 1);
