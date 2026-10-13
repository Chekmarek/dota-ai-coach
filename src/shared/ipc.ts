import type { Settings, SettingsPatch } from './schemas/settings';
import type { PolicyState } from './types/policy';
import type { LiveReason, LiveState, ReplaySourceSpec } from './types/capture';
import type { KnowledgeBase } from './types/kb';

/** Полный список IPC-каналов окна интерфейса. Других каналов нет. */
export const IPC = {
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  appInfo: 'app:info',
  replayPickFolder: 'replay:pick-folder',
  replayPickVideo: 'replay:pick-video',
  kbGet: 'kb:get',
  // Обновления из GitHub Releases
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateInstall: 'update:install',
  /** событие main → UI */
  updateState: 'update:state',
  // Данные из игры (Valve GSI)
  gsiGet: 'gsi:get',
  gsiConnect: 'gsi:connect',
  gsiDisconnect: 'gsi:disconnect',
  gsiPickDota: 'gsi:pick-dota',
  gsiCopyLaunchOption: 'gsi:copy-launch-option',
  /** событие main → UI */
  gsiState: 'gsi:state',
} as const;

/**
 * Каналы окна движка (живой захват). Строки продублированы в src/preload/engine.ts:
 * sandbox-preload не может подгружать общие чанки сборки.
 */
export const LIVE_IPC = {
  findDota: 'engine:find-dota',
  liveStatus: 'engine:live-status',
  /** событие main → движок: проверенное тело запроса GSI */
  gsiBody: 'engine:gsi',
  /** событие main → значок поверх игры */
  overlayState: 'overlay:state',
} as const;

/** Имя сообщения, которым preload передаёт странице MessagePort к движку */
export const ENGINE_PORT_MESSAGE = 'dotacoach:engine-port';

export interface AppInfo {
  version: string;
  dataDir: string;
  distribution: 'dev' | 'installed' | 'portable';
  policy: PolicyState;
  electron: string;
  chrome: string;
  node: string;
}

export type UpdateStatus = 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'installing' | 'error';

export interface ReleaseInfo {
  version: string;
  notes: string;
  publishedAt: string | null;
  url: string | null;
}

export interface UpdateState {
  status: UpdateStatus;
  current: string;
  latest: ReleaseInfo | null;
  history: ReleaseInfo[];
  checkedAt: number | null;
  progress: number | null;
  error: string | null;
  repo: string | null;
}

/** Состояние приёмника GSI и файла в папке Dota (main → UI) */
export interface GsiState {
  server: 'off' | 'starting' | 'listening' | 'port-busy' | 'error';
  port: number;
  error: string | null;
  dota: {
    /** Папка «dota 2 beta»; null — не найдена */
    dir: string | null;
    how: 'override' | 'library' | 'not-found';
    /** Полный путь файла коуча (для подтверждения перед записью); null — папка не найдена */
    cfgPath: string | null;
    /** Файл коуча лежит в папке Dota */
    installed: boolean;
    /** Файл совпадает с текущими портом и секретом (иначе — «Подключить» его обновит) */
    current: boolean;
  };
  /** Когда пришёл последний принятый запрос (Date.now в main); null — ещё не было */
  lastBodyAt: number | null;
  accepted: number;
  rejected: number;
  recording: boolean;
  /** Параметр запуска Dota 2 */
  launchOption: string;
}

/** Тело GSI для движка */
export interface GsiBodyMessage {
  body: Record<string, unknown>;
  wallMs: number;
}

/** API, которое preload выдаёт интерфейсу как window.dotacoach */
export interface DotaCoachApi {
  getSettings(): Promise<Settings>;
  updateSettings(patch: SettingsPatch): Promise<Settings>;
  getAppInfo(): Promise<AppInfo>;
  pickReplayFolder(): Promise<ReplaySourceSpec | null>;
  pickReplayVideo(): Promise<ReplaySourceSpec | null>;
  getKnowledgeBase(): Promise<KnowledgeBase | { error: string }>;
  getUpdateState(): Promise<UpdateState>;
  checkForUpdates(): Promise<UpdateState>;
  installUpdate(): Promise<UpdateState>;
  onUpdateState(fn: (state: UpdateState) => void): () => void;
  getGsiState(): Promise<GsiState>;
  connectGsi(): Promise<GsiState>;
  disconnectGsi(): Promise<GsiState>;
  pickDotaFolder(): Promise<GsiState>;
  copyGsiLaunchOption(): Promise<void>;
  onGsiState(fn: (state: GsiState) => void): () => void;
}

/** Найденное окно Доты: source — для захвата, windows — заголовки всех окон (диагностика) */
export interface FindDotaResult {
  source: { id: string; name: string } | null;
  windows: string[];
  /** Режим экрана Доты из video.txt; null — окно Доты не найдено (с 0.6.0) */
  videoMode?: DotaVideoMode | null;
}

/** Режим экрана Доты: полноэкранный / без рамки / оконный / не удалось определить */
export type DotaVideoMode = 'exclusive' | 'borderless' | 'windowed' | 'unknown';

/** Короткий статус живого режима для main (значок поверх игры и журнал) */
export interface LiveStatusReport {
  state: LiveState;
  reason: LiveReason | null;
  error: string | null;
  fps: number;
}

/** API окна движка (window.dotacoachEngine) */
export interface DotaCoachEngineApi {
  findDota(): Promise<FindDotaResult>;
  reportLive(status: LiveStatusReport): void;
  /** Подписка на тела GSI от main */
  onGsi(fn: (msg: GsiBodyMessage) => void): void;
}
