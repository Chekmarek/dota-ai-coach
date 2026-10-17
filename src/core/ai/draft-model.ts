// Тяжёлая модель только для выбора героев (решение владельца): когда её можно запускать и когда выгружать.
// Чистое ядро: стадия — из game_state GSI, «Дота на экране» — из живого захвата.
//
// Почему не inMatch(): во время выбора героев живой захват уже видит окно Доты, и inMatch() истинен —
// по нему тяжёлую модель нельзя было бы запустить никогда. Решает стадия игры из GSI.

/** draft — выбор героев (баны, пики, стратегия, показ команд); match — загрузка карты и сам матч */
export type GameStage = 'draft' | 'match' | 'other';

const DRAFT_STATES = new Set(['DOTA_GAMERULES_STATE_PLAYER_DRAFT', 'DOTA_GAMERULES_STATE_HERO_SELECTION', 'DOTA_GAMERULES_STATE_STRATEGY_TIME', 'DOTA_GAMERULES_STATE_TEAM_SHOWCASE']);
const MATCH_STATES = new Set(['DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD', 'DOTA_GAMERULES_STATE_PRE_GAME', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS']);

export function gameStage(gameState: string | null | undefined): GameStage {
  if (!gameState) return 'other';
  if (DRAFT_STATES.has(gameState)) return 'draft';
  if (MATCH_STATES.has(gameState)) return 'match';
  return 'other';
}

/**
 * Сколько считать стадию из GSI свежей. Dota шлёт данные при каждом изменении и не реже heartbeat (30 с);
 * при выборе героев запросы редкие (запись 16.10: 12 запросов за стадию HERO_SELECTION).
 */
export const STAGE_FRESH_MS = 35_000;

export interface StageInfo {
  /** Последняя стадия из GSI и когда она пришла (мс); null — GSI не приходил */
  stage: GameStage | null;
  at: number | null;
  /** Живой захват видит окно Доты */
  dotaOnScreen: boolean;
}

/**
 * Можно ли сейчас держать тяжёлую модель.
 *  - свежая стадия «выбор героев» — да;
 *  - свежая стадия «матч» или «другое» (меню после матча) при открытой Доте — нет;
 *  - GSI нет или давно молчит: только если Доты нет на экране (страница «Драфт» без игры).
 */
export function heavyModelAllowed(s: StageInfo, now: number): boolean {
  const fresh = s.stage !== null && s.at !== null && now - s.at <= STAGE_FRESH_MS;
  if (fresh && s.stage === 'draft') return true;
  if (fresh && s.stage === 'match') return false;
  return !s.dotaOnScreen;
}

/** Сейчас выбор героев (свежая стадия из GSI): потоков модели — половина ядер, FPS экрана выбора не важен */
export function inDraftStage(s: StageInfo, now: number): boolean {
  return s.stage === 'draft' && s.at !== null && now - s.at <= STAGE_FRESH_MS;
}

/** Нужно ли остановить llama-server: в нём тяжёлая модель, а держать её уже нельзя */
export function shouldUnloadHeavy(loadedModel: string | null, heavyModels: readonly string[], allowed: boolean): boolean {
  return loadedModel !== null && heavyModels.includes(loadedModel) && !allowed;
}
