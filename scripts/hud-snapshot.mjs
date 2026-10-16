// Снимки подсказок поверх игры для проверки дизайна и отчёта: собранный оверлей (npm run build) открывается в Chromium
// на разных экранах и в обеих темах, поверх схемы HUD Dota (или своего снимка игры: --bg путь.png).
//   node scripts/hud-snapshot.mjs [папка] [--bg снимок.png]
// Результат: <папка>/<тема>-<сцена>-<экран>.png (по умолчанию .tmp/hud-snapshots)
import { createServer } from 'node:http';
import { readFileSync, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : join(root, '.tmp/hud-snapshots'));
const bgArg = process.argv.indexOf('--bg');
const bg = bgArg > 0 ? resolve(process.argv[bgArg + 1]) : null;
const dist = join(root, 'out/renderer');
if (!existsSync(join(dist, 'hud/index.html'))) {
  console.error('Сначала соберите: npm run build');
  process.exit(1);
}
mkdirSync(out, { recursive: true });

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.ttf': 'font/ttf', '.png': 'image/png', '.json': 'application/json' };
const server = createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  if (url === '/__bg.png' && bg) {
    res.writeHead(200, { 'content-type': 'image/png' });
    return res.end(readFileSync(bg));
  }
  const file = normalize(join(dist, url));
  if (!file.startsWith(dist) || !existsSync(file)) {
    res.writeHead(404);
    return res.end();
  }
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const screens = [
  { id: '16x9', w: 1920, h: 1080 },
  { id: '21x9', w: 3440, h: 1440 },
  { id: '4x3', w: 1440, h: 1080 },
];
const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM ?? undefined });
for (const theme of ['arcane', 'void']) {
  for (const scene of ['alive', 'dead', 'match']) {
    for (const s of scene === 'alive' ? screens : screens.slice(0, 1)) {
      const page = await browser.newPage({ viewport: { width: s.w, height: s.h } });
      await page.goto(`http://127.0.0.1:${port}/hud/index.html#demo=${scene}&theme=${theme}&detail=detailed&bg=schematic`);
      if (bg) await page.evaluate(() => document.querySelector('.hud-schematic')?.setAttribute('style', "background: url('/__bg.png') center/cover"));
      await page.waitForTimeout(900);
      await page.screenshot({ path: join(out, `${theme}-${scene}-${s.id}.png`) });
      await page.close();
    }
  }
}
await browser.close();
server.close();
console.log(`Снимки: ${out}`);
