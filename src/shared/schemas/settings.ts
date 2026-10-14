import { z } from 'zod';

// Схема настроек приложения.
// Две версии одних и тех же полей:
//  - строгая (для изменений из UI): недопустимое значение → ошибка;
//  - терпимая (для чтения файла с диска): недопустимое значение → значение по умолчанию.

export const SETTINGS_SCHEMA_VERSION = 1;

/** Порт приёмника GSI по умолчанию */
export const GSI_DEFAULT_PORT = 53790;

const DEFAULTS = {
  capture: { targetFps: 2, maxWidth: 1920, processingFpsCap: 10, previewFps: 2 },
  replay: { loop: false },
  voice: { enabled: false, voiceId: null as string | null, rate: 1, volume: 0.8 },
  ui: { showRegions: true },
  live: { autoStart: true, fps: 10, overlay: true, overlayCorner: 'top-right' as OverlayCorner },
  // Решение владельца 2026-10-13 (docs/POLICY.md): подсказки включены по умолчанию, в рейтинге — тоже; решает пользователь
  hints: { enabled: true, ranked: true },
  // Valve Game State Integration: локальный приёмник на 127.0.0.1 (этап 2 GSI)
  gsi: { port: GSI_DEFAULT_PORT, token: '', record: true, dotaDir: null as string | null },
  // Только для разработчика (DOTACOACH_DEV=1): набор кадров для проверки зрения (docs/VISION_DATASET.md)
  dev: { datasetRecord: false, datasetEveryN: 10 },
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
  hints: {
    /** Live-подсказки во время матча (в отдельном окне коуча, не поверх игры) */
    enabled: z.boolean(),
    /** Подсказки и в рейтинговых матчах — решает пользователь (риск для аккаунта, см. docs/POLICY.md) */
    ranked: z.boolean(),
  },
  gsi: {
    /** Порт приёмника на 127.0.0.1; если занят — показываем это, другой порт сами не выбираем */
    port: z.number().int().min(1024).max(65535),
    /**
     * Секрет для auth.token в файле Dota: 32 случайных байта (64 hex-символа), создаётся один раз в main.
     * Пустая строка — ещё не создан. Из интерфейса не меняется (нет в схеме патча).
     */
    token: z.union([z.literal(''), z.string().regex(/^[0-9a-f]{64}$/)]),
    /** Записывать сессии GSI (без ников и steamid) в <папка данных>/gsi-sessions */
    record: z.boolean(),
    /** Папка «dota 2 beta», если коуч не нашёл её сам; null — искать через Steam */
    dotaDir: z.string().min(3).max(1000).nullable(),
  },
  dev: {
    /** Сохранять кадры живого захвата + GSI наблюдателя в <папка данных>/vision-dataset. Работает только при DOTACOACH_DEV=1 */
    datasetRecord: z.boolean(),
    /** Сохранять каждый N-й кадр живого захвата */
    datasetEveryN: z.number().int().min(1).max(600),
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
  hints: tolerant('hints'),
  gsi: tolerant('gsi'),
  dev: tolerant('dev'),
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
    hints: z.object(fields.hints).partial().strict().optional(),
    // token — только main-процесс (SettingsStore.setGsiToken), dotaDir — через диалог выбора папки
    gsi: z.object({ port: fields.gsi.port, record: fields.gsi.record }).partial().strict().optional(),
    dev: z.object(fields.dev).partial().strict().optional(),
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
    hints: { ...current.hints, ...patch.hints },
    gsi: { ...current.gsi, ...patch.gsi },
    dev: { ...current.dev, ...patch.dev },
  });
}

/** Изменение настроек, недоступное интерфейсу: секрет GSI и папка Dota (из диалога main-процесса) */
export function applyInternalGsi(current: Settings, gsi: Partial<Settings['gsi']>): Settings {
  return settingsSchema.parse({ ...current, gsi: { ...current.gsi, ...gsi } });
}
