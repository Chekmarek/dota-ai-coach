import { describe, expect, it } from 'vitest';
import { uiToEngineSchema } from '../../src/shared/events/engine-protocol';
import { getPolicyState, isModeAllowed } from '../../src/main/policy/policy-gate';

describe('протокол UI → движок', () => {
  const base = {
    type: 'replay:start',
    options: { fps: 2, maxWidth: 1920, processingFpsCap: 10, previewFps: 2, loop: false },
  };

  it('принимает источник только по схеме dcmedia://', () => {
    const ok = { ...base, options: { ...base.options, source: { kind: 'video-file', id: 'a', label: 'x', url: 'dcmedia://media/a/0' } } };
    const bad = { ...base, options: { ...base.options, source: { kind: 'video-file', id: 'a', label: 'x', url: 'file:///C:/Windows/x.mp4' } } };
    expect(uiToEngineSchema.safeParse(ok).success).toBe(true);
    expect(uiToEngineSchema.safeParse(bad).success).toBe(false);
  });

  it('отклоняет неизвестные команды', () => {
    expect(uiToEngineSchema.safeParse({ type: 'input:keypress', key: 'Q' }).success).toBe(false);
  });
});

describe('PolicyGate', () => {
  it('разрешены разбор записей, наблюдение и подсказки — подсказки включает сам пользователь в настройках', () => {
    expect(isModeAllowed('replay')).toBe(true);
    // с 0.5.0: живой захват окна Доты — только наблюдение
    expect(isModeAllowed('live-observe')).toBe(true);
    // решение владельца 2026-10-13: разрешены, а включены ли — settings.hints (по умолчанию да)
    expect(isModeAllowed('live-coach-unranked')).toBe(true);
    expect(isModeAllowed('live-coach-ranked')).toBe(true);
    expect(getPolicyState().activeMode).toBe('replay');
  });
});

describe('сторож зависимостей', () => {
  it('в проекте нет библиотек эмуляции ввода и чтения памяти процессов', async () => {
    const { readFileSync } = await import('node:fs');
    const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
    const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
    const forbidden = /robotjs|nut-tree|nutjs|node-key-sender|keysender|iohook|uiohook|memoryjs|ffi-napi|koffi|node-window-manager/i;
    expect(deps.filter((d) => forbidden.test(d))).toEqual([]);
  });
});
