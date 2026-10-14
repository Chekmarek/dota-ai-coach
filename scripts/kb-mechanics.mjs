// Механика карты для базы знаний (этап E): собирает resources/data/kb/<патч>/mechanics.json.
//  - Значения из scripts/kb-mechanics.sources.json (ведётся вручную, у каждого источник и дата).
//    Запись «verified» с полем valveNote подтверждается, только если эта строка есть в патч-ноутах Valve
//    текущей серии патчей (например, 7.41 … 7.41f); иначе понижается до imported-unverified.
//  - Значения, которые Valve отдаёт в datafeed для текущего патча (варды, Smoke, обзор героев), — автоматически, verified.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stripHtml = (s) => String(s ?? '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]+>/g, ' ');
const norm = (s) => stripHtml(s).replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();

/** Все строки патч-ноутов (общие, предметы, нейтральные предметы, нейтралы) одной строкой для поиска */
function patchNotesText(pn) {
  const parts = [];
  const walk = (v) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      if (typeof v.note === 'string') parts.push(v.note);
      if (typeof v.info === 'string') parts.push(v.info);
      Object.values(v).forEach((x) => (typeof x === 'object' ? walk(x) : null));
    }
  };
  walk([pn.general_notes, pn.items, pn.neutral_items, pn.neutral_creeps]);
  return norm(parts.join(' \n '));
}

/**
 * @param {{ root: string, patch: string, patches: {patch_number: string}[], heroes: any[], getJson: (u: string) => Promise<any>, valve: string, retrievedAt: string }} o
 */
export async function buildMechanics({ root, patch, patches, heroes, getJson, valve, retrievedAt }) {
  const src = JSON.parse(readFileSync(join(root, 'scripts/kb-mechanics.sources.json'), 'utf8'));
  const warnings = [];

  // Серия текущего патча: 7.41f → 7.41, 7.41a … 7.41f
  const series = patch.replace(/[a-z]+$/, '');
  const versions = patches.map((p) => p.patch_number).filter((v) => v === series || (v.startsWith(series) && /^[a-z]+$/.test(v.slice(series.length))));
  const notesByVersion = new Map();
  for (const v of versions) notesByVersion.set(v, patchNotesText(await getJson(`${valve}/patchnotes?version=${v}&language=english`)));
  const findNote = (text) => {
    const n = norm(text);
    for (const [v, t] of notesByVersion) if (t.includes(n)) return v;
    return null;
  };

  const entries = [];
  for (const e of src.entries) {
    const s = src.sources[e.source];
    if (!s) {
      warnings.push(`${e.id}: неизвестный источник ${e.source} — запись пропущена`);
      continue;
    }
    let verification = e.verification;
    let patchOf = s.patch ?? null;
    if (verification === 'verified') {
      const found = e.valveNote ? findNote(e.valveNote) : null;
      if (!found) {
        warnings.push(`${e.id}: строка не найдена в патч-ноутах ${series}* — понижено до imported-unverified`);
        verification = 'imported-unverified';
      } else patchOf = found;
    }
    entries.push({
      id: e.id,
      category: e.category,
      nameRu: e.nameRu,
      values: e.values,
      schedule: e.schedule ?? null,
      notesRu: e.notesRu,
      source: { name: s.name, url: s.url, license: s.license ?? null },
      patch: patchOf,
      retrievedAt: e.retrievedAt ?? src.retrievedAt,
      verification,
    });
  }

  // --- Автоматически из Valve datafeed (текущий патч) ---
  const today = retrievedAt.slice(0, 10);
  const valveSrc = (url) => ({ name: 'Valve datafeed (dota2.com)', url, license: null });
  const itemList = (await getJson(`${valve}/itemlist?language=english`)).result.data.itemabilities;
  const itemData = async (name) => {
    const x = itemList.find((i) => i.name === name);
    if (!x) return null;
    const url = `${valve}/itemdata?language=english&item_id=${x.id}`;
    const d = (await getJson(url)).result.data.items[0];
    const sv = Object.fromEntries((d.special_values ?? []).map((v) => [v.name, v.values_float?.[0] ?? null]));
    return { d, sv, url };
  };
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const auto = (id, nameRu, values, notesRu, url) => {
    const allNull = values.every((v) => v.value === null);
    entries.push({
      id, category: 'glyph-scan-courier-wards', nameRu, values, schedule: null, notesRu,
      source: valveSrc(url), patch, retrievedAt: today, verification: allNull ? 'missing' : 'verified',
    });
  };
  const obs = await itemData('item_ward_observer');
  if (obs) {
    auto('ward-observer', 'Observer Ward', [
      { key: 'cost', labelRu: 'Цена', value: num(obs.d.item_cost), unit: 'gold' },
      { key: 'stock', labelRu: 'Максимум в лавке', value: num(obs.d.item_stock_max), unit: 'count' },
      { key: 'restock', labelRu: 'Пополнение лавки', value: num(obs.d.item_stock_time), unit: 's' },
      { key: 'lifetime', labelRu: 'Живёт', value: num(obs.sv.lifetime), unit: 's' },
      { key: 'vision', labelRu: 'Обзор', value: num(obs.sv.vision_range_tooltip), unit: 'range' },
    ], 'Значения из данных Valve для текущего патча.', obs.url);
  } else warnings.push('ward-observer: предмета нет в datafeed');
  const sentry = await itemData('item_ward_sentry');
  if (sentry) {
    auto('ward-sentry', 'Sentry Ward', [
      { key: 'cost', labelRu: 'Цена', value: num(sentry.d.item_cost), unit: 'gold' },
      { key: 'stock', labelRu: 'Максимум в лавке', value: num(sentry.d.item_stock_max), unit: 'count' },
      { key: 'restock', labelRu: 'Пополнение лавки', value: num(sentry.d.item_stock_time), unit: 's' },
      { key: 'lifetime', labelRu: 'Живёт', value: num(sentry.sv.lifetime), unit: 's' },
      { key: 'trueSight', labelRu: 'Радиус истинного зрения', value: num(sentry.sv.true_sight_range), unit: 'range' },
    ], 'Значения из данных Valve для текущего патча.', sentry.url);
  } else warnings.push('ward-sentry: предмета нет в datafeed');
  const smoke = await itemData('item_smoke_of_deceit');
  if (smoke) {
    auto('smoke-of-deceit', 'Smoke of Deceit', [
      { key: 'cost', labelRu: 'Цена', value: num(smoke.d.item_cost), unit: 'gold' },
      { key: 'stock', labelRu: 'Максимум в лавке', value: num(smoke.d.item_stock_max), unit: 'count' },
      { key: 'restock', labelRu: 'Пополнение лавки', value: num(smoke.d.item_stock_time), unit: 's' },
    ], 'Значения из данных Valve для текущего патча.', smoke.url);
  }

  // Обзор героев днём и ночью — из характеристик героев Valve (heroes.json этого же патча)
  const heroUrl = `${valve}/herodata?language=english`;
  const groups = new Map();
  for (const h of heroes) {
    const k = `${h.stats.sightDay}/${h.stats.sightNight}`;
    groups.set(k, [...(groups.get(k) ?? []), h]);
  }
  const [common, commonHeroes] = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)[0] ?? [null, []];
  if (common) {
    const [day, night] = common.split('/').map(Number);
    entries.push({
      id: 'vision-heroes', category: 'day-night', nameRu: 'Обзор героев днём и ночью',
      values: [
        { key: 'day', labelRu: 'Днём', value: day, unit: 'range' },
        { key: 'night', labelRu: 'Ночью', value: night, unit: 'range' },
        { key: 'heroes', labelRu: 'Героев с таким обзором', value: commonHeroes.length, unit: 'count' },
      ],
      schedule: null,
      notesRu: `Исключения (день/ночь): ${[...groups.entries()].filter(([k]) => k !== common).map(([k, hs]) => `${hs.map((h) => h.name).join(', ')} — ${k}`).join('; ') || 'нет'}.`,
      source: valveSrc(heroUrl), patch, retrievedAt: today, verification: 'verified',
    });
  }
  const ns = heroes.find((h) => h.key === 'night_stalker');
  entries.push({
    id: 'vision-night-stalker', category: 'day-night', nameRu: 'Night Stalker: обзор',
    values: [
      { key: 'day', labelRu: 'Днём', value: num(ns?.stats.sightDay), unit: 'range' },
      { key: 'night', labelRu: 'Ночью', value: num(ns?.stats.sightNight), unit: 'range' },
    ],
    schedule: null,
    notesRu: 'Исключение из общего правила: ночью Night Stalker видит дальше, чем днём.',
    source: valveSrc(heroUrl), patch, retrievedAt: today, verification: ns ? 'verified' : 'missing',
  });

  const count = (f) => entries.reduce((m, e) => ((m[f(e)] = (m[f(e)] ?? 0) + 1), m), {});
  return {
    file: { patch, generatedAt: retrievedAt, entries },
    counts: { total: entries.length, byCategory: count((e) => e.category), byVerification: count((e) => e.verification) },
    sourcesUsed: [...new Set(entries.map((e) => `${e.source.name}|${e.source.url}|${e.source.license ?? ''}`))],
    checkedVersions: versions,
    warnings,
  };
}
