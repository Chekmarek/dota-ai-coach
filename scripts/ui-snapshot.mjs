// Снимки всех разделов окна коуча (для проверки дизайна): собранное приложение (npm run build) запускается
// с пустой временной папкой данных, без живого захвата и проверки обновлений.
//   node scripts/ui-snapshot.mjs [папка]   → <папка>/<раздел>.png (по умолчанию .tmp/ui-shots)
import { _electron as electron } from '@playwright/test';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] ?? join(root, '.tmp/ui-shots'));
mkdirSync(out, { recursive: true });
const dataDir = mkdtempSync(join(tmpdir(), 'dotacoach-ui-'));
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, DOTACOACH_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', DOTACOACH_NO_UPDATE_CHECK: '1' },
});
let ui = null;
for (let i = 0; i < 100 && !ui; i++) {
  ui = app.windows().find((w) => !w.url().includes('engine') && !w.url().includes('hud') && !w.url().includes('overlay')) ?? null;
  if (!ui) await new Promise((r) => setTimeout(r, 100));
}
await ui.setViewportSize({ width: 1360, height: 860 });
await ui.waitForSelector('[data-testid^="nav-"]');
const ids = await ui.$$eval('[data-testid^="nav-"]', (els) => els.map((e) => e.getAttribute('data-testid')).filter((x) => !x.includes('dot')));
for (const id of ids) {
  await ui.click(`[data-testid="${id}"]`);
  await ui.waitForTimeout(600);
  await ui.screenshot({ path: join(out, `${id.replace('nav-', '')}.png`) });
}
await app.close();
console.log(`Снимки: ${out}`);
