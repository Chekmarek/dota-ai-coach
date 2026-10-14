import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  // В CI ещё и отчёт github: упавший тест виден аннотацией в проверке (без входа в логи Actions)
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
});
