import { describe, expect, it } from 'vitest';
import { computeLiveState, liveRetryDelay, LIVE_RETRY_MS, LIVE_RETRY_SLOW_MS, type LiveFacts } from '../../src/engine/capture/live-state';
import { compareVersions } from '../../src/shared/version';
import { settingsSchema } from '../../src/shared/schemas/settings';

const base: LiveFacts = {
  running: true,
  hasStream: true,
  now: 10_000,
  streamStartedAt: 9_000,
  lastFrameAt: 9_900,
  darkSince: null,
  frozenSince: null,
  lastError: null,
};

describe('computeLiveState — состояние живого захвата', () => {
  it('выключен', () => expect(computeLiveState({ ...base, running: false })).toEqual({ state: 'off', reason: null }));
  it('нет окна Доты', () => expect(computeLiveState({ ...base, hasStream: false })).toEqual({ state: 'waiting-dota', reason: 'not-found' }));
  it('не удалось подключиться', () =>
    expect(computeLiveState({ ...base, hasStream: false, lastError: 'open-failed' })).toEqual({ state: 'waiting-dota', reason: 'open-failed' }));
  it('кадры не приходят 2 с', () => expect(computeLiveState({ ...base, lastFrameAt: 7_900 })).toEqual({ state: 'no-image', reason: 'no-frames' }));
  it('чёрная картинка 3 с', () => expect(computeLiveState({ ...base, darkSince: 7_000 })).toEqual({ state: 'no-image', reason: 'dark' }));
  it('застывшая картинка 10 с', () => expect(computeLiveState({ ...base, frozenSince: 0 })).toEqual({ state: 'no-image', reason: 'frozen' }));
  it('видит игру', () => expect(computeLiveState(base)).toEqual({ state: 'seeing', reason: null }));
});

describe('liveRetryDelay — как часто искать Доту', () => {
  it('первую минуту — каждые 3 с, потом — каждые 10 с', () => {
    expect(liveRetryDelay(0)).toBe(LIVE_RETRY_MS);
    expect(liveRetryDelay(59_999)).toBe(LIVE_RETRY_MS);
    expect(liveRetryDelay(60_000)).toBe(LIVE_RETRY_SLOW_MS);
  });
});

describe('compareVersions', () => {
  it('сравнивает версии', () => {
    expect(compareVersions('0.5.0', '0.3.0')).toBe(1);
    expect(compareVersions('v0.5.0', '0.5.0')).toBe(0);
    expect(compareVersions('0.5.0', '0.5.1')).toBe(-1);
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.0')).toBe(0);
  });
});

describe('настройки: старый settings.json без раздела live', () => {
  it('загружается без потерь, live — по умолчанию', () => {
    const old = { schemaVersion: 1, capture: { targetFps: 7, maxWidth: 1280, processingFpsCap: 5, previewFps: 1 }, replay: { loop: true } };
    const s = settingsSchema.parse(old);
    expect(s.capture.targetFps).toBe(7);
    expect(s.capture.maxWidth).toBe(1280);
    expect(s.replay.loop).toBe(true);
    expect(s.live).toEqual({ autoStart: true, fps: 10, overlay: true, overlayCorner: 'top-right', recordFrames: false });
  });
});
