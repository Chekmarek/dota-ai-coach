// Инвентарь по секундам (STRATZ inventoryEvents) для матчей подбора порога и проверки модели опасности
// (docs/DANGER_MODEL.md): без него правила коуча не знают про реген и Town Portal Scroll и сравнение с моделью
// было бы нечестным. Делит матчи так же, как tests/unit/danger-train.test.ts (по id). Только для разработчика.
//   node scripts/fetch-danger-inventory.mjs [--turbo] [--all] [--dir <папка>]  → .tmp/<папка>/inv/<id>.json.gz
// --all — и для обучающей части (без инвентаря стенд не знает предметов, и признак «стадия по предметам» не учится).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');
const argOf = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
const dir = join(root, '.tmp', argOf('--dir') ?? (process.argv.includes('--turbo') ? 'danger-turbo' : 'danger'));
const all = process.argv.includes('--all');
const out = join(dir, 'inv');
mkdirSync(out, { recursive: true });
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const tokenFile = ['.stratz-token', '.stratz-token.txt'].map((f) => join(home, f)).find((f) => existsSync(f));
const token = (process.env.STRATZ_TOKEN ?? (tokenFile ? readFileSync(tokenFile, 'utf8') : '')).replace(/^﻿/, '').trim();
if (!token) throw new Error('Нет токена STRATZ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP = Number(process.env.DANGER_GAP_MS ?? 3000);
/** Как split в tests/unit/danger-train.test.ts */
const split = (id) => {
  const h = (id * 2654435761) % 100;
  return h < 70 ? 'train' : h < 80 ? 'val' : 'test';
};
const SLOT = (s) => `${s} { itemId charges }`;
const Q = (id) => `{ match(id: ${id}) { id players { heroId playbackData { inventoryEvents { time ${['item0', 'item1', 'item2', 'item3', 'item4', 'item5', 'backPack0', 'backPack1', 'backPack2', 'teleport0', 'neutral0'].map(SLOT).join(' ')} } } } } }`;

const ids = readdirSync(dir).filter((f) => f.endsWith('.json.gz')).map((f) => Number(f.slice(0, -8))).filter((id) => all || split(id) !== 'train');
let got = 0, fail = 0;
for (const id of ids) {
  // Уже есть: отдельным файлом или прямо в матче (загрузка с инвентарём, fetch-danger-matches.mjs)
  if (existsSync(join(out, `${id}.json.gz`)) || gunzipSync(readFileSync(join(dir, `${id}.json.gz`))).includes('"inventoryEvents"')) {
    got++;
    continue;
  }
  for (let a = 1; a <= 4; a++) {
    await sleep(GAP);
    try {
      const res = await fetch('https://api.stratz.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' }, body: JSON.stringify({ query: Q(id) }), signal: AbortSignal.timeout(120_000) });
      if (res.status === 429) {
        await sleep(120_000);
        continue;
      }
      const hour = Number(res.headers.get('x-ratelimit-remaining-hour') ?? 1000);
      if (hour < 100) await sleep(600_000);
      const j = await res.json();
      const m = j?.data?.match;
      if (!m?.players?.length) throw new Error(String(j?.errors?.[0]?.message ?? 'пусто').replaceAll(token, '<token>'));
      writeFileSync(join(out, `${id}.json.gz`), gzipSync(JSON.stringify(m)));
      got++;
      break;
    } catch (e) {
      if (a === 4) (fail++, console.warn(`${id}: ${e.message}`));
    }
  }
  if ((got + fail) % 25 === 0) console.log(`${new Date().toISOString()} инвентарь: ${got}/${ids.length}, ошибок ${fail}`);
}
console.log(`Готово: ${got}/${ids.length}, ошибок ${fail} → ${out}`);
