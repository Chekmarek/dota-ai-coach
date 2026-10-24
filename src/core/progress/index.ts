// Прогресс игрока (docs/PROGRESS.md): опыт только за улучшение, звания, серия, достижения, честная статистика.
// Чистое ядро.
import { ACHIEVEMENTS, newAchievements } from './achievements.ts';
import { TRUST_MIN_SAMPLES, mistakeTrends, trustStats, type MistakeTrend, type TrustStat } from './stats.ts';
import { streakOf, type StreakInfo } from './streak.ts';
import { levelOf, matchXp, type LevelInfo } from './xp.ts';
import type { MatchAward, MatchRecord } from './types.ts';

export * from './types.ts';
export * from './xp.ts';
export * from './streak.ts';
export * from './achievements.ts';
export * from './stats.ts';

/** Хранимое: записи матчей, опыт за каждый, полученные достижения */
export interface ProgressState {
  version: 1;
  records: MatchRecord[];
  awards: MatchAward[];
  achievements: Record<string, { at: string; matchKey: string }>;
}

export const emptyProgress = (): ProgressState => ({ version: 1, records: [], awards: [], achievements: {} });

/** Сколько записей матчей хранить */
export const MAX_RECORDS = 2000;

/** Награда за только что законченный матч: опыт, звание до и после, новые достижения */
export interface ProgressAward {
  award: MatchAward;
  before: LevelInfo;
  after: LevelInfo;
  achievements: { id: string; title: string; how: string }[];
  streak: StreakInfo;
}

const totalXp = (s: ProgressState) => s.awards.reduce((a, b) => a + b.total, 0);

/**
 * Добавить законченный матч: опыт по правилам и новые достижения. Тот же матч второй раз — null (ничего не
 * меняется). Возвращает новое состояние (старое не трогает).
 */
export function addMatch(state: ProgressState, record: MatchRecord, nowIso: string): { state: ProgressState; award: ProgressAward } | null {
  if (state.records.some((r) => r.key === record.key)) return null;
  const records = [...state.records, record].sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.key.localeCompare(b.key));
  const index = records.findIndex((r) => r.key === record.key);
  const before = levelOf(totalXp(state));
  const award = matchXp(records, index, state.awards);
  const upTo = records.slice(0, index + 1);
  const fresh = newAchievements(upTo, new Set(Object.keys(state.achievements)));
  const achievements = { ...state.achievements };
  for (const a of fresh) achievements[a.id] = { at: nowIso, matchKey: record.key };
  const next: ProgressState = { version: 1, records: records.slice(-MAX_RECORDS), awards: [...state.awards, award].slice(-MAX_RECORDS), achievements };
  return { state: next, award: { award, before, after: levelOf(totalXp(next)), achievements: fresh.map((a) => ({ id: a.id, title: a.title, how: a.how })), streak: streakOf(upTo) } };
}

/** Всё для страницы «Прогресс» */
export interface ProgressView {
  level: LevelInfo;
  streak: StreakInfo;
  matches: number;
  /** Опыт за последние матчи (новые первыми) */
  recent: { key: string; startedAt: string; total: number; items: MatchAward['items'] }[];
  achievements: { id: string; title: string; how: string; earnedAt: string | null }[];
  trends: MistakeTrend[];
  trust: TrustStat[];
  /** Сколько случаев нужно в каждой группе, чтобы показать проценты доверия */
  trustMin: number;
}

export function progressView(state: ProgressState): ProgressView {
  const byKey = new Map(state.awards.map((a) => [a.key, a]));
  return {
    level: levelOf(totalXp(state)),
    streak: streakOf(state.records),
    matches: state.records.length,
    recent: [...state.records]
      .reverse()
      .slice(0, 10)
      .map((r) => ({ key: r.key, startedAt: r.startedAt, total: byKey.get(r.key)?.total ?? 0, items: byKey.get(r.key)?.items ?? [] })),
    achievements: ACHIEVEMENTS.map((a) => ({ id: a.id, title: a.title, how: a.how, earnedAt: state.achievements[a.id]?.at ?? null })),
    trends: mistakeTrends(state.records),
    trust: trustStats(state.records),
    trustMin: TRUST_MIN_SAMPLES,
  };
}
