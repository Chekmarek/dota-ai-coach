import { captureError, type FrameSource, type FrameSourceEvents, type FrameSourceOptions } from './frame-source';
import { fitWidth } from './rate';

const STALL_TIMEOUT_MS = 5000;

/** Источник: видеофайл, проигрываемый в реальном времени; кадры берутся с заданной частотой */
export class VideoFileSource implements FrameSource {
  readonly kind = 'video-file' as const;
  readonly total = null;
  private video: HTMLVideoElement | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private index = 0;
  private lastTime = -1;
  private lastProgressAt = 0;
  private grabbing = false;
  private paused = false;
  private opts!: FrameSourceOptions;
  private events!: FrameSourceEvents;

  constructor(private readonly url: string) {}

  async start(opts: FrameSourceOptions, events: FrameSourceEvents): Promise<void> {
    this.opts = opts;
    this.events = events;
    const video = document.createElement('video');
    this.video = video;
    video.muted = true;
    video.playsInline = true;
    video.crossOrigin = 'anonymous';
    video.preload = 'auto';
    video.loop = opts.loop;
    video.addEventListener('error', () => {
      const msg = video.error?.message || `код ${video.error?.code ?? '?'}`;
      this.events.error(captureError('decode-failed', `Видео не читается: ${msg}`, true));
      void this.stop();
    });
    video.addEventListener('ended', () => {
      this.clearTimer();
      this.events.ended();
    });
    video.src = this.url;

    try {
      await video.play();
    } catch (err) {
      if (this.video) this.events.error(captureError('decode-failed', `Не удалось запустить видео: ${(err as Error).message}`, true));
      await this.stop();
      return;
    }
    this.lastProgressAt = performance.now();
    this.timer = setInterval(() => void this.grab(), 1000 / opts.fps);
  }

  pause(): void {
    this.paused = true;
    this.video?.pause();
  }

  resume(): void {
    if (!this.video || !this.paused) return;
    this.paused = false;
    this.lastProgressAt = performance.now();
    void this.video.play();
  }

  async stop(): Promise<void> {
    this.clearTimer();
    const v = this.video;
    this.video = null;
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load(); // освобождает декодер
    }
  }

  private clearTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async grab(): Promise<void> {
    const v = this.video;
    if (!v || this.paused || this.grabbing || v.readyState < 2) return;
    const now = performance.now();
    if (v.currentTime === this.lastTime) {
      if (now - this.lastProgressAt > STALL_TIMEOUT_MS) {
        this.events.error(captureError('stalled', 'Видео перестало воспроизводиться', true));
        await this.stop();
      }
      return;
    }
    this.lastTime = v.currentTime;
    this.lastProgressAt = now;
    this.grabbing = true;
    try {
      const size = fitWidth(v.videoWidth, v.videoHeight, this.opts.maxWidth);
      const bitmap = await createImageBitmap(v, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'medium' });
      if (!this.video) {
        bitmap.close();
        return;
      }
      this.events.frame({
        bitmap,
        width: bitmap.width,
        height: bitmap.height,
        index: this.index++,
        sourceTimeMs: Math.round(v.currentTime * 1000),
        capturedAt: performance.now(),
      });
    } catch (err) {
      this.events.error(captureError('decode-failed', `Кадр не получен: ${(err as Error).message}`, false));
    } finally {
      this.grabbing = false;
    }
  }
}
