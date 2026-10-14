import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
    },
  },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    // Бенчмарк скорости зрения — отдельно (npm run bench): среди параллельных тестов время завышено вдвое
    exclude: process.env.DOTACOACH_BENCH ? [] : ['tests/unit/vision-bench.test.ts', '**/node_modules/**'],
    environment: 'node',
  },
});
