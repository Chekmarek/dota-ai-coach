// Чистая логика живого захвата (без DOM) — покрыта unit-тестами. Из обновления 0.5.0 (engine-live.js).
import type { LiveReason, LiveState } from '@shared/types/capture';

export const LIVE_RETRY_MS = 3e3;
export const LIVE_RETRY_SLOW_MS = 1e4;
export const LIVE_RETRY_SLOW_AFTER_MS = 6e4;
export const LIVE_NO_FRAME_MS = 2e3;
export const LIVE_DARK_MS = 3e3;
export const LIVE_FROZEN_MS = 1e4;
export const LIVE_RECONNECT_MS = 15e3;
export const LIVE_DARK_LUMA = 4;

export interface LiveFacts {
  running: boolean;
  hasStream: boolean;
  now: number;
  streamStartedAt: number;
  lastFrameAt: number | null;
  darkSince: number | null;
  frozenSince: number | null;
  lastError: 'not-found' | 'open-failed' | null;
}

/** По фактам о захвате возвращает состояние и причину */
export function computeLiveState(f: LiveFacts): { state: LiveState; reason: LiveReason | null } {
  if (!f.running) return { state: 'off', reason: null };
  if (!f.hasStream) return { state: 'waiting-dota', reason: f.lastError ?? 'not-found' };
  const last = f.lastFrameAt ?? f.streamStartedAt;
  if (f.now - last > LIVE_NO_FRAME_MS) return { state: 'no-image', reason: 'no-frames' };
  if (f.darkSince !== null && f.now - f.darkSince >= LIVE_DARK_MS) return { state: 'no-image', reason: 'dark' };
  if (f.frozenSince !== null && f.now - f.frozenSince >= LIVE_FROZEN_MS) return { state: 'no-image', reason: 'frozen' };
  return { state: 'seeing', reason: null };
}

/** Пауза между попытками найти Доту — 3 с первые 60 с ожидания, затем 10 с */
export function liveRetryDelay(waitedMs: number): number {
  return waitedMs < LIVE_RETRY_SLOW_AFTER_MS ? LIVE_RETRY_MS : LIVE_RETRY_SLOW_MS;
}

/** Быстрый хеш байтов (FNV-1a) — чтобы заметить полностью застывшую картинку */
export function hashBytes(data: Uint8ClampedArray): number {
  let h = 2166136261;
  for (let i = 0; i < data.length; i += 4) {
    h ^= data[i]! | (data[i + 1]! << 8) | (data[i + 2]! << 16);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
