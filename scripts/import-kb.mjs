// Импорт базы знаний из открытых источников:
//  - Valve datafeed (dota2.com) — официально: патч, герои, характеристики, способности (+ описания на русском);
//  - OpenDota dotaconstants (MIT) — предметы: цена, рецепты, атрибуты; роли героев.
//  - механика карты: scripts/kb-mechanics.sources.json (вручную, с источниками) + варды и обзор из Valve (см. kb-mechanics.mjs).
// Все данные помечаются imported-unverified: их нужно сверить с патч-ноутами, прежде чем считать проверенными.
// Исключение — механика: «verified» только для значений, найденных в патч-ноутах Valve текущей серии или в datafeed.
//   node scripts/import-kb.mjs                  — всё заново
//   node scripts/import-kb.mjs --mechanics-only — только mechanics.json (герои и предметы берутся с диска)
// Результат: resources/data/kb/<патч>/{meta,heroes,items,mechanics}.json
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMechanics } from './kb-mechanics.mjs';

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
const out = join(root, 'resources/data/kb', patch);

/** Собирает mechanics.json и дописывает в meta источники механики и счётчики */
async function writeMechanics(heroes, meta) {
  const m = await buildMechanics({ root, patch, patches, heroes, getJson, valve: VALVE, retrievedAt });
  for (const w of m.warnings) console.warn(`  ⚠ ${w}`);
  console.log(`Механика: ${m.counts.total} записей (проверены по патч-ноутам ${m.checkedVersions.join(', ')})`, m.counts.byVerification);
  writeFileSync(join(out, 'mechanics.json'), JSON.stringify(m.file, null, 1));
  meta.sources = meta.sources.filter((s) => !s.covers?.includes('mechanics'));
  for (const s of m.sourcesUsed) {
    const [name, url, license] = s.split('|');
    meta.sources.push({ name, url, ...(license ? { license } : {}), retrievedAt, covers: ['mechanics'] });
  }
  meta.counts.mechanics = m.counts;
  return meta;
}

if (process.argv.includes('--mechanics-only')) {
  if (!existsSync(join(out, 'meta.json'))) throw new Error(`Нет базы патча ${patch}: сначала полный импорт`);
  const heroesOnDisk = JSON.parse(readFileSync(join(out, 'heroes.json'), 'utf8'));
  const metaOnDisk = JSON.parse(readFileSync(join(out, 'meta.json'), 'utf8'));
  // Дата базы = дата последнего изменения любой её части (по ней выбирается копия базы)
  metaOnDisk.generatedAt = retrievedAt;
  writeFileSync(join(out, 'meta.json'), JSON.stringify(await writeMechanics(heroesOnDisk, metaOnDisk), null, 2));
  console.log(`Готово: ${out}`);
  process.exit(0);
}

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

// --- Предметы: описание и атрибуты — OpenDota; цена, рецепт и наличие в игре — Valve (Valve главнее) ---
const odItems = await getJson(`${ODOTA}/items.json`);
const valveList = (await getJson(`${VALVE}/itemlist?language=english`)).result.data.itemabilities;
const vKey = (name) => name.replace(/^item_/, '');
const valveByKey = new Map(valveList.map((x) => [vKey(x.name), x]));
const valveKeyById = new Map(valveList.map((x) => [x.id, vKey(x.name)]));
// Цена есть только в itemdata — по запросу на предмет (включая рецепты)
const valveCost = new Map();
for (const [i, x] of valveList.entries()) {
  const d = (await getJson(`${VALVE}/itemdata?language=english&item_id=${x.id}`)).result.data.items[0];
  valveCost.set(vKey(x.name), typeof d?.item_cost === 'number' ? d.item_cost : null);
  await sleep(DELAY_MS);
  if ((i + 1) % 100 === 0) console.log(`  предметы Valve: ${i + 1}/${valveList.length}`);
}
// Рецепт Valve: компоненты первого варианта сборки; части-рецепты (recipe_x) переходят в цену рецепта
function valveRecipe(key) {
  const rec = valveByKey.get(`recipe_${key}`);
  const option = rec?.recipes?.[0]?.items;
  if (!rec || !option) return null;
  let recipeCost = valveCost.get(`recipe_${key}`) ?? 0;
  const components = [];
  for (const id of option) {
    const c = valveKeyById.get(id);
    if (!c) return null;
    if (c.startsWith('recipe_')) recipeCost += valveCost.get(c) ?? 0;
    else components.push(c);
  }
  return { components, recipeCost: recipeCost || null, options: rec.recipes.length };
}

const priceConflicts = [];
const items = Object.entries(odItems)
  .filter(([key, it]) => it && it.dname && typeof it.id === 'number' && !key.startsWith('recipe_'))
  .map(([key, it]) => {
    const v = valveByKey.get(key);
    const odCost = typeof it.cost === 'number' ? it.cost : null;
    const odComponents = (Array.isArray(it.components) ? it.components : []).filter((c) => typeof c === 'string' && c);
    const odRecipe = typeof odItems[`recipe_${key}`]?.cost === 'number' ? odItems[`recipe_${key}`].cost || null : null;
    const vr = v ? valveRecipe(key) : null;
    const vCost = v ? valveCost.get(key) : null;
    const cost = typeof vCost === 'number' ? vCost : odCost;
    const components = vr ? vr.components : odComponents;
    const recipeCost = vr ? vr.recipeCost : odRecipe;
    if (typeof vCost === 'number' && odCost !== null && vCost !== odCost) priceConflicts.push(`${key}: цена OpenDota ${odCost} → Valve ${vCost}`);
    if (vr && (odRecipe ?? null) !== (vr.recipeCost ?? null)) priceConflicts.push(`${key}: рецепт OpenDota ${odRecipe} → Valve ${vr.recipeCost}`);
    if (vr && [...odComponents].sort().join() !== [...vr.components].sort().join()) {
      priceConflicts.push(`${key}: части OpenDota [${odComponents}] → Valve [${vr.components}]`);
    }
    // Наличие в игре решается только по данным Valve
    let availability;
    if (!v) availability = 'removed'; // Valve такого предмета не знает
    else if (v.neutral_item_tier >= 0) availability = 'neutral';
    else if (cost > 0 || v.is_pregame_suggested || v.is_earlygame_suggested || v.is_lategame_suggested) availability = 'shop';
    else if (components.length || vr) availability = 'removed'; // собираемый предмет с ценой 0 — собрать нельзя
    else availability = 'not-sold';
    // Расхождение внутри самих данных Valve — записываем причину, не исправляем
    let priceNote = null;
    if (availability === 'shop' && vr && cost !== null) {
      const sum = (vr.recipeCost ?? 0) + vr.components.reduce((s, c) => s + (valveCost.get(c) ?? NaN), 0);
      if (Number.isFinite(sum) && sum !== cost) priceNote = `В данных Valve сумма частей и рецепта ${sum}, а цена ${cost}: расхождение в самом источнике, нужна сверка с игрой.`;
    }
    return {
      id: it.id,
      key,
      name: it.dname,
      cost,
      components,
      recipeCost,
      quality: it.qual ?? null,
      neutralTier: v && v.neutral_item_tier >= 0 ? v.neutral_item_tier + 1 : null,
      cooldown: typeof it.cd === 'number' ? it.cd : null,
      manaCost: typeof it.mc === 'number' ? it.mc : null,
      attributes: (it.attrib ?? []).map((a) => ({ key: a.key, value: String(a.value), display: a.display ?? null })),
      abilities: (it.abilities ?? []).map((a) => ({ type: a.type, title: a.title, description: a.description })),
      availability,
      priceSource: typeof vCost === 'number' ? 'valve' : 'opendota',
      componentsSource: vr ? 'valve' : 'opendota',
      priceNote,
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));
const byAvail = items.reduce((m, i) => ((m[i.availability] = (m[i.availability] ?? 0) + 1), m), {});
console.log(`Предметов: ${items.length}`, byAvail);
console.log(`Valve исправил OpenDota: ${priceConflicts.length}`);
for (const c of priceConflicts) console.log(`  ${c}`);

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
    { name: 'Valve datafeed (dota2.com)', url: VALVE, retrievedAt, covers: ['patch', 'heroes', 'abilities', 'descRu', 'item prices', 'item recipes', 'item availability'] },
    { name: 'OpenDota dotaconstants', url: 'https://github.com/odota/dotaconstants', license: 'MIT', commit: odotaCommit, retrievedAt, covers: ['item attributes', 'item descriptions', 'hero roles'] },
  ],
  counts: { heroes: heroes.length, items: items.length, abilities: heroes.reduce((n, h) => n + h.abilities.length, 0), itemsByAvailability: byAvail },
  priceCorrections: priceConflicts,
};

mkdirSync(out, { recursive: true });
await writeMechanics(heroes, meta);
writeFileSync(join(out, 'meta.json'), JSON.stringify(meta, null, 2));
writeFileSync(join(out, 'heroes.json'), JSON.stringify(heroes));
writeFileSync(join(out, 'items.json'), JSON.stringify(items));
writeFileSync(join(root, 'resources/data/kb/current.json'), JSON.stringify({ patch }, null, 2));
console.log(`Готово: ${out}`);
