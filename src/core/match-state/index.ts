// Модель состояния матча (этап D, ядро): устойчивое состояние из шумных покадровых чтений HUD
// и точных чтений GSI (ingestGsi — главный источник, зрение — запасной и для сверки).
export {
  MatchStateModel,
  EVENT_LIMIT,
  TTL_MS,
  LOCK_READINGS,
  LOCK_WINDOW_MS,
  NAMELESS_GRACE_MS,
  MIN_SLOT_CONFIDENCE,
  GSI_LIVE_MS,
  SCREEN_LIVE_MS,
} from './model.ts';
export { CLOCK_TOLERANCE_SEC, CLOCK_JUMP_READINGS, PAUSE_AFTER_MS, RESET_BACK_SEC } from './clock.ts';
export { VISIBLE_MS, FAST_CONFIDENCE, CORRECTION_MS } from './stable-field.ts';
export type {
  Tracked,
  TrackedTag,
  TrackedSource,
  TrackedAbility,
  TrackedItemSlot,
  SlotContent,
  MatchEvent,
  MatchEventType,
  MatchState,
  DayNight,
  HeroIdentity,
  Kda,
  Farm,
  Pool,
  AbilityState,
} from './types.ts';
