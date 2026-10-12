import { test, expect, _electron as electron } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

// Проверка уже собранной портативной версии. Запуск:
//   $env:DOTACOACH_PACKAGED_EXE="...\DotaCoach.exe"; npx playwright test packaged
const EXE = process.env.DOTACOACH_PACKAGED_EXE;
const FRAMES = resolve(import.meta.dirname, '../fixtures/frames/synthetic');

test.skip(!EXE, 'DOTACOACH_PACKAGED_EXE не задан');

test('портативная сборка: запуск, папка data рядом с exe, воспроизведение кадров', async () => {
  const app = await electron.launch({ executablePath: EXE!, args: [] });
  try {
    let ui = app.windows().find((w) => w.url().includes('/renderer/index.html'));
    for (let i = 0; !ui && i < 100; i++) {
      await new Promise((r) => setTimeout(r, 100));
      ui = app.windows().find((w) => w.url().includes('/renderer/index.html'));
    }
    expect(ui).toBeTruthy();
    const page = ui!;
    await page.waitForSelector('[data-testid="page-dashboard"]');

    const info = await page.evaluate(() => window.dotacoach.getAppInfo());
    expect(info.distribution).toBe('portable');
    expect(info.dataDir.toLowerCase()).toBe(join(resolve(EXE!, '..'), 'data').toLowerCase());

    // База знаний лежит в resources/data и должна загружаться в упакованной версии
    const kb = await page.evaluate(() => window.dotacoach.getKnowledgeBase());
    expect('error' in kb ? kb.error : kb.meta.counts.heroes).toBe(127);

    await page.evaluate(() => window.dotacoach.updateSettings({ capture: { targetFps: 10 } }));
    expect(existsSync(join(info.dataDir, 'settings.json'))).toBe(true);

    await app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
    }, FRAMES);
    await page.click('[data-testid="nav-replay"]');
    await page.click('[data-testid="pick-folder"]');
    await page.click('[data-testid="replay-start"]');
    await expect(page.locator('[data-testid="preview-img"]')).toBeVisible();
    await expect(page.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
    await page.screenshot({ path: resolve(import.meta.dirname, '../../test-results/packaged-replay.png') });
  } finally {
    await app.close();
  }
});
