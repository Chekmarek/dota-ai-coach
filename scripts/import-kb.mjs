// Импорт базы знаний из открытых источников:
//  - Valve datafeed (dota2.com) — официально: патч, герои, характеристики, способности (+ описания на русском);
//  - OpenDota dotaconstants (MIT) — предметы: цена, рецепты, атрибуты; роли героев.
// Все данные помечаются imported-unverified: их нужно сверить с патч-ноутами, прежде чем считать проверенными.
//   node scripts/import-kb.mjs
// Результат: resources/data/kb/<патч>/{meta,heroes,items}.json
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VALVE = 'https://www.dota2.com/datafeed';
const ODOTA = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build';
const DELAY_MS = 120;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'DotaCoach-KB-import/0.1 (local tool)' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (attempt >= 3) throw new Error(`${url}: ${e.message}`);
      await sleep(1000 * attempt);
    }
  }
}

const stripHtml = (s) => (s ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
const ATTR = { 0: 'str', 1: 'agi', 2: 'int', 3: 'all' };
const nums = (a) => (Array.isArray(a) ? a.filter((x) => typeof x === 'number') : []);

const retrievedAt = new Date().toISOString();

// --- Патч ---
const patches = (await getJson(`${VALVE}/patchnoteslist?language=english`)).patches;
const last = patches[patches.length - 1];
const patch = last.patch_number;
const patchDate = new Date(last.patch_timestamp * 1000).toISOString().slice(0, 10);
console.log(`Текущий патч: ${patch} (${patchDate})`);

// --- Герои (Valve) ---
const heroList = (await getJson(`${VALVE}/herolist?language=english`)).result.data.heroes;
const odHeroes = await getJson(`${ODOTA}/heroes.json`);
const heroes = [];
for (const [i, h] of heroList.entries()) {
  const en = (await getJson(`${VALVE}/herodata?language=english&hero_id=${h.id}`)).result.data.heroes[0];
  await sleep(DELAY_MS);
  const ru = (await getJson(`${VALVE}/herodata?language=russian&hero_id=${h.id}`)).result.data.heroes[0];
  await sleep(DELAY_MS);
  const ruAbil = new Map((ru?.abilities ?? []).map((a) => [a.id, a]));
  const od = odHeroes[String(h.id)];
  heroes.push({
    id: en.id,
    key: en.name.replace('npc_dota_hero_', ''),
    name: en.name_loc,
    primaryAttr: ATTR[en.primary_attr] ?? null,
    attackType: en.attack_capability === 1 ? 'melee' : en.attack_capability === 2 ? 'ranged' : null,
    complexity: en.complexity,
    roles: od?.roles ?? [],
    stats: {
      str: { base: en.str_base, gain: en.str_gain },
      agi: { base: en.agi_base, gain: en.agi_gain },
      int: { base: en.int_base, gain: en.int_gain },
      damageMin: en.damage_min,
      damageMax: en.damage_max,
      attackRate: en.attack_rate,
      attackRange: en.attack_range,
      projectileSpeed: en.projectile_speed,
      armor: en.armor,
      magicResist: en.magic_resistance,
      moveSpeed: en.movement_speed,
      turnRate: en.turn_rate,
      sightDay: en.sight_range_day,
      sightNight: en.sight_range_night,
      maxHealth: en.max_health,
      healthRegen: en.health_regen,
      maxMana: en.max_mana,
      manaRegen: en.mana_regen,
    },
    abilities: (en.abilities ?? [])
      .filter((a) => a.name_loc && !/hidden|empty/i.test(a.name))
      .map((a) => ({
        id: a.id,
        key: a.name,
        name: a.name_loc,
        descRu: stripHtml(ruAbil.get(a.id)?.desc_loc) || null,
        maxLevel: a.max_level,
        cooldowns: nums(a.cooldowns),
        manaCosts: nums(a.mana_costs),
        castRanges: nums(a.cast_ranges),
        innate: !!a.ability_is_innate,
        scepter: !!a.ability_has_scepter,
        shard: !!a.ability_has_shard,
      })),
    talents: (en.talents ?? []).map((t) => t.name_loc).filter(Boolean),
  });
  if ((i + 1) % 20 === 0) console.log(`  герои: ${i + 1}/${heroList.length}`);
}
console.log(`Героев: ${heroes.length} (в OpenDota: ${Object.keys(odHeroes).length})`);

// --- Предметы (OpenDota) ---
const odItems = await getJson(`${ODOTA}/items.json`);
const items = Object.entries(odItems)
  .filter(([key, it]) => it && it.dname && typeof it.id === 'number' && !key.startsWith('recipe_'))
  .map(([key, it]) => ({
    id: it.id,
    key,
    name: it.dname,
    cost: typeof it.cost === 'number' ? it.cost : null,
    components: Array.isArray(it.components) ? it.components : [],
    recipeCost: typeof odItems[`recipe_${key}`]?.cost === 'number' ? odItems[`recipe_${key}`].cost : null,
    quality: it.qual ?? null,
    neutralTier: it.tier ?? null,
    cooldown: typeof it.cd === 'number' ? it.cd : null,
    manaCost: typeof it.mc === 'number' ? it.mc : null,
    attributes: (it.attrib ?? []).map((a) => ({ key: a.key, value: String(a.value), display: a.display ?? null })),
    abilities: (it.abilities ?? []).map((a) => ({ type: a.type, title: a.title, description: a.description })),
  }))
  .sort((a, b) => a.name.localeCompare(b.name));
console.log(`Предметов: ${items.length}`);

let odotaCommit = null;
try {
  const c = await getJson('https://api.github.com/repos/odota/dotaconstants/commits?per_page=1');
  odotaCommit = { sha: c[0].sha, date: c[0].commit.author.date };
} catch {
  /* версия не критична */
}

const meta = {
  patch,
  patchDate,
  generatedAt: retrievedAt,
  verification: 'imported-unverified',
  note: 'Данные импортированы автоматически и не сверены вручную с патч-ноутами. Для точных расчётов использовать только после проверки.',
  sources: [
    { name: 'Valve datafeed (dota2.com)', url: VALVE, retrievedAt, covers: ['patch', 'heroes', 'abilities', 'descRu'] },
    { name: 'OpenDota dotaconstants', url: 'https://github.com/odota/dotaconstants', license: 'MIT', commit: odotaCommit, retrievedAt, covers: ['items', 'hero roles'] },
  ],
  counts: { heroes: heroes.length, items: items.length, abilities: heroes.reduce((n, h) => n + h.abilities.length, 0) },
};

const out = join(root, 'resources/data/kb', patch);
mkdirSync(out, { recursive: true });
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 2));
writeFileSync(join(out, 'heroes.json'), JSON.stringify(heroes));
writeFileSync(join(out, 'items.json'), JSON.stringify(items));
writeFileSync(join(root, 'resources/data/kb/current.json'), JSON.stringify({ patch }, null, 2));
console.log(`Готово: ${out}`);
