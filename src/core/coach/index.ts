// Движок подсказок (этап 2): быстрые правила + слой ИИ + очередь. Чистое ядро.
export * from './types.ts';
export { CoachEngine, ALL_RULES, ADVICE_EVERY_MS, type CoachUpdate, type CoachEngineOptions, type JournalEntry } from './engine.ts';
export { CoachAi, AI_TIMEOUT_MS, AI_BACKOFF_MS, type CoachAiStats } from './ai.ts';
export { CoachLookup, type CoachData } from './data.ts';
export { HintQueue, DEFAULT_QUEUE_CONFIG, type QueueConfig, type DropReason } from './queue.ts';
export { estimate, engagePercent, matchupPercent, actionChoice, type ActionChoice } from './prob.ts';
export { MISTAKE_RU, type Mistake, type MistakeType } from './mistakes.ts';
export type { DeathReview, MatchReview } from './reviews.ts';
export { buildView, type CoachView } from './view.ts';
