import type { CaptureError, LiveInfo, SourceKind } from '@shared/types/capture';

/** Кадр в памяти движка. Получатель обязан вызвать bitmap.close() после использования. */
export interface Frame {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  /** Номер кадра в источнике */
  index: number;
  /** Время внутри записи (для видео), мс */
  sourceTimeMs: number | null;
  /** Когда кадр получен движком (performance.now) */
  capturedAt: number;
}

export interface FrameSourceOptions {
  fps: number;
  maxWidth: number;
  loop: boolean;
}

export interface FrameSourceEvents {
  frame: (f: Frame) => void;
  error: (e: CaptureError) => void;
  ended: () => void;
  /** Только живой захват: подробности состояния; changed — состояние или причина поменялись */
  live?: (info: LiveInfo, changed: boolean) => void;
  /** Только живой захват с отладочной записью: кадр в полном разрешении окна (получатель закрывает bitmap) */
  snapshot?: (s: Snapshot) => void;
}

/** Кадр отладочной записи: полный размер окна, без уменьшения до maxWidth */
export interface Snapshot {
  bitmap: ImageBitmap;
  width: number;
  height: number;
  capturedAt: number;
  /** Замеры захвата на момент кадра (размеры потока, формат кадра, цветовое пространство) */
  diag: Record<string, unknown>;
}

/**
 * Общий интерфейс любого источника кадров: записи (папка, видео) и живой захват окна Доты.
 * Благодаря ему конвейер не знает, откуда пришёл кадр, и источник можно подменить тестовым.
 */
export interface FrameSource {
  readonly kind: SourceKind;
  readonly total: number | null;
  start(opts: FrameSourceOptions, events: FrameSourceEvents): Promise<void>;
  pause(): void;
  resume(): void;
  /** Полностью освобождает ресурсы (декодер, таймеры, bitmap-ы) */
  stop(): Promise<void>;
}

export function captureError(code: CaptureError['code'], message: string, fatal: boolean): CaptureError {
  return { code, message, fatal, at: Date.now() };
}
