// Замер нагрузки окна подсказок поверх игры: собранное приложение (npm run build) показывает демо-подсказки
// («Подсказки в игре» → «Показать поверх игры», 12 с), скрипт снимает за WINDOW_MS:
//   — CPU процесса окна подсказок и процесса GPU всего приложения (app.getAppMetrics, % одного ядра, среднее);
//   — время задач, скриптов, пересчёта стилей и раскладки (Chromium Performance.getMetrics, прирост за окно);
//   — память кучи JS окна подсказок.
//   node scripts/perf-hud.mjs [папка приложения]   (по умолчанию — этот проект; так же меряется старая сборка)
import { _electron as electron } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const WINDOW_MS = 8000;
// Сторож: замер не должен висеть (например, если окно подсказок не появилось)
const watchdog = setTimeout(() => {
  console.error('perf-hud: нет результата за 90 с');
  process.exit(2);
}, 90_000);
const here = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = resolve(process.argv[2] ?? here);
const dataDir = mkdtempSync(join(tmpdir(), 'dotacoach-perf-'));
const app = await electron.launch({
  args: ['.'],
  cwd: appDir,
  env: { ...process.env, DOTACOACH_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', DOTACOACH_NO_UPDATE_CHECK: '1' },
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ui = null;
for (let i = 0; i < 100 && !ui; i++) {
  ui = app.windows().find((w) => !w.url().includes('engine') && !w.url().includes('hud') && !w.url().includes('overlay')) ?? null;
  if (!ui) await sleep(100);
}
await ui.waitForSelector('[data-testid="nav-hud"]');
await ui.click('[data-testid="nav-hud"]');
await ui.click('[data-testid="hud-demo"]');
let hud = null;
for (let i = 0; i < 100 && !hud; i++) {
  hud = app.windows().find((w) => w.url().includes('/hud')) ?? null;
  if (!hud) await sleep(100);
}
await hud.waitForSelector('.hud-card');
await sleep(1500); // появление карточек доиграло — меряем «стоят на экране» (полосы срока и затухание идут)
const cdp = await hud.context().newCDPSession(hud);
await cdp.send('Performance.enable');
const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((m) => [m.name, m.value]));
const pid = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle().includes('подсказки'))?.webContents.getOSProcessId() ?? null);
const m0 = await metrics();
const cpu = [];
const gpu = [];
for (let t = 0; t < WINDOW_MS; t += 1000) {
  await sleep(1000);
  const all = await app.evaluate(({ app: a }) => a.getAppMetrics().map((p) => ({ pid: p.pid, type: p.type, cpu: p.cpu.percentCPUUsage })));
  const p = all.find((x) => x.pid === pid);
  if (p) cpu.push(p.cpu);
  const g = all.find((x) => x.type === 'GPU');
  if (g) gpu.push(g.cpu);
}
const m1 = await metrics();
const cards = await hud.locator('.hud-card').count();
const d = (k) => ((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000;
const sec = WINDOW_MS / 1000;
const avg = (a) => (a.length > 1 ? +(a.slice(1).reduce((x, y) => x + y, 0) / (a.length - 1)).toFixed(2) : null);
const out = {
  app: appDir,
  cards,
  gpuProcessCpuAvg: avg(gpu),
  cpuPercentAvg: cpu.length ? +(cpu.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, cpu.length - 1)).toFixed(2) : null,
  taskMsPerSec: +(d('TaskDuration') / sec).toFixed(2),
  scriptMsPerSec: +(d('ScriptDuration') / sec).toFixed(2),
  styleMsPerSec: +(d('RecalcStyleDuration') / sec).toFixed(2),
  layoutMsPerSec: +(d('LayoutDuration') / sec).toFixed(2),
  layoutsPerSec: +(((m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)) / sec).toFixed(1),
  jsHeapMb: +((m1.JSHeapUsedSize ?? 0) / 1048576).toFixed(1),
};
console.log(JSON.stringify(out));
await Promise.race([app.close(), sleep(5000)]);
clearTimeout(watchdog);
process.exit(0);
