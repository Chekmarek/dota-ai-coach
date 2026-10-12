/** Описание записанного источника кадров, выданное main-процессом после выбора файла/папки */
export type ReplaySourceSpec =
  | {
      kind: 'image-folder';
      id: string;
      label: string;
      /** URL кадров по схеме dcmedia://, в порядке воспроизведения */
      frames: string[];
    }
  | {
      kind: 'video-file';
      id: string;
      label: string;
      url: string;
    };

/** Живой захват окна Dota 2 (только наблюдение) */
export const LIVE_KIND = 'live-screen';
export interface LiveSourceSpec {
  kind: typeof LIVE_KIND;
  id: string;
  label: string;
}

export type PipelineSourceSpec = ReplaySourceSpec | LiveSourceSpec;

export type SourceKind = PipelineSourceSpec['kind'];

export type CaptureState = 'idle' | 'starting' | 'running' | 'paused' | 'ended' | 'stopped' | 'error';

export type CaptureErrorCode =
  | 'load-failed'
  | 'decode-failed'
  | 'stalled'
  | 'source-empty'
  | 'unsupported'
  | 'internal'
  | 'live-open-failed'
  | 'live-frame-failed';

export interface CaptureError {
  code: CaptureErrorCode;
  message: string;
  at: number;
  /** true — источник остановлен; false — единичный сбой, работа продолжается */
  fatal: boolean;
}

/** Состояние живого захвата: выключен / ждёт окно Доты / окно есть, но картинки нет / видит игру */
export type LiveState = 'off' | 'waiting-dota' | 'no-image' | 'seeing';
export type LiveReason = 'not-found' | 'open-failed' | 'no-frames' | 'dark' | 'frozen';

export interface LiveInfo {
  state: LiveState;
  reason: LiveReason | null;
  /** Заголовок захваченного окна */
  windowName: string | null;
  /** Размер кадра с окна (после уменьшения при захвате) */
  width: number | null;
  height: number | null;
  /** Сколько кадров в секунду отдаёт Windows */
  captureFps: number;
  /** Время от получения кадра до передачи в обработку, мс */
  latencyMs: number | null;
  /** Текст ошибки подключения (только пока ждём Доту) */
  errorMessage: string | null;
  /** Заголовки окон, которые видит коуч (для диагностики, пока ждём Доту) */
  seenWindows: string[];
  /** Режим экрана Доты (с 0.6.0); null — ещё не известен. Старые статусы без поля тоже допустимы */
  videoMode?: 'exclusive' | 'borderless' | 'windowed' | 'unknown' | null;
}

export interface CaptureStatus {
  state: CaptureState;
  sourceKind: SourceKind | null;
  sourceLabel: string | null;
  framesReceived: number;
  framesProcessed: number;
  framesDropped: number;
  /** Фактическая частота поступления кадров за последние секунды */
  measuredFps: number;
  /** Фактическая частота обработки */
  processingFps: number;
  lastFrameAt: number | null;
  /** Позиция в источнике: номер кадра / время видео */
  position: { index: number; total: number | null; sourceTimeMs: number | null } | null;
  lastError: CaptureError | null;
  /** Живой захват: подробности (null — источник не живой) */
  live: LiveInfo | null;
  /** Какие стадии конвейера реально работают — честно для UI */
  pipeline: {
    /** hud-numbers — распознаются числа HUD (время, золото, HP, мана, уровень, счёт); остальное ещё нет */
    vision: 'not-implemented' | 'hud-numbers';
    /** Среднее время распознавания одного кадра, мс */
    visionMs: number | null;
  };
}

export interface ReplayStartOptions {
  source: PipelineSourceSpec;
  fps: number;
  maxWidth: number;
  processingFpsCap: number;
  previewFps: number;
  loop: boolean;
}
