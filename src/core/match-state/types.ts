// Типы модели состояния матча (этап D, ядро). Без Electron и DOM: время всегда передаётся снаружи.
import type { DayNight } from '../vision/day-night.ts';
import type { HeroIdentity } from '../vision/hero-name.ts';
import type { Farm, Kda, Pool } from '../vision/hud-fields.ts';
import type { AbilityState } from '../vision/abilities.ts';

export type { DayNight, HeroIdentity, Farm, Kda, Pool, AbilityState };

/**
 * Метка значения (этап D):
 * visible — «видно сейчас», remembered — «видели раньше», inferred — «вывод», unknown — «неизвестно».
 */
export type TrackedTag = 'visible' | 'remembered' | 'inferred' | 'unknown';

/** Откуда последнее подтверждение: gsi — Game State Integration Valve, screen — зрение по кадру, null — неизвестно */
export type TrackedSource = 'gsi' | 'screen' | null;

/** Значение с уверенностью, меткой и временем наблюдения (мс «настенного» времени, переданного в ingest/snapshot) */
export interface Tracked<T> {
  /** null — неизвестно (ещё не видели или истёк срок памяти) */
  value: T | null;
  confidence: number;
  tag: TrackedTag;
  /** Когда значение последний раз подтвердилось (чтением с экрана или из GSI) */
  lastSeenWallMs: number | null;
  /** Когда текущее значение было принято впервые */
  firstSeenWallMs: number | null;
  /** Источник последнего подтверждения значения */
  source: TrackedSource;
}

/** Содержимое ячейки инвентаря: item = null — ячейка пустая */
export interface SlotContent {
  item: { key: string; name: string } | null;
}

export interface TrackedItemSlot extends Tracked<SlotContent> {
  /** 'inv1'…'inv6', 'bp1'…'bp3' */
  slot: string;
}

export interface TrackedAbility {
  index: number;
  /** Ключ способности из GSI (без имени героя не угадывается по картинке); null — не известен */
  key: string | null;
  state: Tracked<AbilityState>;
  level: Tracked<number>;
  /** Секунд до готовности: последнее прочитанное значение минус прошедшее время, не меньше 0 */
  cooldown: Tracked<number>;
}

export type MatchEventType =
  | 'level-up'
  | 'kill'
  | 'death'
  | 'assist'
  | 'item-gained'
  | 'item-lost'
  | 'ability-learned'
  | 'day-night'
  | 'pause'
  | 'unpause'
  | 'match-reset';

export interface MatchEvent {
  type: MatchEventType;
  wallMs: number;
  /** Игровое время (секунды) на момент события; null — время ещё не известно */
  clock: number | null;
  data: Record<string, unknown>;
}

export interface MatchState {
  wallMs: number;
  /** Какие источники сейчас дают данные: gsi — свежее GSI (моложе GSI_LIVE_MS), screen — свежий кадр */
  sources: { gsi: boolean; screen: boolean };
  match: {
    /** Секунды игрового времени; между чтениями — экстраполяция (inferred) */
    clock: Tracked<number>;
    paused: boolean;
    scoreRadiant: Tracked<number>;
    scoreDire: Tracked<number>;
    dayNight: Tracked<DayNight>;
  };
  hero: {
    /** Герой игрока определён (и больше не меняется до сброса матча) */
    locked: boolean;
    identity: Tracked<HeroIdentity>;
    level: Tracked<number>;
    gold: Tracked<number>;
    health: Tracked<Pool>;
    mana: Tracked<Pool>;
    kda: Tracked<Kda>;
    farm: Tracked<Farm>;
    abilities: TrackedAbility[];
    items: TrackedItemSlot[];
  };
  /** Последние события (не больше EVENT_LIMIT), от старых к новым */
  events: MatchEvent[];
}
