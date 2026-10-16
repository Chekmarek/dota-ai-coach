// Этап 3: «Предпросмотр подсказок» и окно подсказок поверх игры (демо — без Доты).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const TMP_ROOT = join(ROOT, '.tmp/e2e-data');
const tmp = () => (mkdirSync(TMP_ROOT, { recursive: true }), mkdtempSync(join(TMP_ROOT, 'hud-')));

async function launch(dataDir: string): Promise<{ app: ElectronApplication; ui: Page }> {
  const settingsFile = join(dataDir, 'settings.json');
  if (!existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify({ live: { autoStart: false } }));
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, DOTACOACH_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', DOTACOACH_NO_UPDATE_CHECK: '1' },
  });
  let ui: Page | undefined;
  for (let i = 0; i < 100 && !ui; i++) {
    ui = app.windows().find((p) => p.url().includes('/renderer/index.html'));
    if (!ui) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ui) throw new Error('Окно интерфейса не появилось');
  await ui.waitForSelector('[data-testid="page-dashboard"]');
  return { app, ui };
}

async function hudWindow(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes('/hud/index.html'));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Окно подсказок не появилось');
}

test('предпросмотр: все виды подсказок, темы, экраны, режим расстановки', async () => {
  const { app, ui } = await launch(tmp());
  try {
    await ui.click('[data-testid="nav-hud"]');
    const stage = ui.locator('[data-testid="hud-stage"]');
    await expect(stage).toBeVisible();
    await expect(stage.locator('.hud-card')).toHaveCount(5);
    await expect(stage.locator('.hud-k-alert')).toHaveCount(1);
    await expect(stage.locator('.hud-k-decision .hud-pct-num')).toHaveText('31%');
    await expect(stage.locator('.hud-gem')).toHaveCount(5);

    await ui.selectOption('[data-testid="hud-theme"]', 'obsidian');
    await expect(stage.locator('.hud-root')).toHaveAttribute('data-theme', 'obsidian');

    await ui.selectOption('[data-testid="hud-screen"]', '21x9');
    await expect(stage).toHaveCSS('width', '3440px');
    await expect(stage.locator('.hud-card')).toHaveCount(5);

    await ui.click('[data-testid="hud-edit"]');
    for (const z of ['alert', 'decision', 'timing', 'review']) await expect(ui.locator(`[data-testid="hud-zone-${z}"]`)).toBeVisible();
    await expect(ui.locator('.hudp-bad')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

test('поверх игры: прозрачное окно без фокуса показывает примеры и прячется', async () => {
  const { app, ui } = await launch(tmp());
  try {
    await ui.click('[data-testid="nav-hud"]');
    await ui.click('[data-testid="hud-demo"]');
    const hud = await hudWindow(app);
    await expect(hud.locator('.hud-card')).toHaveCount(5);
    const props = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Dota AI Coach — подсказки')!;
      return { focusable: w.isFocusable(), top: w.isAlwaysOnTop(), visible: w.isVisible() };
    });
    expect(props).toEqual({ focusable: false, top: true, visible: true });

    // Подсказки выключены — окно прячется
    await ui.click('[data-testid="hud-enabled"]');
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((x) => x.getTitle() === 'Dota AI Coach — подсказки')?.isVisible() ?? false), { timeout: 5000 })
      .toBe(false);
  } finally {
    await app.close();
  }
});
