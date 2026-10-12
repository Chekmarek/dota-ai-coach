import { z } from 'zod';

// Схема настроек приложения.
// Две версии одних и тех же полей:
//  - строгая (для изменений из UI): недопустимое значение → ошибка;
//  - терпимая (для чтения файла с диска): недопустимое значение → значение по умолчанию.

export const SETTINGS_SCHEMA_VERSION = 1;

const DEFAULTS = {
  capture: { targetFps: 2, maxWidth: 1920, processingFpsCap: 10, previewFps: 2 },
  replay: { loop: false },
  voice: { enabled: false, voiceId: null as string | null, rate: 1, volume: 0.8 },
  ui: { showRegions: true },
  live: { autoStart: true, fps: 10, overlay: true, overlayCorner: 'top-right' as OverlayCorner },
};

export type OverlayCorner = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';

const fields = {
  capture: {
    /** Сколько кадров в секунду брать из источника */
    targetFps: z.number().min(0.2).max(30),
    /** Максимальная ширина кадра после масштабирования (пиксели) */
    maxWidth: z.number().int().min(320).max(3840),
    /** Верхний предел частоты обработки — защита CPU */
    processingFpsCap: z.number().min(0.2).max(30),
    /** Частота превью-кадров для интерфейса */
    previewFps: z.number().min(0.2).max(10),
  },
  replay: {
    loop: z.boolean(),
  },
  voice: {
    enabled: z.boolean(),
    voiceId: z.string().max(200).nullable(),
    rate: z.number().min(0.5).max(2),
    volume: z.number().min(0).max(1),
  },
  ui: {
    showRegions: z.boolean(),
  },
  live: {
    /** Сам включать живой захват при запуске приложения */
    autoStart: z.boolean(),
    /** Сколько кадров в секунду брать с окна игры */
    fps: z.number().min(1).max(30),
    /** Показывать значок «Коуч» поверх игры */
    overlay: z.boolean(),
    overlayCorner: z.enum(['top-left', 'top-right', 'bottom-left', 'bottom-right']),
  },
};

type Sections = typeof fields;
type SectionName = keyof Sections;

/** Терпимая версия раздела: каждое поле с откатом на значение по умолчанию */
function tolerant<K extends SectionName>(name: K) {
  const shape = Object.fromEntries(
    Object.entries(fields[name]).map(([k, s]) => [k, (s as z.ZodType).catch((DEFAULTS[name] as Record<string, unknown>)[k])]),
  ) as { [F in keyof Sections[K]]: Sections[K][F] };
  return z.object(shape).catch(() => ({ ...DEFAULTS[name] }) as never);
}

export const settingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).catch(SETTINGS_SCHEMA_VERSION),
  capture: tolerant('capture'),
  replay: tolerant('replay'),
  voice: tolerant('voice'),
  ui: tolerant('ui'),
  live: tolerant('live'),
});

export type Settings = z.infer<typeof settingsSchema>;

export function defaultSettings(): Settings {
  return settingsSchema.parse({});
}

/** Частичное обновление настроек из UI: только известные разделы и поля, значения строго в допустимых пределах */
export const settingsPatchSchema = z
  .object({
    capture: z.object(fields.capture).partial().strict().optional(),
    replay: z.object(fields.replay).partial().strict().optional(),
    voice: z.object(fields.voice).partial().strict().optional(),
    ui: z.object(fields.ui).partial().strict().optional(),
    live: z.object(fields.live).partial().strict().optional(),
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export function applySettingsPatch(current: Settings, patch: SettingsPatch): Settings {
  return settingsSchema.parse({
    ...current,
    capture: { ...current.capture, ...patch.capture },
    replay: { ...current.replay, ...patch.replay },
    voice: { ...current.voice, ...patch.voice },
    ui: { ...current.ui, ...patch.ui },
    live: { ...current.live, ...patch.live },
  });
}
