// Тип цели способностей и предметов — из официального Valve datafeed (dota2.com, тот же источник, что у базы знаний):
// флаги поведения DOTA_ABILITY_BEHAVIOR и команда цели. Нужен для советов против Linken's Sphere («блокирует
// большинство заклинаний на одну цель», база знаний патча) и для деления героев с Blink Dagger на инициаторов
// с массовым контролем и прыгающих на одну цель. Результат — src/data/targeting.json (входит в сборку).
//   node scripts/import-targeting.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const VALVE = 'https://www.dota2.com/datafeed';
const kb = join(root, 'resources/data/kb/7.41f');
const heroes = JSON.parse(readFileSync(join(kb, 'heroes.json'), 'utf8'));
const items = JSON.parse(readFileSync(join(kb, 'items.json'), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJson(url) {
  for (let a = 1; ; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'DotaCoach-kb/0.1' }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      if (a >= 6) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      if (a >= 6) throw e;
    }
    await sleep(3000 * a);
  }
}

// DOTA_ABILITY_BEHAVIOR: PASSIVE 2, NO_TARGET 4, UNIT_TARGET 8, POINT 16, AOE 32; DOTA_UNIT_TARGET_TEAM: ENEMY 2, BOTH 3
const flags = (behavior, team) => {
  const b = BigInt(behavior ?? 0);
  return {
    passive: (b & 2n) !== 0n,
    /** На одну цель и по врагу — такое Linken's Sphere блокирует («большинство заклинаний на одну цель») */
    unitEnemy: (b & 8n) !== 0n && (team === 2 || team === 3),
    /** Без цели или по площади — может задеть нескольких врагов сразу */
    area: (b & 4n) !== 0n || (b & 32n) !== 0n,
    /** По точке на земле (Fissure, Chronosphere): тоже может задеть нескольких */
    point: (b & 16n) !== 0n,
  };
};

const abilities = {};
for (const h of heroes) {
  const d = (await getJson(`${VALVE}/herodata?language=english&hero_id=${h.id}`)).result.data.heroes[0];
  for (const a of d.abilities ?? []) if (a.name && !a.name.includes('empty')) abilities[a.name] = { ...flags(a.behavior, a.target_team), ult: a.type === 1 };
  await sleep(250);
}
console.log(`Способностей: ${Object.keys(abilities).length}`);
const itemFlags = {};
for (const it of items.filter((i) => i.cost > 0 || i.neutralTier)) {
  const d = (await getJson(`${VALVE}/itemdata?language=english&item_id=${it.id}`)).result?.data?.items?.[0];
  if (d) itemFlags[it.key] = flags(d.behavior, d.target_team);
  await sleep(200);
}
console.log(`Предметов: ${Object.keys(itemFlags).length}`);
writeFileSync(
  join(root, 'src/data/targeting.json'),
  JSON.stringify({ schema: 'dota-coach.targeting', version: 1, patch: '7.41f', source: `${VALVE} (herodata, itemdata)`, generatedAt: new Date().toISOString(), abilities, items: itemFlags }) + '\n',
);
console.log('Записано: src/data/targeting.json');
