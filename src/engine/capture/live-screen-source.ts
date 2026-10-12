// Живой захват окна Dota 2 (движок). Перенесено из обновления 0.5.0 (engine-live.js), логика не менялась.
// Источник кадров с тем же интерфейсом, что ImageFolderSource и VideoFileSource:
// start(opts, events) / pause() / resume() / stop(). Дополнительно сообщает events.live(info).
// Никогда не завершается фатальной ошибкой: если Доты нет — ждёт и переподключается сам.
import { LIVE_KIND, type CaptureError, type LiveInfo } from '@shared/types/capture';
import type { DotaCoachEngineApi } from '@shared/ipc';
import type { FrameSource, FrameSourceEvents, FrameSourceOptions } from './frame-source';
import { fitWidth } from './rate';
import { LIVE_DARK_LUMA, LIVE_RECONNECT_MS, computeLiveState, hashBytes, liveRetryDelay } from './live-state';

const TICK_MS = 500;
const SAMPLE_MS = 500;
const SAMPLE_W = 64;
const SAMPLE_H = 36;

// MediaStreamTrackProcessor есть в Chromium, но не во всех версиях типов DOM
declare const MediaStreamTrackProcessor: (new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<VideoFrame> }) | undefined;

function liveError(code: CaptureError['code'], message: string): CaptureError {
  return { code, message, fatal: false, at: Date.now() };
}

export class LiveScreenSource implements FrameSource {
  readonly kind = LIVE_KIND;
  readonly total = null;
  private opts!: FrameSourceOptions;
  private events: FrameSourceEvents | null = null;
  private running = false;
  private paused = false;
  private connecting = false;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
  private grabTimer: ReturnType<typeof setInterval> | null = null;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private gen = 0;
  private windowName: string | null = null;
  private srcSize: { width: number; height: number } | null = null;
  private streamStartedAt = 0;
  private lastAttemptAt = -Infinity;
  private waitingSince: number | null = null;
  private lastFrameAt: number | null = null;
  private lastEmitAt = -Infinity;
  private busy = false;
  private index = 0;
  private darkSince: number | null = null;
  private frozenSince: number | null = null;
  private lastHash: number | null = null;
  private lastSampleAt = -Infinity;
  private lastError: 'not-found' | 'open-failed' | null = null;
  private latencyMs: number | null = null;
  private captureStamps: number[] = [];
  private sampleCanvas: OffscreenCanvas | null = null;
  private lastState: string | null = null;
  private seenWindows: string[] = [];
  private errorMessage: string | null = null;

  /** api — из preload движка (window.dotacoachEngine) */
  constructor(private readonly api: DotaCoachEngineApi) {}

  async start(opts: FrameSourceOptions, events: FrameSourceEvents): Promise<void> {
    this.opts = opts;
    this.events = events;
    this.running = true;
    this.waitingSince = null;
    this.lastAttemptAt = -Infinity;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.detach();
    this.emitLive(true);
  }

  private tick(): void {
    if (!this.running) return;
    const now = performance.now();
    if (this.stream) this.waitingSince = null;
    else this.waitingSince ??= now;
    const retryMs = liveRetryDelay(this.waitingSince === null ? 0 : now - this.waitingSince);
    if (!this.stream && !this.connecting && now - this.lastAttemptAt >= retryMs) void this.connect();
    if (this.stream && now - (this.lastFrameAt ?? this.streamStartedAt) > LIVE_RECONNECT_MS) {
      // Поток жив, но кадров давно нет (окно пересоздано или свёрнуто) — переподключаемся
      this.detach();
    }
    this.emitLive(false);
  }

  private async connect(): Promise<void> {
    this.connecting = true;
    try {
      const res = await this.api.findDota();
      if (!this.running) return;
      this.seenWindows = Array.isArray(res?.windows) ? res.windows : [];
      const src = res?.source ?? null;
      if (!src) {
        this.lastError = 'not-found';
        return;
      }
      const stream = await this.open(src.id);
      if (!this.running) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      this.windowName = src.name;
      this.attach(stream);
    } catch (err) {
      this.lastError = 'open-failed';
      const e = err as Error;
      this.errorMessage = `${e?.name ?? 'Error'}: ${e?.message ?? err}`.slice(0, 380);
      if (this.running) this.events?.error(liveError('live-open-failed', `Не удалось подключиться к окну Доты: ${e?.message ?? err}`));
    } finally {
      this.connecting = false;
      this.lastAttemptAt = performance.now();
    }
  }

  private async open(sourceId: string): Promise<MediaStream> {
    try {
      // Основной путь Electron: захват конкретного окна по id, без системного диалога.
      // Кадр уменьшается уже при захвате (maxWidth) — меньше работы на каждый кадр.
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: sourceId,
            maxFrameRate: this.opts.fps,
            maxWidth: this.opts.maxWidth,
            maxHeight: Math.ceil(this.opts.maxWidth * 0.75),
          },
        },
      } as unknown as MediaStreamConstraints);
    } catch (first) {
      // Запасной путь: getDisplayMedia, main отдаёт только окно Доты
      try {
        return await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: {
            frameRate: { ideal: this.opts.fps, max: this.opts.fps },
            width: { ideal: this.opts.maxWidth },
            height: { ideal: Math.ceil(this.opts.maxWidth * 0.75) },
          },
        });
      } catch {
        throw first;
      }
    }
  }

  private attach(stream: MediaStream): void {
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('в потоке нет видео');
    }
    const gen = ++this.gen;
    this.stream = stream;
    this.waitingSince = null;
    this.streamStartedAt = performance.now();
    this.lastFrameAt = null;
    this.darkSince = null;
    this.frozenSince = null;
    this.lastHash = null;
    this.lastError = null;
    this.errorMessage = null;
    this.captureStamps = [];
    track.addEventListener('ended', () => {
      if (this.gen === gen) this.detach();
    });
    if (typeof MediaStreamTrackProcessor === 'function') void this.readLoop(track, gen);
    else this.videoLoop(stream, gen);
    this.emitLive(true);
  }

  private detach(): void {
    this.gen++;
    const reader = this.reader;
    this.reader = null;
    if (reader) reader.cancel().catch(() => undefined);
    if (this.grabTimer) clearInterval(this.grabTimer);
    this.grabTimer = null;
    if (this.video) {
      this.video.pause();
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.srcSize = null;
    this.lastAttemptAt = performance.now();
  }

  private async readLoop(track: MediaStreamTrack, gen: number): Promise<void> {
    const reader = new MediaStreamTrackProcessor!({ track }).readable.getReader();
    this.reader = reader;
    try {
      while (this.running && this.gen === gen) {
        const { value: frame, done } = await reader.read();
        if (done) break;
        try {
          if (this.gen === gen) await this.onSourceFrame(frame, frame.displayWidth, frame.displayHeight);
        } finally {
          frame.close();
        }
      }
    } catch {
      // поток закрыт — tick() переподключится
    }
  }

  private videoLoop(stream: MediaStream, gen: number): void {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    void video.play().catch(() => undefined);
    this.grabTimer = setInterval(() => {
      if (this.gen !== gen || video.readyState < 2) return;
      void this.onSourceFrame(video, video.videoWidth, video.videoHeight);
    }, 1e3 / this.opts.fps);
  }

  private async onSourceFrame(src: VideoFrame | HTMLVideoElement, width: number, height: number): Promise<void> {
    const now = performance.now();
    this.lastFrameAt = now;
    this.captureStamps.push(now);
    while (this.captureStamps.length && this.captureStamps[0]! < now - 3e3) this.captureStamps.shift();
    if (this.paused || this.busy || now - this.lastEmitAt < (1e3 / this.opts.fps) * 0.9) return;
    if (!width || !height) return;
    this.busy = true;
    this.lastEmitAt = now;
    try {
      this.srcSize = { width, height };
      const size = fitWidth(width, height, this.opts.maxWidth);
      const bitmap = await createImageBitmap(src, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
      if (!this.running) {
        bitmap.close();
        return;
      }
      this.sample(bitmap, now);
      const took = performance.now() - now;
      this.latencyMs = this.latencyMs === null ? took : this.latencyMs * 0.8 + took * 0.2;
      this.events?.frame({ bitmap, width: bitmap.width, height: bitmap.height, index: this.index++, sourceTimeMs: null, capturedAt: now });
    } catch (err) {
      this.events?.error(liveError('live-frame-failed', `Кадр не получен: ${(err as Error)?.message ?? err}`));
    } finally {
      this.busy = false;
    }
  }

  /** Раз в 0,5 с: средняя яркость (чёрный экран) и хеш (застывшая картинка) по уменьшенному кадру */
  private sample(bitmap: ImageBitmap, now: number): void {
    if (now - this.lastSampleAt < SAMPLE_MS) return;
    this.lastSampleAt = now;
    this.sampleCanvas ??= new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
    const ctx = this.sampleCanvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i]! + 0.587 * data[i + 1]! + 0.114 * data[i + 2]!;
    const luma = sum / (data.length / 4);
    if (luma < LIVE_DARK_LUMA) this.darkSince ??= now;
    else this.darkSince = null;
    const h = hashBytes(data);
    if (h === this.lastHash) this.frozenSince ??= now;
    else this.frozenSince = null;
    this.lastHash = h;
  }

  info(): LiveInfo {
    const now = performance.now();
    const { state, reason } = computeLiveState({
      running: this.running,
      hasStream: !!this.stream,
      now,
      streamStartedAt: this.streamStartedAt,
      lastFrameAt: this.lastFrameAt,
      darkSince: this.darkSince,
      frozenSince: this.frozenSince,
      lastError: this.lastError,
    });
    const span = this.captureStamps.length > 1 ? this.captureStamps[this.captureStamps.length - 1]! - this.captureStamps[0]! : 0;
    return {
      state,
      reason,
      windowName: this.stream ? this.windowName : null,
      width: this.srcSize?.width ?? null,
      height: this.srcSize?.height ?? null,
      captureFps: span > 0 ? Math.round(((this.captureStamps.length - 1) * 1e4) / span) / 10 : 0,
      latencyMs: this.latencyMs === null ? null : Math.round(this.latencyMs),
      errorMessage: state === 'waiting-dota' ? this.errorMessage : null,
      seenWindows: state === 'waiting-dota' ? this.seenWindows : [],
    };
  }

  private emitLive(force: boolean): void {
    if (!this.events) return;
    const info = this.info();
    const key = `${info.state}|${info.reason}`;
    const changed = key !== this.lastState;
    this.lastState = key;
    this.events.live?.(info, force || changed);
  }
}
