// Честная статистика: доверие к советам и тренды ошибок. Только посчитанное по матчам; мало данных — так и пишем,
// чисел не придумываем. Чистое ядро.
import { MISTAKE_TITLE_RU } from './labels.ts';
import type { MatchRecord } from './types.ts';

/** Меньше стольких случаев в любой из двух групп («следовали» и «нет») — процент не показываем */
export const TRUST_MIN_SAMPLES = 8;

export interface TrustStat {
  /** «Отходи», «Не вступай» */
  advice: string;
  followed: { n: number; survived: number };
  ignored: { n: number; survived: number };
  /** Проценты — только если в обеих группах хватает случаев */
  enough: boolean;
  followedPct: number | null;
  ignoredPct: number | null;
}

/** По совету: когда следовали — выжили в X%, когда нет — в Y% (только советы, где проверяется «выжил») */
export function trustStats(records: readonly MatchRecord[], min = TRUST_MIN_SAMPLES): TrustStat[] {
  const by = new Map<string, TrustStat>();
  for (const o of records.flatMap((r) => r.outcomes)) {
    if (o.survived === null || o.result === 'unclear') continue;
    const s = by.get(o.short) ?? { advice: o.short, followed: { n: 0, survived: 0 }, ignored: { n: 0, survived: 0 }, enough: false, followedPct: null, ignoredPct: null };
    const g = o.result === 'acted' ? s.followed : s.ignored;
    g.n++;
    if (o.survived) g.survived++;
    by.set(o.short, s);
  }
  return [...by.values()]
    .map((s) => {
      const enough = s.followed.n >= min && s.ignored.n >= min;
      return { ...s, enough, followedPct: enough ? Math.round((100 * s.followed.survived) / s.followed.n) : null, ignoredPct: enough ? Math.round((100 * s.ignored.survived) / s.ignored.n) : null };
    })
    .sort((a, b) => b.followed.n + b.ignored.n - (a.followed.n + a.ignored.n));
}

export interface MistakeTrend {
  type: string;
  title: string;
  /** Сколько раз за каждый из последних матчей (старые первыми) */
  perMatch: number[];
  /** Среднее за первую и вторую половину ряда; стало реже — down */
  before: number;
  after: number;
  direction: 'down' | 'up' | 'flat';
}

/** Три самые частые ошибки за последние matches матчей и как они менялись */
export function mistakeTrends(records: readonly MatchRecord[], matches = 20, top = 3): MistakeTrend[] {
  const rs = records.slice(-matches);
  if (rs.length < 2) return [];
  const totals = new Map<string, number>();
  for (const r of rs) for (const [t, n] of Object.entries(r.mistakes)) totals.set(t, (totals.get(t) ?? 0) + n);
  const half = Math.floor(rs.length / 2);
  const mean = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 10) / 10 : 0);
  return [...totals]
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([type]) => {
      const perMatch = rs.map((r) => r.mistakes[type] ?? 0);
      const before = mean(perMatch.slice(0, half));
      const after = mean(perMatch.slice(half));
      const direction = after <= before * 0.8 ? 'down' : after >= before * 1.2 && after - before >= 0.5 ? 'up' : 'flat';
      return { type, title: MISTAKE_TITLE_RU[type] ?? type, perMatch, before, after, direction };
    });
}
