// Скачивает официальные иконки предметов, способностей и портреты героев с сервера изображений Dota 2
// для обучения распознаванию (сопоставление иконок на экране с эталонами).
//   node scripts/download-icons.mjs            — патч из resources/data/kb/current.json
// Результат: .cache/icons/<патч>/{items,abilities,heroes}/<ключ>.png и manifest.json.
// Иконки — изображения Valve: в git и в публичный репозиторий не кладутся (папка .cache в .gitignore).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const CDN = 'https://cdn.cloudflare.steamstatic.com/apps/dota2/images/dota_react';
const patch = JSON.parse(readFileSync(join(ROOT, 'resources/data/kb/current.json'), 'utf8')).patch;
const kb = (f) => JSON.parse(readFileSync(join(ROOT, 'resources/data/kb', patch, f), 'utf8'));
const out = join(ROOT, '.cache/icons', patch);

const heroes = kb('heroes.json');
const items = kb('items.json');
const jobs = [];
const add = (kind, key, path = `${kind}/${key}`) => jobs.push({ kind, key, url: `${CDN}/${path}.png`, file: join(out, kind, `${key}.png`) });
for (const it of items) add('items', it.key.replace(/^item_/, ''));
for (const h of heroes) {
  add('heroes', h.key.replace(/^npc_dota_hero_/, ''));
  // Маленький значок 32×32 — портрет на верхней панели матча (этап 1 зрения)
  add('hero-icons', h.key.replace(/^npc_dota_hero_/, ''), `heroes/icons/${h.key.replace(/^npc_dota_hero_/, '')}`);
  for (const a of h.abilities ?? []) add('abilities', a.key);
}
// Дубликаты ключей (общие способности) скачиваем один раз
const unique = [...new Map(jobs.map((j) => [j.file, j])).values()];
for (const kind of ['items', 'abilities', 'heroes', 'hero-icons']) mkdirSync(join(out, kind), { recursive: true });

const failed = [];
let done = 0, skipped = 0, bytes = 0;
async function worker(queue) {
  for (let j = queue.shift(); j; j = queue.shift()) {
    if (existsSync(j.file)) {
      skipped++;
      continue;
    }
    try {
      const res = await fetch(j.url, { headers: { 'User-Agent': 'DotaAICoach-icons' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!String(res.headers.get('content-type')).startsWith('image/png')) throw new Error(`не PNG: ${res.headers.get('content-type')}`);
      const buf = Buffer.from(await res.arrayBuffer());
      writeFileSync(j.file, buf);
      bytes += buf.length;
      done++;
    } catch (e) {
      failed.push({ kind: j.kind, key: j.key, error: String(e.message ?? e) });
    }
  }
}
const queue = [...unique];
await Promise.all(Array.from({ length: 8 }, () => worker(queue)));

writeFileSync(
  join(out, 'manifest.json'),
  JSON.stringify({ patch, source: CDN, retrievedAt: new Date().toISOString(), total: unique.length, failed }, null, 1) + '\n',
);
console.log(`Патч ${patch}: всего ${unique.length}, скачано ${done} (${(bytes / 1048576).toFixed(1)} МБ), уже были ${skipped}, не удалось ${failed.length}`);
for (const f of failed.slice(0, 30)) console.log(`  ✗ ${f.kind}/${f.key}: ${f.error}`);
