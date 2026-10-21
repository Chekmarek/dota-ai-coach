// Тайминги предметов по скачанным матчам STRATZ: сборка героя в Турбо (в STRATZ heroStats Турбо нет) и когда
// дешёвые ранние предметы уходят из 6 ячеек. Матчи — .tmp/danger (рейтинг Divine+) и .tmp/danger-turbo (Турбо),
// scripts/fetch-danger-matches.mjs. Экзамены (.tmp/exam*), режим тени и свои матчи не читаются.
// Результат — src/data/item-timings.json (входит в сборку).
//   node scripts/build-item-timings.mjs
//
// Проверено и отброшено (2026-10-21): «сборка от положения» (что берут, когда команда отстаёт или ведёт по счёту
// убийств). На 1337 матчах All Pick строгий отбор (z ≥ 3) прошёл 1 предмет из 324 — и тот «при перевесе дороже»
// (больше золота), а не выбор; на уровне позиции по всем героям — ни одного. Данных на героя мало (25–60 матчей).
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = join(import.meta.dirname, '..');
const kb = join(root, 'resources/data/kb/7.41f');
const items = JSON.parse(readFileSync(join(kb, 'items.json'), 'utf8'));
const heroes = JSON.parse(readFileSync(join(kb, 'heroes.json'), 'utf8'));
const itemById = new Map(items.map((i) => [i.id, i]));
const heroKeyById = new Map((Array.isArray(heroes) ? heroes : heroes.heroes).map((h) => [h.id, h.key]));
/** «Большой» предмет — собирается из компонентов и стоит от 1200 (Magic Wand, Bracer — нет; Force Staff, BKB — да) */
const major = (it) => it && it.components?.length > 0 && it.cost >= 1200 && !it.key.includes('recipe');
/** Дешёвые ранние предметы, для которых считаем, когда они уходят из 6 ячеек */
const EARLY = ['magic_stick', 'magic_wand', 'bracer', 'wraith_band', 'null_talisman', 'quelling_blade', 'orb_of_venom', 'soul_ring', 'branches', 'ring_of_basilius', 'headdress', 'buckler', 'falcon_blade', 'orb_of_corrosion', 'urn_of_shadows'];
const SLOTS = ['item0', 'item1', 'item2', 'item3', 'item4', 'item5'];
/** Во что ранний предмет собирается (Quelling Blade → Battle Fury): у купивших такой предмет уход — сборка, а не продажа */
const UPGRADES = new Map(EARLY.map((k) => [k, new Set(items.filter((i) => i.cost > 0 && i.components?.includes(k)).map((i) => i.key))]));

const examIds = new Set(
  readdirSync(join(root, '.tmp'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && /^exam/.test(d.name))
    .flatMap((d) => readdirSync(join(root, '.tmp', d.name)).filter((f) => f.endsWith('.json.gz'))),
);

function* matches(dir) {
  const d = join(root, '.tmp', dir);
  for (const f of readdirSync(d).filter((x) => x.endsWith('.json.gz'))) {
    if (examIds.has(f)) continue;
    const m = JSON.parse(gunzipSync(readFileSync(join(d, f))).toString('utf8'));
    const invFile = join(d, 'inv', f);
    if (existsSync(invFile) && !m.players.some((p) => p.playbackData?.inventoryEvents)) {
      const inv = JSON.parse(gunzipSync(readFileSync(invFile)).toString('utf8'));
      for (const p of m.players) if (p.playbackData) p.playbackData.inventoryEvents = inv.players.find((q) => q.heroId === p.heroId)?.playbackData?.inventoryEvents;
    }
    yield m;
  }
}

const r1 = (x) => Math.round(x * 10) / 10;
const r3 = (x) => Math.round(x * 1000) / 1000;
const quant = (arr, q) => {
  const s = [...arr].sort((a, b) => a - b);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : null;
};

function build(dir, withBuilds) {
  const leaves = new Map();
  const builds = new Map();
  let count = 0;
  for (const m of matches(dir)) {
    count++;
    for (const p of m.players) {
      const pb = p.playbackData;
      const heroKey = heroKeyById.get(p.heroId);
      const pos = String(p.position ?? '').replace('POSITION_', '');
      if (!pb || !heroKey) continue;
      // Когда ранние предметы уходят из 6 ячеек (только матчи с инвентарём)
      const inv = pb.inventoryEvents;
      const bought = new Set((pb.purchaseEvents ?? []).map((e) => itemById.get(e.itemId)?.key).filter(Boolean));
      if (inv?.length) {
        const last = new Map();
        for (const ev of inv) {
          for (const s of SLOTS) {
            const it = ev[s] ? itemById.get(ev[s].itemId) : null;
            if (it && EARLY.includes(it.key)) last.set(it.key, ev.time);
          }
        }
        for (const [key, t] of last) {
          if ([...(UPGRADES.get(key) ?? [])].some((u) => bought.has(u))) continue;
          const l = leaves.get(key) ?? [];
          // Держали до конца матча — «не ушёл» (бесконечность для медианы)
          l.push(t >= m.durationSeconds - 60 ? Infinity : t / 60);
          leaves.set(key, l);
        }
      }
      // Сборка героя на позиции: первая покупка каждого большого предмета, минута игрового времени
      if (withBuilds && /^[1-5]$/.test(pos)) {
        const first = new Map();
        for (const e of pb.purchaseEvents ?? []) {
          const it = itemById.get(e.itemId);
          if (major(it) && !first.has(it.key) && e.time >= 0) first.set(it.key, e.time / 60);
        }
        const hb = builds.get(heroKey) ?? new Map();
        builds.set(heroKey, hb);
        const b = hb.get(pos) ?? { n: 0, items: new Map() };
        hb.set(pos, b);
        b.n++;
        for (const [k, t] of first) b.items.set(k, [...(b.items.get(k) ?? []), t]);
      }
    }
  }
  return {
    matches: count,
    leaves: Object.fromEntries(
      [...leaves].filter(([, l]) => l.length >= 30).map(([k, l]) => {
        const med = quant(l, 0.5);
        return [k, { n: l.length, p50: med === null || !Number.isFinite(med) ? null : r1(med) }];
      }),
    ),
    builds: Object.fromEntries(
      [...builds]
        .map(([h, byPos]) => [
          h,
          Object.fromEntries(
            [...byPos]
              .filter(([, b]) => b.n >= 20)
              .map(([p, b]) => [p, { n: b.n, items: [...b.items].map(([key, l]) => ({ key, share: r3(l.length / b.n), p50: r1(quant(l, 0.5)), p80: r1(quant(l, 0.8)) })).filter((x) => x.share >= 0.15).sort((a, b) => a.p50 - b.p50) }]),
          ),
        ])
        .filter(([, v]) => Object.keys(v).length),
    ),
  };
}

const normal = build('danger', false);
console.log(`All Pick: матчей ${normal.matches}, ранних предметов ${Object.keys(normal.leaves).length}`);
const turbo = build('danger-turbo', true);
const big = Object.values(turbo.builds).flatMap((bp) => Object.values(bp)).filter((b) => b.n >= 40).length;
console.log(`Турбо: матчей ${turbo.matches}, ранних предметов ${Object.keys(turbo.leaves).length}, сборок героя на позиции ${Object.values(turbo.builds).flatMap((bp) => Object.values(bp)).length} (из них ≥ 40 матчей: ${big})`);
const out = {
  schema: 'dota-coach.item-timings',
  version: 1,
  patch: '7.41f',
  generatedAt: new Date().toISOString(),
  note: 'Скачанные матчи STRATZ: All Pick — рейтинг Divine+, Турбо — публичные. Экзаменационные матчи не используются.',
  normal,
  turbo,
};
writeFileSync(join(root, 'src/data/item-timings.json'), JSON.stringify(out) + '\n');
console.log('Записано: src/data/item-timings.json');
