import { describe, expect, it } from 'vitest';
import { applySettingsPatch, defaultSettings, settingsPatchSchema, settingsSchema } from '../../src/shared/schemas/settings';

describe('настройки', () => {
  it('значения по умолчанию валидны', () => {
    const s = defaultSettings();
    expect(s.capture.targetFps).toBe(2);
    expect(s.voice.enabled).toBe(false);
  });

  it('повреждённые поля заменяются значениями по умолчанию, остальные сохраняются', () => {
    const s = settingsSchema.parse({ capture: { targetFps: 999, maxWidth: 1280 }, voice: 'мусор' });
    expect(s.capture.targetFps).toBe(2);
    expect(s.capture.maxWidth).toBe(1280);
    expect(s.voice.volume).toBe(0.8);
  });

  it('патч из интерфейса проверяется строго', () => {
    expect(settingsPatchSchema.safeParse({ capture: { targetFps: 5 } }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ capture: { targetFps: 500 } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ capture: { hack: 1 } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ unknownSection: {} }).success).toBe(false);
  });

  it('live-подсказки: по умолчанию включены и в рейтинге; переключатель рейтинга меняется отдельно', () => {
    const d = defaultSettings();
    expect(d.hints).toMatchObject({ enabled: true, ranked: true });
    const s = applySettingsPatch(d, { hints: { ranked: false } });
    expect(s.hints).toMatchObject({ enabled: true, ranked: false });
    expect(settingsPatchSchema.safeParse({ hints: { ranked: 'да' } }).success).toBe(false);
    // Старый settings.json без раздела hints читается с значениями по умолчанию
    expect(settingsSchema.parse({ live: { fps: 5 } }).hints).toMatchObject({ enabled: true, ranked: true });
    // Этап 4: подробность «Обычный», все категории включены, ИИ и лента в окне коуча включены
    expect(d.hints.detail).toBe('normal');
    expect(Object.values(d.hints.categories).every(Boolean)).toBe(true);
    expect(d.hints.ai).toBe(true);
    expect(d.hints.inApp).toBe(true);
    // Испорченная подробность откатывается, остальное сохраняется
    const bad = settingsSchema.parse({ hints: { detail: 'много', ranked: false, categories: { fight: 'нет' } } });
    expect(bad.hints.detail).toBe('normal');
    expect(bad.hints.ranked).toBe(false);
    expect(bad.hints.categories.fight).toBe(true);
  });

  it('патч сливается с текущими настройками', () => {
    const s = applySettingsPatch(defaultSettings(), { capture: { targetFps: 5 }, replay: { loop: true } });
    expect(s.capture.targetFps).toBe(5);
    expect(s.capture.maxWidth).toBe(1920);
    expect(s.replay.loop).toBe(true);
  });
});
