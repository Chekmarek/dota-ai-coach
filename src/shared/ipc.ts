import type { Settings, SettingsPatch } from './schemas/settings';
import type { PolicyState } from './types/policy';
import type { LiveReason, LiveState, ReplaySourceSpec } from './types/capture';
import type { KnowledgeBase } from './types/kb';
import type { AiAskPayload, AiAskResult, AiChunkMessage, AiFeedback, AiUiState } from './types/ai';
import type { AiLocalModel } from './schemas/settings';
import type { GsiReading } from '../core/gsi/map.ts';

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
  // ИИ-помощник (0.11.0)
  aiGet: 'ai:get',
  aiAsk: 'ai:ask',
  aiCancel: 'ai:cancel',
  aiSetKey: 'ai:set-key',
  aiClearKey: 'ai:clear-key',
  aiFeedback: 'ai:feedback',
  aiLocalDownload: 'ai:local-download',
  aiLocalCancel: 'ai:local-cancel',
  aiLocalDelete: 'ai:local-delete',
  aiLocalStop: 'ai:local-stop',
  /** Записанные сессии GSI для «Разбора матча» */
  aiSessions: 'ai:sessions',
  aiSessionReadings: 'ai:session-readings',
  /** события main → UI */
  aiChunk: 'ai:chunk',
  aiState: 'ai:state',
  /** Примеры подсказок поверх игры на 12 с (этап 3) */
  hudDemo: 'hud:demo',
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
  /** событие main → окно подсказок поверх игры (HudState) */
  hudState: 'hud:state',
  /** событие main → движок: запись набора кадров (только DOTACOACH_DEV=1) */
  datasetConfig: 'engine:dataset-config',
  /** движок → main: кадр для набора (PNG) */
  datasetFrame: 'engine:dataset-frame',
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
  /** Режим разработчика (DOTACOACH_DEV=1): видны настройки набора кадров */
  dev: boolean;
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
    /**
     * Когда коуч сам переписал устаревший файл (порт, секрет или формат поменялись); Dota подхватит его только
     * после перезапуска. null — не переписывал (или пользователь сам нажал «Подключить»/«Отключить»).
     */
    refreshedAt: number | null;
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
  /** Показать примеры подсказок поверх игры на 12 с */
  showHudDemo(scene: 'alive' | 'dead' | 'match'): Promise<void>;
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
  // ИИ-помощник
  getAiState(): Promise<AiUiState>;
  askAi(payload: AiAskPayload): Promise<AiAskResult>;
  cancelAi(requestId?: string): Promise<void>;
  setAiKey(key: string): Promise<AiUiState>;
  clearAiKey(): Promise<AiUiState>;
  sendAiFeedback(f: AiFeedback): Promise<void>;
  downloadLocalAi(model: AiLocalModel): Promise<AiUiState>;
  cancelLocalAiDownload(): Promise<AiUiState>;
  deleteLocalAi(): Promise<AiUiState>;
  stopLocalAi(): Promise<AiUiState>;
  listGsiSessions(): Promise<GsiSessionInfo[]>;
  /** Чтения GSI одного матча из записанной сессии (прорежено), для фактов после матча */
  getGsiSessionMatch(id: string): Promise<GsiSessionMatch | { error: string }>;
  onAiChunk(fn: (msg: AiChunkMessage) => void): () => void;
  onAiState(fn: (state: AiUiState) => void): () => void;
}

/** Матч в записанной сессии GSI (файл дня может содержать несколько матчей) */
export interface GsiSessionInfo {
  /** «<файл>#<номер матча>» */
  id: string;
  day: string;
  matchId: string | null;
  hero: string | null;
  startedAt: number;
  durationSec: number | null;
}

export interface GsiSessionMatch {
  info: GsiSessionInfo;
  /** Чтения GSI своего героя (без ников), не чаще раза в 2 секунды игрового времени */
  readings: GsiReading[];
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
  /** Подписка на настройку записи набора кадров (everyN = 0 — выключено) */
  onDatasetConfig(fn: (cfg: DatasetConfig) => void): void;
  /** Кадр для набора: main сохраняет его вместе с последним телом GSI наблюдателя */
  saveDatasetFrame(frame: DatasetFrameMessage): void;
}

/** Запись набора кадров для проверки зрения (docs/VISION_DATASET.md) */
export interface DatasetConfig {
  /** Каждый N-й кадр живого захвата; 0 — запись выключена */
  everyN: number;
}

export interface DatasetFrameMessage {
  png: ArrayBuffer;
  width: number;
  height: number;
  /** Время кадра, мс Unix (часы движка) */
  wallMs: number;
}
