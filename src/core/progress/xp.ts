// Опыт и уровни. Правила — только за улучшение в игре:
//  - фокус матча выполнен: FOCUS_XP; серия выполненных фокусов — небольшой бонус;
//  - выполнили совет коуча (метрика фильтра внимания «выполнена»): HINT_XP, не больше HINT_MAX за матч;
//  - ошибка стала реже: среднее за последние IMPROVE_WINDOW матчей (с этим) меньше прошлых IMPROVE_WINDOW на
//    IMPROVE_DROP и больше — IMPROVE_XP; за тот же тип — не чаще раза в IMPROVE_WINDOW матчей.
// За запуск приложения, просмотр страниц и просто сыгранный матч — ничего. Чистое ядро.
import { MISTAKE_TITLE_RU, focusTitleById } from './labels.ts';
import { streakOf } from './streak.ts';
import type { MatchAward, MatchRecord, XpItem } from './types.ts';

export const FOCUS_XP = 100;
export const STREAK_XP_PER = 10;
export const STREAK_XP_MAX = 50;
export const HINT_XP = 10;
export const HINT_MAX = 5;
export const IMPROVE_XP = 50;
export const IMPROVE_WINDOW = 5;
/** «Реже» — минимум на четверть */
export const IMPROVE_DROP = 0.25;
/** Ошибка, которой и так почти не было (меньше раза в матч), улучшением не считается */
export const IMPROVE_MIN_PREV = 1;

const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);

/** Средняя частота ошибки: последние n матчей (до index включительно) и n перед ними; не хватает матчей — null */
export function mistakeWindows(records: readonly MatchRecord[], index: number, type: string, n = IMPROVE_WINDOW): { last: number; prev: number } | null {
  if (index + 1 < 2 * n) return null;
  const last = records.slice(index + 1 - n, index + 1).map((r) => r.mistakes[type] ?? 0);
  const prev = records.slice(index + 1 - 2 * n, index + 1 - n).map((r) => r.mistakes[type] ?? 0);
  return { last: avg(last), prev: avg(prev) };
}

/**
 * Опыт за матч records[index] (records — по времени, старые первыми; awardedBefore — выданное раньше, чтобы
 * «ошибка стала реже» не платилась каждый матч за одно и то же).
 */
export function matchXp(records: readonly MatchRecord[], index: number, awardedBefore: readonly MatchAward[] = []): MatchAward {
  const r = records[index]!;
  const items: XpItem[] = [];
  if (r.focus?.achieved === true) {
    items.push({ reason: 'focus', xp: FOCUS_XP, label: `Фокус выполнен: ${focusTitleById(r.focus.id, r.turbo)}` });
    const streak = streakOf(records.slice(0, index + 1)).current;
    if (streak >= 2) items.push({ reason: 'streak', xp: Math.min(STREAK_XP_MAX, STREAK_XP_PER * streak), label: `Серия фокусов: ${streak} подряд` });
  }
  const acted = r.outcomes.filter((o) => o.result === 'acted').length;
  if (acted > 0) items.push({ reason: 'hint', xp: HINT_XP * Math.min(HINT_MAX, acted), label: `Выполнили совет коуча: ${acted} ${acted === 1 ? 'раз' : acted < 5 ? 'раза' : 'раз'}` });
  // Ошибка стала реже — за тип не чаще раза в IMPROVE_WINDOW матчей
  const recentKeys = new Set(records.slice(Math.max(0, index - IMPROVE_WINDOW + 1), index).map((x) => x.key));
  const types = new Set(records.slice(Math.max(0, index + 1 - 2 * IMPROVE_WINDOW), index + 1).flatMap((x) => Object.keys(x.mistakes)));
  for (const t of [...types].sort()) {
    const w = mistakeWindows(records, index, t);
    if (!w || w.prev < IMPROVE_MIN_PREV || w.last > w.prev * (1 - IMPROVE_DROP)) continue;
    const label = `Реже: ${MISTAKE_TITLE_RU[t] ?? t}`;
    if (awardedBefore.some((a) => recentKeys.has(a.key) && a.items.some((i) => i.reason === 'improved' && i.label.startsWith(`${label} (`)))) continue;
    items.push({ reason: 'improved', xp: IMPROVE_XP, label: `${label} (${fmt(w.prev)} → ${fmt(w.last)} за матч)` });
  }
  return { key: r.key, items, total: items.reduce((s, i) => s + i.xp, 0) };
}

const fmt = (n: number) => String(Math.round(n * 10) / 10).replace('.', ',');

// ---------- Уровни ----------

/** Звания как в рейтинге Доты: 5 звёзд у каждого, кроме последнего */
export const RANKS = ['Рекрут', 'Страж', 'Рыцарь', 'Герой', 'Легенда', 'Властелин', 'Божество', 'Титан'] as const;
const STARS = 5;
export const MAX_LEVEL = (RANKS.length - 1) * STARS + 1;

/** Опыт до следующего уровня с уровня L: 100, 150, 200 … */
export const xpToNext = (level: number) => 100 + 50 * (level - 1);

export interface LevelInfo {
  level: number;
  /** «Рыцарь ★3», «Титан» */
  name: string;
  rank: string;
  stars: number;
  /** Опыт внутри уровня и сколько нужно до следующего (на последнем — null) */
  into: number;
  need: number | null;
  total: number;
}

export function levelOf(totalXp: number): LevelInfo {
  let level = 1;
  let left = Math.max(0, Math.floor(totalXp));
  while (level < MAX_LEVEL && left >= xpToNext(level)) {
    left -= xpToNext(level);
    level++;
  }
  const rankIdx = Math.min(RANKS.length - 1, Math.floor((level - 1) / STARS));
  const rank = RANKS[rankIdx]!;
  const stars = rankIdx === RANKS.length - 1 ? 0 : ((level - 1) % STARS) + 1;
  return { level, name: stars ? `${rank} ${'★'.repeat(stars)}` : rank, rank, stars, into: left, need: level < MAX_LEVEL ? xpToNext(level) : null, total: Math.max(0, Math.floor(totalXp)) };
}
