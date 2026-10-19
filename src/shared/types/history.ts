// «История советов»: что сохраняется по каждому матчу (src/main/coach/history.ts).
import type { GameModeInfo } from '../../core/gsi/mode.ts';
export interface HistoryEntry {
  wallMs: number;
  /** Игровое время, с; null — неизвестно */
  clock: number | null;
  kind: 'hint' | 'mistake' | 'death-review' | 'match-review';
  id: string;
  text: string;
  source: 'template' | 'ai';
}

export interface HistoryMistake {
  type: string;
  titleRu: string;
  clock: number | null;
  text: string;
  instead: string;
  aiText: string | null;
}

export interface HistoryDeath {
  clock: number | null;
  why: string[];
  tips: string[];
  buyback: string;
  aiText: string | null;
}

export interface HistoryReview {
  result: 'win' | 'loss' | null;
  why: string[];
  goodPlays: string[];
  goals: string[];
  stats: { label: string; value: number | null; ref: number | null; refLabel: string | null; verdict: 'good' | 'ok' | 'bad' | null }[];
  timeline: { clock: number; text: string }[];
  aiText: string | null;
}

export interface HistoryMatch {
  /** Имя файла: <время начала>-<id матча> (только [0-9A-Za-z_-]) */
  id: string;
  startedAt: string;
  matchId: string | null;
  heroName: string | null;
  /** Режим игры (с 0.13.3; в старых файлах поля нет) */
  gameMode?: GameModeInfo;
  result: 'win' | 'loss' | null;
  durationSec: number | null;
  entries: HistoryEntry[];
  mistakes: HistoryMistake[];
  deathReviews: HistoryDeath[];
  matchReview: HistoryReview | null;
  /** Отметки «плохой совет» (горячая клавиша, с 0.14.2; в старых файлах поля нет) */
  badAdvice?: { id: string; markedAt: string; clock: number | null; titles: string[] }[];
}

export interface HistorySummary {
  id: string;
  startedAt: string;
  heroName: string | null;
  /** Режим игры; null — не записан (матчи до 0.13.3) */
  gameMode: GameModeInfo | null;
  result: 'win' | 'loss' | null;
  durationSec: number | null;
  hints: number;
  mistakes: number;
  deaths: number;
  /** Отметок «плохой совет» */
  badAdvice: number;
}
