import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Проверки ИИ на настоящей локальной модели (npm run ai:eval, npm run ai:bench): долго, на CI не запускаются.
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
    },
  },
  test: {
    include: [process.env.DOTACOACH_AI_TEST ?? 'tests/ai/**/*.eval.ts'],
    environment: 'node',
    testTimeout: 60 * 60_000,
    hookTimeout: 30 * 60_000,
    fileParallelism: false,
  },
});
