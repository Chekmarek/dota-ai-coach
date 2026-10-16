import { z } from 'zod';
import { zoneOverridesSchema, type ZoneOverrides } from '../../core/hud/layout.ts';
import { HUD_THEME_IDS, type HudThemeId } from '../types/hud.ts';

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
  // Подсказки поверх игры (этап 3): тема, раскладка, анимации, прозрачность, размер
  hud: { enabled: true, theme: 'runes' as HudThemeId, reduceMotion: false, opacity: 1, scale: 1, zones: null as ZoneOverrides | null },
  // Valve Game State Integration: локальный приёмник на 127.0.0.1 (этап 2 GSI)
  gsi: { port: GSI_DEFAULT_PORT, token: '', record: true, dotaDir: null as string | null },
  // Только для разработчика (DOTACOACH_DEV=1): набор кадров для проверки зрения (docs/VISION_DATASET.md)
  dev: { datasetRecord: false, datasetEveryN: 10 },
};

export const AI_PROVIDER_SETTINGS = ['off', 'local', 'gigachat', 'openai-compatible'] as const;
export type AiProviderSetting = (typeof AI_PROVIDER_SETTINGS)[number];
export const AI_LOCAL_MODELS = ['qwen3-1.7b', 'qwen3-4b'] as const;
export type AiLocalModel = (typeof AI_LOCAL_MODELS)[number];

/** Адрес облачного ИИ: https://…; http — только для сервера на этом ПК (127.0.0.1, localhost) */
export function isAllowedAiBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

const aiFields = {
  /** Кто отвечает: off — ИИ выключен; gigachat пока недоступен (нужен корневой сертификат Минцифры, его не встраиваем) */
  provider: z.enum(AI_PROVIDER_SETTINGS),
  localModel: z.enum(AI_LOCAL_MODELS),
  /** Пусто — не задан */
  cloudBaseUrl: z.union([z.literal(''), z.string().max(500).refine(isAllowedAiBaseUrl, 'Адрес должен начинаться с https://')]),
  cloudModel: z.string().max(200),
  /** Согласие отправлять вопрос и факты матча в облако (без ников и ключей); без него облако не вызывается */
  sendToCloudConsent: z.boolean(),
};

// ИИ-помощник (0.11.0): по умолчанию выключен; облако — только с согласием пользователя (docs/POLICY.md)
const D_AI = { provider: 'off', local: { model: 'qwen3-1.7b' }, cloud: { baseUrl: '', model: '' }, sendToCloudConsent: false } as const;

/** Терпимый раздел ai: плохое поле → значение по умолчанию, остальные сохраняются */
const aiTolerant = z
  .object({
    provider: aiFields.provider.catch(D_AI.provider),
    local: z.object({ model: aiFields.localModel.catch(D_AI.local.model) }).catch(() => ({ ...D_AI.local })),
    cloud: z
      .object({ baseUrl: aiFields.cloudBaseUrl.catch(''), model: aiFields.cloudModel.catch('') })
      .catch(() => ({ ...D_AI.cloud })),
    sendToCloudConsent: aiFields.sendToCloudConsent.catch(false),
  })
  .catch(() => structuredClone(D_AI) as never);

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
    /** Live-подсказки во время матча (поверх окна игры — раздел hud) */
    enabled: z.boolean(),
    /** Подсказки и в рейтинговых матчах — решает пользователь (риск для аккаунта, см. docs/POLICY.md) */
    ranked: z.boolean(),
  },
  hud: {
    /** Показывать подсказки поверх окна игры */
    enabled: z.boolean(),
    theme: z.enum(HUD_THEME_IDS),
    /** «Уменьшить анимации»: без движения, только проявление */
    reduceMotion: z.boolean(),
    opacity: z.number().min(0.4).max(1),
    scale: z.number().min(0.8).max(1.4),
    /** Сдвиги зон из «Режима расстановки»; null — стандартная раскладка */
    zones: zoneOverridesSchema.nullable(),
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
  hud: tolerant('hud'),
  gsi: tolerant('gsi'),
  dev: tolerant('dev'),
  ai: aiTolerant,
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
    hud: z.object(fields.hud).partial().strict().optional(),
    // token — только main-процесс (SettingsStore.setGsiToken), dotaDir — через диалог выбора папки
    gsi: z.object({ port: fields.gsi.port, record: fields.gsi.record }).partial().strict().optional(),
    dev: z.object(fields.dev).partial().strict().optional(),
    // gigachat из интерфейса не выбирается, пока он недоступен
    ai: z
      .object({
        provider: z.enum(['off', 'local', 'openai-compatible']),
        local: z.object({ model: aiFields.localModel }).strict(),
        cloud: z.object({ baseUrl: aiFields.cloudBaseUrl, model: aiFields.cloudModel }).partial().strict(),
        sendToCloudConsent: aiFields.sendToCloudConsent,
      })
      .partial()
      .strict()
      .optional(),
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
    hud: { ...current.hud, ...patch.hud },
    gsi: { ...current.gsi, ...patch.gsi },
    dev: { ...current.dev, ...patch.dev },
    ai: {
      ...current.ai,
      ...patch.ai,
      local: { ...current.ai.local, ...patch.ai?.local },
      cloud: { ...current.ai.cloud, ...patch.ai?.cloud },
    },
  });
}

/** Изменение настроек, недоступное интерфейсу: секрет GSI и папка Dota (из диалога main-процесса) */
export function applyInternalGsi(current: Settings, gsi: Partial<Settings['gsi']>): Settings {
  return settingsSchema.parse({ ...current, gsi: { ...current.gsi, ...gsi } });
}
