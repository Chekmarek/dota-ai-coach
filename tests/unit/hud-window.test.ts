// Окно подсказок поверх игры: номер окна Доты из захвата, разбор строк помощника, настройки подсказок.
import { describe, expect, it } from 'vitest';
import { hwndFromSourceId, parseRectLine, rectScript } from '../../src/main/live/window-rect';
import { settingsSchema, settingsPatchSchema, applySettingsPatch, defaultSettings } from '../../src/shared/schemas/settings';
import { hudStateSchema } from '../../src/shared/types/hud';
import { sampleHints } from '../../src/shared/hud-samples';

describe('положение окна Доты', () => {
  it('номер окна из id источника захвата', () => {
    expect(hwndFromSourceId('window:132456:0')).toBe(132456);
    expect(hwndFromSourceId('screen:0:0')).toBeNull();
    expect(hwndFromSourceId(null)).toBeNull();
    expect(hwndFromSourceId('window:abc:0')).toBeNull();
  });
  it('строки помощника: прямоугольник, свёрнуто, окно закрыто, мусор', () => {
    expect(parseRectLine('0 0 1920 1080 0')).toEqual({ x: 0, y: 0, width: 1920, height: 1080, minimized: false });
    expect(parseRectLine('-1920 0 2560 1440 0\r')).toEqual({ x: -1920, y: 0, width: 2560, height: 1440, minimized: false });
    expect(parseRectLine('-32000 -32000 0 0 1')).toEqual({ x: -32000, y: -32000, width: 0, height: 0, minimized: true });
    expect(parseRectLine('gone')).toBe('gone');
    expect(parseRectLine('Exception: ...')).toBeNull();
    expect(parseRectLine('10 10 50 50 0')).toBeNull();
  });
  it('скрипт только читает: GetClientRect / ClientToScreen / IsIconic, без записи и без процесса игры', () => {
    const s = rectScript(132456, 1000);
    expect(s).toContain('[IntPtr]::new(132456)');
    for (const bad of ['OpenProcess', 'ReadProcessMemory', 'WriteProcessMemory', 'SetWindowPos', 'SendMessage', 'PostMessage', 'keybd_event', 'SendInput']) expect(s).not.toContain(bad);
  });
});

describe('настройки подсказок поверх игры', () => {
  it('старый settings.json без раздела hud читается, hud — по умолчанию', () => {
    const s = settingsSchema.parse({ live: { autoStart: false } });
    expect(s.hud).toEqual({ enabled: true, theme: 'arcane', reduceMotion: false, opacity: 1, scale: 1, zones: null });
  });
  it('испорченные значения откатываются по одному', () => {
    const s = settingsSchema.parse({ hud: { theme: 'neon', opacity: 7, zones: { decision: { x: 'a' } }, scale: 1.2 } });
    expect(s.hud.theme).toBe('arcane');
    expect(s.hud.opacity).toBe(1);
    expect(s.hud.zones).toBeNull();
    expect(s.hud.scale).toBe(1.2);
  });
  it('патч из интерфейса: строгая проверка', () => {
    expect(() => settingsPatchSchema.parse({ hud: { theme: 'neon' } })).toThrow();
    const next = applySettingsPatch(defaultSettings(), settingsPatchSchema.parse({ hud: { zones: { timing: { x: 0.02, y: 0.4 } }, theme: 'void' } }));
    expect(next.hud.zones).toEqual({ timing: { x: 0.02, y: 0.4 } });
    expect(next.hud.theme).toBe('void');
  });
  it('примеры всех сцен проходят схему состояния окна', () => {
    for (const scene of ['alive', 'dead', 'match'] as const)
      for (const d of ['min', 'normal', 'detailed'] as const) expect(hudStateSchema.safeParse({ hints: sampleHints(scene, d), options: { theme: 'arcane', reduceMotion: false, opacity: 1, scale: 1, zones: null } }).success).toBe(true);
  });
});
