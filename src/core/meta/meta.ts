// Мета патча: сильные герои по позициям и изменения героев в патчах. Чистое ядро: без сети и файлов.
//  - сила героя: доля побед в выбранных рангах по OpenDota heroStats (свежие публичные матчи), сжатая к средней
//    по числу игр (у редкого героя случайные 60 % не выводят его в топ);
//  - позиция: где героя играют сильные игроки рейтинга (STRATZ, доля матчей на позиции); нет данных — роли базы знаний;
//  - тренд: разница с прежним замером не моложе TREND_MIN_AGE_MS;
//  - изменения: официальные описания патчей Valve (datafeed/patchnotes), способности — по названиям из базы знаний.
import type { KbHero } from '../../shared/types/kb.ts';
import type { StatsRanked } from '../../shared/types/stats-ranked.ts';
import { META_BRACKETS, type MetaBracket, type MetaChangeNote, type MetaHeroRow } from '../../shared/types/meta.ts';

/** Одна запись OpenDota /api/heroStats (нужные поля): «N_pick», «N_win» по рангам 1…8 */
export type OdHeroStat = { id: number } & Record<string, unknown>;

/** Замер долей побед: id героя → ранг → [игр, побед] */
export interface MetaSnapshot {
  at: number;
  heroes: Record<string, Record<string, [number, number]>>;
}

/** Сжатие к средней: столько «средних» игр добавляется к герою */
export const SHRINK_PICKS = 2000;
/** Меньше игр в выбранных рангах — герой в топ не попадает */
export const MIN_PICKS = 1500;
/** Позиция героя, если на ней не меньше этой доли его игр у сильных игроков */
export const POSITION_MIN_SHARE = 0.15;
/** Тренд: прежний замер не моложе 3 дней (раньше разница — шум), изменение не меньше 0,5 п.п. */
export const TREND_MIN_AGE_MS = 3 * 24 * 3600_000;
export const TREND_MIN_PP = 0.5;
export const TOP_N = 10;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Игры и победы героя в группе рангов */
export function bracketTotals(s: OdHeroStat, bracket: MetaBracket): [number, number] {
  let picks = 0;
  let wins = 0;
  for (const b of META_BRACKETS[bracket].ids) {
    picks += num(s[`${b}_pick`]);
    wins += num(s[`${b}_win`]);
  }
  return [picks, wins];
}

/** Замер для истории трендов: по каждому герою и рангу 1…8 */
export function snapshotOf(stats: readonly OdHeroStat[], at: number): MetaSnapshot {
  const heroes: MetaSnapshot['heroes'] = {};
  for (const s of stats) {
    const r: Record<string, [number, number]> = {};
    for (let b = 1; b <= 8; b++) r[b] = [num(s[`${b}_pick`]), num(s[`${b}_win`])];
    heroes[String(s.id)] = r;
  }
  return { at, heroes };
}

/** Прежний замер для тренда: самый свежий из тех, что не моложе TREND_MIN_AGE_MS */
export function trendBase(history: readonly MetaSnapshot[], now: number): MetaSnapshot | null {
  const old = history.filter((h) => now - h.at >= TREND_MIN_AGE_MS).sort((a, b) => b.at - a.at);
  return old[0] ?? null;
}

/** Позиции героя: доля игр на позиции у сильных игроков (STRATZ) или по главной роли базы знаний */
export function heroPositionShares(hero: KbHero, ranked: StatsRanked | null): { shares: Record<string, number>; from: 'stratz' | 'roles' } {
  const r = ranked?.heroes.find((h) => h.id === hero.id);
  const total = r ? Object.values(r.matches).reduce((a, b) => a + b, 0) : 0;
  if (r && total >= 300) {
    const shares: Record<string, number> = {};
    for (const [p, n] of Object.entries(r.matches)) shares[p] = n / total;
    return { shares, from: 'stratz' };
  }
  const main = hero.roles[0];
  const pos = main === 'Carry' ? ['1', '2'] : main === 'Support' ? ['4', '5'] : ['2', '3'];
  return { shares: Object.fromEntries(pos.map((p) => [p, 1 / pos.length])), from: 'roles' };
}

export interface MetaInput {
  stats: readonly OdHeroStat[];
  heroes: readonly KbHero[];
  ranked: StatsRanked | null;
  bracket: MetaBracket;
  /** Прежний замер для тренда; null — тренда нет */
  base: MetaSnapshot | null;
  /** id героев, изменённых в последнем патче */
  changedInLatest: ReadonlySet<number>;
  top?: number;
}

/** Лучшие герои: «0» — все позиции, «1»…«5» — по позициям */
export function buildMeta(input: MetaInput): { positions: Record<string, MetaHeroRow[]>; positionsFrom: 'stratz' | 'roles' } {
  const byId = new Map(input.heroes.map((h) => [h.id, h]));
  let allPicks = 0;
  let allWins = 0;
  const rows: { row: MetaHeroRow; score: number; shares: Record<string, number> }[] = [];
  let fromStratz = 0;
  for (const s of input.stats) {
    const [p, w] = bracketTotals(s, input.bracket);
    allPicks += p;
    allWins += w;
  }
  const mean = allPicks ? allWins / allPicks : 0.5;
  // героев в матче 10 — доля матчей с героем = его игры / (все игры / 10)
  const matches = allPicks / 10;
  for (const s of input.stats) {
    const hero = byId.get(s.id);
    if (!hero) continue;
    const [picks, wins] = bracketTotals(s, input.bracket);
    if (picks < MIN_PICKS) continue;
    const winrate = wins / picks;
    const score = (wins + mean * SHRINK_PICKS) / (picks + SHRINK_PICKS);
    let trend: number | null = null;
    const old = input.base?.heroes[String(s.id)];
    if (old) {
      let op = 0;
      let ow = 0;
      for (const b of META_BRACKETS[input.bracket].ids) {
        op += old[b]?.[0] ?? 0;
        ow += old[b]?.[1] ?? 0;
      }
      if (op >= MIN_PICKS) {
        const d = Math.round((winrate - ow / op) * 1000) / 10;
        if (Math.abs(d) >= TREND_MIN_PP) trend = d;
      }
    }
    const pos = heroPositionShares(hero, input.ranked);
    if (pos.from === 'stratz') fromStratz++;
    rows.push({
      row: { hero: hero.key, name: hero.name, winrate, picks, pickRate: matches ? picks / matches : 0, trend, positionShare: null, changedInLatest: input.changedInLatest.has(hero.id) },
      score,
      shares: pos.from === 'stratz' ? pos.shares : Object.fromEntries(Object.keys(pos.shares).map((k) => [k, -1])),
    });
  }
  rows.sort((a, b) => b.score - a.score);
  const top = input.top ?? TOP_N;
  // Десятку отбираем по сжатой оценке (редкий герой со случайными 60 % в неё не попадёт), а показываем по видимой
  // доле побед — иначе 54,3 % ниже 54,2 % выглядит ошибкой
  const byShown = (list: typeof rows) => list.slice(0, top).sort((a, b) => b.row.winrate - a.row.winrate);
  const positions: Record<string, MetaHeroRow[]> = { '0': byShown(rows).map((r) => r.row) };
  for (const p of ['1', '2', '3', '4', '5']) {
    positions[p] = byShown(rows.filter((r) => (r.shares[p] ?? 0) >= POSITION_MIN_SHARE || r.shares[p] === -1))
      .map((r) => ({ ...r.row, positionShare: r.shares[p] === -1 ? null : Math.round(r.shares[p]! * 100) / 100 }));
  }
  return { positions, positionsFrom: rows.length > 0 && fromStratz >= rows.length / 2 ? 'stratz' : 'roles' };
}

/** Описание патча Valve (datafeed/patchnotes) — нужные поля; лишнее и неожиданное пропускается */
export interface ValvePatchNotes {
  patch_number?: string;
  patch_timestamp?: number;
  heroes?: {
    hero_id?: number;
    hero_notes?: { note?: string; indent_level?: number }[];
    talent_notes?: { note?: string; indent_level?: number }[];
    abilities?: { ability_id?: number; ability_notes?: { note?: string; indent_level?: number }[] }[];
    facets?: { facet?: string; title_loc?: string; facet_notes?: { note?: string; indent_level?: number }[]; abilities?: { ability_id?: number; ability_notes?: { note?: string; indent_level?: number }[] }[] }[];
  }[];
}

/** Текст заметки без разметки Valve (<b>, <br>, &nbsp; и т. п.) */
export function cleanNote(s: string): string {
  return s
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Изменения героев одного патча: id героя → заметки (по порядку: герой, способности, аспекты, таланты) */
export function heroNotes(p: ValvePatchNotes, heroes: readonly KbHero[]): Map<number, MetaChangeNote[]> {
  const abilityName = new Map<number, string>();
  for (const h of heroes) for (const a of h.abilities) if (typeof a.id === 'number') abilityName.set(a.id, a.name);
  const out = new Map<number, MetaChangeNote[]>();
  const push = (list: MetaChangeNote[], title: string, notes: { note?: string; indent_level?: number }[] | undefined) => {
    for (const n of notes ?? []) {
      const text = typeof n.note === 'string' ? cleanNote(n.note) : '';
      if (text) list.push({ title, text, indent: Math.max(0, Math.min(3, (n.indent_level ?? 1) - 1)) });
    }
  };
  for (const h of p.heroes ?? []) {
    if (typeof h.hero_id !== 'number') continue;
    const list: MetaChangeNote[] = [];
    push(list, 'Герой', h.hero_notes);
    for (const a of h.abilities ?? []) push(list, (a.ability_id !== undefined && abilityName.get(a.ability_id)) || 'Способность', a.ability_notes);
    for (const f of h.facets ?? []) {
      const title = `Аспект${f.title_loc ? ` «${cleanNote(f.title_loc)}»` : ''}`;
      push(list, title, f.facet_notes);
      for (const a of f.abilities ?? []) push(list, (a.ability_id !== undefined && abilityName.get(a.ability_id)) || title, a.ability_notes);
    }
    push(list, 'Таланты', h.talent_notes);
    if (list.length) out.set(h.hero_id, list);
  }
  return out;
}

/** Версии текущего патча (7.41, 7.41a … 7.41f) из списка Valve — от новых к старым */
export function currentPatchFamily(list: readonly { patch_number: string; patch_timestamp?: number }[]): { version: string; date: string | null }[] {
  if (!list.length) return [];
  const sorted = [...list].sort((a, b) => (b.patch_timestamp ?? 0) - (a.patch_timestamp ?? 0));
  const base = /^(\d+\.\d+)/.exec(sorted[0]!.patch_number)?.[1];
  if (!base) return [];
  return sorted
    .filter((p) => p.patch_number === base || new RegExp(`^${base.replace('.', '\\.')}[a-z]$`).test(p.patch_number))
    .map((p) => ({ version: p.patch_number, date: p.patch_timestamp ? new Date(p.patch_timestamp * 1000).toISOString() : null }));
}
