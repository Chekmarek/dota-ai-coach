// Указатель набора кадров (docs/VISION_DATASET.md): по каждому кадру — матч, время, разметка героев.
//   node scripts/vision-dataset-index.mjs <папка набора> [--matches id,id,...] > index.json
// Без --matches берутся все кадры с разметкой. Пишет JSON-массив в stdout:
//   [{ png, matchId, clock, daytime, heroes: [{ team, slot, heroKey, alive, respawnSec, xpos, ypos, health, maxHealth, level }] }]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const dir = args.find((a) => !a.startsWith('--'));
const mi = args.indexOf('--matches');
const only = mi >= 0 ? new Set(args[mi + 1].split(',')) : null;
if (!dir || !existsSync(dir)) {
  console.error('Использование: node scripts/vision-dataset-index.mjs <папка набора> [--matches id,id]');
  process.exit(2);
}
const out = [];
const walk = (d) => {
  for (const f of readdirSync(d).sort()) {
    const p = join(d, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.json')) {
      let m;
      try {
        m = JSON.parse(readFileSync(p, 'utf8'));
      } catch {
        continue;
      }
      if (m?.format !== 1 || !m.spectator) continue;
      const matchId = m.body?.map?.matchid ?? null;
      if (only && !only.has(matchId)) continue;
      out.push({ png: p.replace(/\.json$/, '.png'), matchId, clock: m.spectator.clock, daytime: m.spectator.daytime, width: m.width, height: m.height, heroes: m.spectator.heroes });
    }
  }
};
walk(dir);
process.stdout.write(JSON.stringify(out));
console.error(`кадров: ${out.length}`);
