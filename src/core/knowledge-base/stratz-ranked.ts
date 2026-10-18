// STRATZ heroStats → данные «как играют сильные игроки рейтинга» (тот же формат, что stats-ranked.json из
// scripts/import-stratz.mjs). Чистое преобразование: запросы делает main (src/main/knowledge/stratz-sync.ts).
import type { RankedHero } from '../../shared/types/stats-ranked.ts';

export const STRATZ_BRACKET = 'DIVINE_IMMORTAL';
export const STRATZ_CURVE_MINUTES = [5, 10, 15, 20, 25, 30, 35, 40] as const;
const MAX_MIN = 40;
/** Сколько матчей на позиции нужно, чтобы кривая и покупки считались */
const MIN_MATCHES = 200;
const ITEM_MIN_SHARE = 0.08;
const ITEMS_KEEP = 18;
const SKIP = new Set(['tango', 'flask', 'clarity', 'enchanted_mango', 'faerie_fire', 'tpscroll', 'ward_observer', 'ward_sentry', 'ward_dispenser', 'dust', 'smoke_of_deceit', 'branches', 'blood_grenade', 'famango', 'great_famango', 'greater_famango', 'courier']);

/**
 * Запрос GraphQL по одному герою: кривые по минутам и позициям + покупки предметов по каждой позиции отдельно.
 * Покупки — пятью частями (p1…p5): STRATZ в itemFullPurchase помечает все строки как POSITION_1, даже когда фильтр
 * позиции другой (проверено 2026-10-19), поэтому позицию берём из имени части, а не из поля ответа.
 * matchLimit: 10 — по умолчанию STRATZ отбрасывает редкие строки «предмет × минута», и от сборки оставалось 1–6 предметов.
 */
export function stratzRankedQuery(heroId: number): string {
  const id = Math.trunc(heroId);
  const items = [1, 2, 3, 4, 5].map((p) => `p${p}: itemFullPurchase(heroId: ${id}, bracketBasicIds: [${STRATZ_BRACKET}], positionIds: [POSITION_${p}], matchLimit: 10) { itemId time matchCount winCount }`).join('\n    ');
  return `{ heroStats {
    stats(heroIds: [${id}], bracketBasicIds: [${STRATZ_BRACKET}], groupByTime: true, groupByPosition: true, maxTime: ${MAX_MIN}) { time position matchCount cs networth xp level }
    ${items}
  } }`;
}

type Purchase = { itemId: number; time: number; matchCount: number; winCount: number };
export interface StratzHeroStatsResponse {
  stats: { time: number; position: string | null; matchCount: number; cs: number; networth: number; xp: number; level: number }[];
  p1?: Purchase[];
  p2?: Purchase[];
  p3?: Purchase[];
  p4?: Purchase[];
  p5?: Purchase[];
}

const weightedMedian = (pairs: [number, number][]): number | null => {
  const s = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = s.reduce((a, [, w]) => a + w, 0);
  let acc = 0;
  for (const [v, w] of s) if ((acc += w) >= total / 2) return v;
  return null;
};

export function toRankedHero(hero: { id: number; key: string }, d: StratzHeroStatsResponse, itemKeyById: ReadonlyMap<number, string>): RankedHero {
  const curves: RankedHero['curves'] = {};
  const matches: Record<string, number> = {};
  for (const r of d.stats) {
    const pos = String(r.position ?? '').replace('POSITION_', '');
    if (!/^[1-5]$/.test(pos)) continue;
    if (r.time === 0) matches[pos] = r.matchCount;
    if (!(STRATZ_CURVE_MINUTES as readonly number[]).includes(r.time)) continue;
    const c = (curves[pos] ??= { n: 0, at: {} });
    c.n = Math.max(c.n, r.matchCount);
    if (r.matchCount >= MIN_MATCHES) c.at[String(r.time)] = [Math.round(r.cs * 10) / 10, Math.round(r.networth), Math.round(r.xp), Math.round(r.level * 10) / 10];
  }
  for (const [pos, c] of Object.entries(curves)) if (c.n < MIN_MATCHES || !Object.keys(c.at).length) delete curves[pos];
  const buys: Record<string, Record<string, { n: number; w: number; times: [number, number][] }>> = {};
  for (const pos of ['1', '2', '3', '4', '5'] as const) {
    for (const r of d[`p${pos}`] ?? []) {
      const key = itemKeyById.get(r.itemId);
      if (!key || SKIP.has(key)) continue;
      const b = ((buys[pos] ??= {})[key] ??= { n: 0, w: 0, times: [] });
      b.n += r.matchCount;
      b.w += r.winCount;
      b.times.push([r.time, r.matchCount]);
    }
  }
  const items: RankedHero['items'] = {};
  for (const [pos, list] of Object.entries(buys)) {
    const total = matches[pos] ?? curves[pos]?.n ?? 0;
    if (total < MIN_MATCHES) continue;
    items[pos] = Object.entries(list)
      .map(([key, b]) => ({ key, share: Math.round((b.n / total) * 1000) / 1000, medianMin: weightedMedian(b.times) ?? -1, winrate: Math.round((b.w / b.n) * 1000) / 1000 }))
      .filter((x) => x.share >= ITEM_MIN_SHARE && x.medianMin >= 0)
      .sort((a, b) => a.medianMin - b.medianMin)
      .slice(0, ITEMS_KEEP);
  }
  return { id: hero.id, key: hero.key, matches, curves, items };
}
