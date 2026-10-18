// Режим игры (Турбо, All Pick, другое) по телу GSI. Ничего не угадывает: нет признака — «неизвестен».
// Имена режимов — перечисление Valve DOTA_GameMode (protobuf dota_shared_enums.proto, зеркало
// github.com/SteamDatabase/GameTracking-Dota2): DOTA_GAMEMODE_AP = 1, DOTA_GAMEMODE_ALL_DRAFT = 22
// (так называется матчмейкинговый All Pick, в OpenDota — game_mode 22), DOTA_GAMEMODE_TURBO = 23.
// Присылает ли Dota поле map.game_mode игроку, проверено только на Hero Demo (там поля нет) — поэтому
// у пользователя есть ручной выбор режима (настройка hints.gameMode).
// Чистое ядро: без Electron, DOM, сети и файлов.

export type GameMode = 'all-pick' | 'turbo' | 'other' | 'unknown';

/** Как узнали режим: gsi — map.game_mode; custom-game — пользовательская игра (Hero Demo и т. п.); manual — выбор пользователя */
export type GameModeSource = 'gsi' | 'custom-game' | 'manual' | 'none';

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
const SOURCES: readonly GameModeSource[] = ['gsi', 'custom-game', 'manual', 'none'];

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

/** Итоговый режим: ручной выбор пользователя важнее данных игры */
export function resolveGameMode(detected: GameModeInfo | null, override: GameModeOverride): GameModeInfo {
  if (override === 'turbo') return { mode: 'turbo', source: 'manual', raw: detected?.raw ?? null };
  if (override === 'normal') return { mode: 'all-pick', source: 'manual', raw: detected?.raw ?? null };
  return detected ?? { ...UNKNOWN_MODE };
}

/** Подпись для интерфейса */
export function gameModeRu(info: GameModeInfo): string {
  if (info.source === 'manual') return info.mode === 'turbo' ? 'Турбо (выбран вручную)' : 'Обычный режим (выбран вручную)';
  return info.mode === 'turbo' ? 'Турбо' : info.mode === 'all-pick' ? 'All Pick' : info.mode === 'other' ? (info.raw === 'hero_demo' ? 'Hero Demo' : 'другой режим') : 'режим неизвестен';
}
