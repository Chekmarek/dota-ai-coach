// Режим игры (Турбо, All Pick, другое) по телу GSI. Ничего не угадывает: нет признака — «неизвестен».
// Имена режимов — перечисление Valve DOTA_GameMode (protobuf dota_shared_enums.proto, зеркало
// github.com/SteamDatabase/GameTracking-Dota2): DOTA_GAMEMODE_AP = 1, DOTA_GAMEMODE_ALL_DRAFT = 22
// (так называется матчмейкинговый All Pick, в OpenDota — game_mode 22), DOTA_GAMEMODE_TURBO = 23.
// Поля map.game_mode в GSI игрока нет: проверено на настоящих записях — Hero Demo (2026-10-13) и лобби на обычной
// карте (2026-10-16, 23 347 тел). Оно разбирается на случай, если Valve его добавит, а главный признак — часы матча
// в начале подготовки (GameModeTracker). Не вышло — «неизвестен», у пользователя есть ручной выбор (hints.gameMode).
// Чистое ядро: без Electron, DOM, сети и файлов.

export type GameMode = 'all-pick' | 'turbo' | 'other' | 'unknown';

/**
 * Как узнали режим: gsi — map.game_mode; clock — по часам матча в начале подготовки; pace — по темпу игры (уровень
 * своего героя к минуте, коуч подключился посреди матча); custom-game — пользовательская игра (Hero Demo и т. п.);
 * manual — выбор пользователя
 */
export type GameModeSource = 'gsi' | 'clock' | 'pace' | 'custom-game' | 'manual' | 'none';

export interface GameModeInfo {
  mode: GameMode;
  source: GameModeSource;
  /** Значение из игры как есть (DOTA_GAMEMODE_TURBO, hero_demo…); null — не приходило */
  raw: string | null;
}

/** Ручной выбор режима в настройках: auto — по данным игры */
export const GAME_MODE_OVERRIDES = ['auto', 'turbo', 'normal'] as const;
export type GameModeOverride = (typeof GAME_MODE_OVERRIDES)[number];

const MODES: readonly GameMode[] = ['all-pick', 'turbo', 'other', 'unknown'];
const SOURCES: readonly GameModeSource[] = ['gsi', 'clock', 'pace', 'custom-game', 'manual', 'none'];

/** Проверка режима, пришедшего от другого процесса: неверная форма → null */
export function asGameModeInfo(v: unknown): GameModeInfo | null {
  if (!isObj(v)) return null;
  const { mode, source, raw } = v;
  if (!MODES.includes(mode as GameMode) || !SOURCES.includes(source as GameModeSource)) return null;
  if (raw !== null && (typeof raw !== 'string' || raw.length > 200)) return null;
  return { mode: mode as GameMode, source: source as GameModeSource, raw: raw as string | null };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Сколько режим из GSI считается свежим (как статус «данные идут»: heartbeat Dota — 30 с) */
export const GSI_MODE_FRESH_MS = 35_000;

export const UNKNOWN_MODE: GameModeInfo = { mode: 'unknown', source: 'none', raw: null };

/** Номера из того же перечисления Valve — на случай, если поле придёт числом */
const BY_NUMBER: Record<number, string> = { 0: 'DOTA_GAMEMODE_NONE', 1: 'DOTA_GAMEMODE_AP', 22: 'DOTA_GAMEMODE_ALL_DRAFT', 23: 'DOTA_GAMEMODE_TURBO' };

function fromValveName(name: string): GameMode {
  if (name === 'DOTA_GAMEMODE_TURBO') return 'turbo';
  if (name === 'DOTA_GAMEMODE_AP' || name === 'DOTA_GAMEMODE_ALL_DRAFT') return 'all-pick';
  if (name === 'DOTA_GAMEMODE_NONE' || name === '') return 'unknown';
  return 'other';
}

/**
 * Режим по телу GSI. null — в теле нет блока map (меню, пустой запрос): о режиме тело ничего не говорит,
 * прежнее значение не сбрасывается.
 */
export function detectGameMode(body: unknown): GameModeInfo | null {
  if (!isObj(body) || !isObj(body.map)) return null;
  const map = body.map;
  const gm = map.game_mode;
  if (typeof gm === 'string' || (typeof gm === 'number' && Number.isInteger(gm))) {
    const name = typeof gm === 'number' ? (BY_NUMBER[gm] ?? `DOTA_GAMEMODE_${gm}`) : gm.trim();
    const mode = fromValveName(name);
    if (mode !== 'unknown') return { mode, source: 'gsi', raw: name };
  }
  // Пользовательская игра: Hero Demo присылает путь к аддону в customgamename (настоящая запись 2026-10-13)
  const custom = typeof map.customgamename === 'string' ? map.customgamename.trim() : '';
  if (custom !== '') {
    const addon = custom.split(/[\\/]/).filter(Boolean).pop() ?? custom;
    return { mode: 'other', source: 'custom-game', raw: addon };
  }
  return { ...UNKNOWN_MODE };
}

/**
 * С каких часов матча начинается подготовка (PRE_GAME), секунды. Источник: Liquipedia «Time of Day» (ревизия
 * 2414032): −90 — обычный матч, −75 — игра против ботов, −60 — Турбо. −89 подтверждено настоящей записью лобби
 * (tests/fixtures/gsi/recorded/lobby-normal.jsonl). Режим «для новичков» стартует с −90 по правилам Турбо —
 * его по часам не отличить (будет «обычный»).
 */
export const CLOCK_STARTS: readonly { at: number; mode: GameMode; raw: string }[] = [
  { at: -90, mode: 'all-pick', raw: 'start -1:30' },
  { at: -75, mode: 'other', raw: 'bots' },
  { at: -60, mode: 'turbo', raw: 'start -1:00' },
];
/** Допуск по часам: первое тело подготовки приходит в пределах секунды-двух от её начала */
export const CLOCK_START_TOLERANCE = 4;
/** Переход «выбор героев → подготовка» засчитывается, если тела шли подряд (не было паузы GSI) */
export const MODE_TRANSITION_MS = 5000;

/**
 * Режим по темпу игры — когда коуч подключился посреди матча и начала подготовки не видел. Уровень своего героя
 * к минуте: в Турбо опыта вдвое больше. На 150 матчах All Pick и 150 Турбо (STRATZ, обучающие наборы), часы 9–25 мин:
 * уровень/минуту ≥ 1,0 — у All Pick в 0,03% замеров, у Турбо в 85%; ≤ 0,8 — у All Pick в 97,5%, у Турбо в 2%
 * (почти всё — после 25 мин, когда Турбо упирается в 30-й уровень, поэтому окно — до 25 мин).
 * Решение — если замеры подряд согласны PACE_STREAK_SEC с часов; сменить уже принятое — PACE_FLIP_SEC.
 */
export const PACE = { fromSec: 540, toSec: 1500, turboAtLeast: 1.0, normalAtMost: 0.8 } as const;
export const PACE_STREAK_SEC = 30;
export const PACE_FLIP_SEC = 120;

/** Голос по одному замеру темпа: уровень героя на часах матча; null — не решает */
export function paceVote(level: number, clockSec: number): 'turbo' | 'all-pick' | null {
  if (clockSec < PACE.fromSec || clockSec > PACE.toSec || !(level >= 1)) return null;
  const r = level / (clockSec / 60);
  return r >= PACE.turboAtLeast ? 'turbo' : r <= PACE.normalAtMost ? 'all-pick' : null;
}

const PRE_GAME = 'DOTA_GAMERULES_STATE_PRE_GAME';
const IN_PROGRESS = 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
const BEFORE_PRE_GAME = new Set([
  'DOTA_GAMERULES_STATE_INIT',
  'DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD',
  'DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD',
  'DOTA_GAMERULES_STATE_HERO_SELECTION',
  'DOTA_GAMERULES_STATE_STRATEGY_TIME',
  'DOTA_GAMERULES_STATE_TEAM_SHOWCASE',
]);

/** Режим по часам в первом теле подготовки; null — часы ни к одному старту не подходят */
export function modeFromClockStart(clock: number): GameModeInfo | null {
  const hit = CLOCK_STARTS.find((s) => Math.abs(clock - s.at) <= CLOCK_START_TOLERANCE);
  return hit ? { mode: hit.mode, source: 'clock', raw: hit.raw } : null;
}

/**
 * Режим по потоку тел GSI одного игрока. Порядок: map.game_mode (если появится) → пользовательская игра →
 * часы в начале подготовки (виден переход «выбор героев → подготовка» без паузы) → темп игры (подключились посреди
 * матча) → «неизвестен». При «неизвестен» коуч работает по правилам и моделям обычной игры (CoachLookup.isTurbo).
 * Подготовка с часами ниже −85 бывает только в обычном матче — это засчитывается и без перехода.
 * Новый матч (снова выбор героев после игры или другой matchid) сбрасывает режим по часам.
 */
export class GameModeTracker {
  private prevState: string | null = null;
  private prevMs: number | null = null;
  private matchId: string | null = null;
  private byClock: GameModeInfo | null = null;
  private byPace: GameModeInfo | null = null;
  private pace: { vote: 'turbo' | 'all-pick'; since: number } | null = null;
  private current: GameModeInfo | null = null;

  /** Режим после этого тела; null — тел с блоком map ещё не было */
  feed(body: unknown, wallMs: number): GameModeInfo | null {
    if (!isObj(body) || !isObj(body.map)) return this.current;
    const map = body.map;
    const state = typeof map.game_state === 'string' ? map.game_state : null;
    const clock = typeof map.clock_time === 'number' && Number.isFinite(map.clock_time) ? map.clock_time : null;
    const matchId = typeof map.matchid === 'string' && map.matchid !== '0' ? map.matchid : null;
    if (matchId !== null && this.matchId !== null && matchId !== this.matchId) this.resetMatch();
    if (matchId !== null) this.matchId = matchId;
    if (state !== null && BEFORE_PRE_GAME.has(state) && this.prevState !== null && !BEFORE_PRE_GAME.has(this.prevState)) this.resetMatch();
    if (state === PRE_GAME && clock !== null) {
      const transition = this.prevState !== null && BEFORE_PRE_GAME.has(this.prevState) && this.prevMs !== null && wallMs - this.prevMs <= MODE_TRANSITION_MS;
      if (transition) this.byClock = modeFromClockStart(clock);
      else if (!this.byClock && clock <= CLOCK_STARTS[0]!.at + 5) this.byClock = modeFromClockStart(CLOCK_STARTS[0]!.at);
    }
    if (state === IN_PROGRESS && clock !== null && !this.byClock) this.feedPace(isObj(body.hero) ? body.hero.level : null, clock);
    if (state !== null) this.prevState = state;
    this.prevMs = wallMs;
    const d = detectGameMode(body)!;
    this.current = d.mode !== 'unknown' ? d : (this.byClock ?? this.byPace ?? d);
    return this.current;
  }

  private resetMatch(): void {
    this.byClock = null;
    this.byPace = null;
    this.pace = null;
  }

  private feedPace(level: unknown, clock: number): void {
    const vote = typeof level === 'number' ? paceVote(level, clock) : null;
    if (vote === null) {
      if (clock >= PACE.fromSec && clock <= PACE.toSec) this.pace = null;
      return;
    }
    if (this.pace?.vote !== vote) this.pace = { vote, since: clock };
    const need = this.byPace && this.byPace.mode !== vote ? PACE_FLIP_SEC : PACE_STREAK_SEC;
    if (clock - this.pace.since >= need && this.byPace?.mode !== vote) this.byPace = { mode: vote, source: 'pace', raw: `level ${level} at ${Math.floor(clock / 60)}:${String(Math.floor(clock % 60)).padStart(2, '0')}` };
  }

  get mode(): GameModeInfo | null {
    return this.current;
  }
}

/** Итоговый режим: ручной выбор пользователя важнее данных игры */
export function resolveGameMode(detected: GameModeInfo | null, override: GameModeOverride): GameModeInfo {
  if (override === 'turbo') return { mode: 'turbo', source: 'manual', raw: detected?.raw ?? null };
  if (override === 'normal') return { mode: 'all-pick', source: 'manual', raw: detected?.raw ?? null };
  return detected ?? { ...UNKNOWN_MODE };
}

/** Подпись для интерфейса */
export function gameModeRu(info: GameModeInfo): string {
  if (info.source === 'manual') return info.mode === 'turbo' ? 'Турбо (выбран вручную)' : 'Обычный режим (выбран вручную)';
  if (info.mode === 'all-pick') return info.source === 'clock' || info.source === 'pace' ? 'Обычный режим' : 'All Pick';
  if (info.mode === 'other') return info.raw === 'hero_demo' ? 'Hero Demo' : info.raw === 'bots' ? 'Игра против ботов' : 'другой режим';
  return info.mode === 'turbo' ? 'Турбо' : 'режим неизвестен';
}

/** Текст индикатора режима: что включено и откуда коуч это взял (чтобы сразу было видно, если режим не тот) */
export function modeBannerText(info: GameModeInfo): { title: string; text: string } {
  const how =
    info.source === 'manual'
      ? 'Выбран вручную в настройках коуча'
      : info.source === 'clock'
        ? `По часам матча: подготовка с ${info.mode === 'turbo' ? '−1:00' : '−1:30'}`
        : info.source === 'pace'
          ? 'По темпу игры: уровень героя к этой минуте · если неверно — выберите режим в настройках'
          : 'Определён по данным игры';
  if (info.mode === 'turbo') return { title: 'Турбо', text: how };
  if (info.mode === 'all-pick') return { title: info.source === 'gsi' ? 'All Pick' : 'Обычный режим', text: how };
  if (info.mode === 'other') {
    if (info.raw === 'hero_demo') return { title: 'Hero Demo', text: 'Пользовательская игра — подсказки как в обычной игре' };
    if (info.raw === 'bots') return { title: 'Игра против ботов', text: 'По часам матча: подготовка с −1:15 — подсказки как в обычной игре' };
    return { title: 'Другой режим', text: `${info.raw ?? 'Режим из игры'} — подсказки как в обычной игре` };
  }
  return { title: 'Режим не определён', text: 'Подсказки как в обычной игре · режим можно выбрать в настройках' };
}
