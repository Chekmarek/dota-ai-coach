// Этап 3: «Предпросмотр подсказок» и окно подсказок поверх игры (демо — без Доты).
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { parseSession, replaySession } from '../../scripts/gsi-replay.mjs';
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

test('матч по данным игры: подсказка движка — в ленте «Живой игры» и поверх игры (без захвата экрана)', async () => {
  const dataDir = tmp();
  const port = 54131;
  const token = 'e2e1'.repeat(16);
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ live: { autoStart: false }, gsi: { port, token, record: false, dotaDir: null } }));
  const { app, ui } = await launch(dataDir);
  try {
    await ui.click('[data-testid="nav-live"]');
    await expect(ui.locator('[data-testid="hints-empty"]')).toBeVisible();
    // Настоящая сессия лайна, но часы 17:46…17:50 — до руны силы (18:00) 10–14 с
    const base = parseSession(readFileSync(join(ROOT, 'tests/fixtures/gsi/session.jsonl'), 'utf8'));
    const last = base[base.length - 1]!.body as { map: Record<string, unknown> };
    const entries = [0, 1, 2, 3, 4].map((i) => ({ t: i * 1000, body: { ...last, map: { ...last.map, clock_time: 1066 + i, game_time: 1156 + i } } }));
    expect((await replaySession(entries, { url: `http://127.0.0.1:${port}/`, token, speed: 2 })).failed).toBe(0);
    const item = ui.locator('[data-testid="hint-item"]', { hasText: 'Руна силы через' });
    await expect(item).toBeVisible({ timeout: 8000 });
    const hud = await hudWindow(app);
    await expect(hud.locator('.hud-card', { hasText: 'Руна силы через' })).toBeVisible({ timeout: 5000 });
  } finally {
    await app.close();
  }
});
