import { captureError, type FrameSource, type FrameSourceEvents, type FrameSourceOptions } from './frame-source';
import { fitWidth } from './rate';

const MAX_CONSECUTIVE_ERRORS = 3;

/** Источник: последовательность изображений из выбранной папки */
export class ImageFolderSource implements FrameSource {
  readonly kind = 'image-folder' as const;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private index = 0;
  private running = false;
  private paused = false;
  private errors = 0;
  private abort = new AbortController();
  private opts!: FrameSourceOptions;
  private events!: FrameSourceEvents;

  constructor(private readonly urls: string[]) {}

  get total(): number {
    return this.urls.length;
  }

  async start(opts: FrameSourceOptions, events: FrameSourceEvents): Promise<void> {
    if (this.urls.length === 0) {
      events.error(captureError('source-empty', 'В источнике нет кадров', true));
      return;
    }
    this.opts = opts;
    this.events = events;
    this.running = true;
    this.schedule(0);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort.abort();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), delay);
  }

  private async tick(): Promise<void> {
    const interval = 1000 / this.opts.fps;
    const started = performance.now();
    if (this.paused) return this.schedule(interval);

    if (this.index >= this.urls.length) {
      if (!this.opts.loop) {
        this.running = false;
        this.events.ended();
        return;
      }
      this.index = 0;
    }

    const i = this.index++;
    try {
      const res = await fetch(this.urls[i]!, { signal: this.abort.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      const probe = await createImageBitmap(blob);
      const size = fitWidth(probe.width, probe.height, this.opts.maxWidth);
      let bitmap = probe;
      if (size.width !== probe.width) {
        bitmap = await createImageBitmap(probe, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: 'high' });
        probe.close();
      }
      if (!this.running) {
        bitmap.close();
        return;
      }
      this.errors = 0;
      this.events.frame({ bitmap, width: bitmap.width, height: bitmap.height, index: i, sourceTimeMs: null, capturedAt: performance.now() });
    } catch (err) {
      if (!this.running) return;
      this.errors++;
      const fatal = this.errors >= MAX_CONSECUTIVE_ERRORS;
      this.events.error(captureError('load-failed', `Кадр ${i + 1}: ${(err as Error).message}`, fatal));
      if (fatal) {
        this.running = false;
        return;
      }
    }
    // Держим заданную частоту: время загрузки вычитается из паузы
    this.schedule(Math.max(0, interval - (performance.now() - started)));
  }
}
