// «Режим тени» (ночная задача, этап 5): таймлайны про-матчей из STRATZ для прогона коуча. Только для разработчика.
// id матчей — из OpenDota explorer (профессиональные, 3–7 дней назад: STRATZ разбирает матч около суток), данные —
// STRATZ match(id): игроки, позиции, playbackData (позиции героев по секундам, здоровье и мана, уровень, золото,
// покупки, инвентарь, смерти с разметкой STRATZ). Без ников и id игроков. Кладёт в .tmp/shadow/<id>.json (не в git).
//   node scripts/fetch-shadow-matches.mjs [число матчей, по умолчанию 8]
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const want = Number(process.argv[2] ?? 8);
const home = process.env.USERPROFILE ?? process.env.HOME ?? '';
const tokenFile = ['.stratz-token', '.stratz-token.txt'].map((f) => join(home, f)).find((f) => existsSync(f));
const token = (process.env.STRATZ_TOKEN ?? (tokenFile ? readFileSync(tokenFile, 'utf8') : '')).replace(/^﻿/, '').trim();
if (!token) throw new Error('Нет токена STRATZ');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gql(query) {
  for (let a = 1; ; a++) {
    const res = await fetch('https://api.stratz.com/graphql', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'User-Agent': 'STRATZ_API' }, body: JSON.stringify({ query }) });
    if (res.ok) {
      const j = await res.json();
      if (j.errors?.length) throw new Error(String(j.errors[0].message).replaceAll(token, '<token>'));
      return j.data;
    }
    if (a >= 3) throw new Error(`STRATZ HTTP ${res.status}`);
    await sleep(res.status === 429 ? 30_000 : 3000 * a);
  }
}
const now = Math.floor(Date.now() / 1000);
const q = `select match_id from matches where start_time between ${now - 7 * 86400} and ${now - 3 * 86400} and duration between 1800 and 3000 order by match_id desc limit 40`;
const ids = (await (await fetch(`https://api.opendota.com/api/explorer?sql=${encodeURIComponent(q)}`, { headers: { 'User-Agent': 'DotaCoach-shadow/0.1 (local tool)' } })).json()).rows.map((r) => r.match_id);
const dir = join(root, '.tmp', 'shadow');
mkdirSync(dir, { recursive: true });
const PB = `playbackData {
  playerUpdatePositionEvents { time x y }
  playerUpdateHealthEvents { time hp maxHp mp maxMp }
  playerUpdateLevelEvents { time level }
  playerUpdateGoldEvents { time gold networth }
  purchaseEvents { time itemId }
  inventoryEvents { time item0 { itemId charges } item1 { itemId charges } item2 { itemId charges } item3 { itemId charges } item4 { itemId charges } item5 { itemId charges } teleport0 { itemId charges } neutral0 { itemId charges } }
  deathEvents { time timeDead isBurst isEngagedOnDeath hasHealAvailable isAttemptTpOut isDieBack positionX positionY }
  killEvents { time }
  csEvents { time }
}`;
let got = 0;
for (const id of ids) {
  if (got >= want) break;
  if (existsSync(join(dir, `${id}.json`))) {
    got++;
    continue;
  }
  try {
    const d = await gql(`{ match(id: ${id}) { id didRadiantWin durationSeconds gameMode players { heroId isRadiant isVictory position lane numLastHits goldPerMinute experiencePerMinute deaths ${PB} } } }`);
    const m = d.match;
    if (!m || !m.players?.every((p) => p.playbackData?.playerUpdatePositionEvents?.length)) continue;
    writeFileSync(join(dir, `${id}.json`), JSON.stringify(m));
    got++;
    console.log(`  ${id}: ${Math.round(m.durationSeconds / 60)} мин`);
  } catch (e) {
    console.warn(`  ${id}: ${e.message}`);
  }
  await sleep(600);
}
console.log(`Матчей: ${got} → ${dir}`);
