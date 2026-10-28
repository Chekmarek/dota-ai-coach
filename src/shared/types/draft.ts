// Страница «Драфт»: запрос из интерфейса и ответ main (подбор героя, угрозы врагов, предметы против них).
import { z } from 'zod';

const heroKey = z.string().regex(/^[a-z0-9_]{2,40}$/);

export const draftRequestSchema = z.object({
  allies: z.array(heroKey).max(5),
  enemies: z.array(heroKey).max(5),
  bans: z.array(heroKey).max(30).default([]),
  /** Желаемая позиция 1–5; null — любая */
  position: z.number().int().min(1).max(5).nullable().default(null),
  /** Мой герой (если уже выбран) — для предметов против врагов и слабых матчапов */
  me: heroKey.nullable().default(null),
  /** Чья статистика: обычные матчи (рейтинговый All Pick) или Турбо; интерфейс берёт режим игры, его можно сменить; нет поля — обычные */
  mode: z.enum(['normal', 'turbo']).optional(),
});

export type DraftRequest = z.infer<typeof draftRequestSchema>;

export interface DraftReasonView {
  hero: string;
  name: string;
  /** Вклад в шанс победы, доля (0.021 = +2,1 п.п.) */
  delta: number;
  games: number;
}

export interface DraftCandidateView {
  hero: string;
  name: string;
  score: number;
  vsEnemies: DraftReasonView[];
  withAllies: DraftReasonView[];
  meta: number;
  positions: number[];
  covered: number;
}

export interface DraftThreatView {
  id: string;
  nameRu: string;
  whyRu: string;
  heroes: string[];
  urgent: boolean;
  items: { key: string; name: string; cost: number | null; role: 'core' | 'support' | 'any' }[];
}

export interface DraftResult {
  candidates: DraftCandidateView[];
  threats: DraftThreatView[];
  /** Для моего героя: против кого тяжелее всего и с кем хорошо */
  me: { hero: string; name: string; role: 'core' | 'support'; worst: DraftReasonView[]; best: DraftReasonView[] } | null;
  /** Есть ли в статистике связки (старый stats.json — нет) */
  hasSynergy: boolean;
  /** Выбранные герои (союзники, враги, мой), у которых нет записи в статистике: их вклад не учтён. Нет поля — старый main */
  noStats?: string[];
  /** Режим статистики и сколько в ней матчей (подпись «Турбо, патч X, N игр»); нет полей — старый main */
  mode?: 'normal' | 'turbo';
  statsMatches?: number | null;
  patch: string | null;
  statsAt: string | null;
  error: string | null;
}

/** Герои текущего матча (для кнопки «Взять из матча») */
export interface DraftLiveHeroes {
  inGame: boolean;
  me: string | null;
  allies: string[];
  enemies: string[];
  /** Герои взяты с экрана выбора героев (до начала игры) */
  fromDraft?: boolean;
}
