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
} as const;

/**
 * Каналы окна движка (живой захват). Строки продублированы в src/preload/engine.ts:
 * sandbox-preload не может подгружать общие чанки сборки.
 */
export const LIVE_IPC = {
  findDota: 'engine:find-dota',
  liveStatus: 'engine:live-status',
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
}
