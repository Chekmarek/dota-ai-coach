import { LIVE_KIND, type CaptureError, type CaptureState, type CaptureStatus, type LiveInfo, type ReplayStartOptions } from '@shared/types/capture';
import type { EngineToUi } from '@shared/events/engine-protocol';
import type { DotaCoachEngineApi } from '@shared/ipc';
import type { Frame, FrameSource } from './capture/frame-source';
import { FpsMeter, FrameGate, fitWidth } from './capture/rate';
import { ImageFolderSource } from './capture/image-folder-source';
import { VideoFileSource } from './capture/video-file-source';
import { LiveScreenSource } from './capture/live-screen-source';
import { VisionStage } from './vision';
import { GSI_LIVE_MS, MatchStateModel } from '@core/match-state/index.ts';
import { AgreementTracker } from '@core/gsi/index.ts';
import type { GsiBodyMessage } from '@shared/ipc';
import { readGsi } from './gsi';

declare global {
  interface Window {
    /** API окна движка из preload (живой захват) */
    dotacoachEngine?: DotaCoachEngineApi;
  }
}

const PREVIEW_MAX_WIDTH = 960;
const STATUS_INTERVAL_MS = 500;
/** Не чаще стольких результатов распознавания в секунду отправляем в интерфейс */
const VISION_UI_FPS = 5;
/** Состояние матча — не чаще стольких раз в секунду (плюс сразу при новом событии) */
const MATCH_UI_FPS = 4;
/** Состояние матча публикуется, пока идёт источник кадров или GSI был не раньше этого (мс) */
const GSI_PUBLISH_MS = 60_000;

/**
 * Конвейер движка: источник → ограничитель частоты → распознавание HUD → превью для UI.
 * Кадры остаются здесь; наружу уходят статус, результаты распознавания и сжатое превью с ограниченной частотой.
 */
export class Pipeline {
  private source: FrameSource | null = null;
  private state: CaptureState = 'idle';
  private label: string | null = null;
  private received = 0;
  private processed = 0;
  private dropped = 0;
  private lastFrameAt: number | null = null;
  private position: CaptureStatus['position'] = null;
  private lastError: CaptureError | null = null;
  private readonly inMeter = new FpsMeter();
  private readonly procMeter = new FpsMeter();
  private gate = new FrameGate(10);
  private previewIntervalMs = 500;
  private lastPreviewAt = -Infinity;
  private previewBusy = false;
  private canvas: OffscreenCanvas | null = null;
  private statusTimer: ReturnType<typeof setInterval>;
  private readonly vision = new VisionStage();
  private visionMsAvg: number | null = null;
  private lastVisionSentAt = -Infinity;
  /**
   * Модель состояния матча: одна на конвейер. Сбрасывается при запуске и остановке источника кадров,
   * но не пока идёт GSI: тогда матч продолжается и без захвата экрана.
   */
  private readonly match = new MatchStateModel();
  /** Сверка зрения с GSI (только кадры живого захвата — это тот же матч) */
  private readonly agreement = new AgreementTracker();
  private lastGsiAt: number | null = null;
  private gsiMatchId: string | null = null;
  private lastMatchSentAt = -Infinity;
  private sentEventSeq = -1;
  /** Окно интерфейса видно? Если скрыто — превью не кодируем (обработка кадров продолжается) */
  uiVisible = true;
  private live: LiveInfo | null = null;
  private reportedLive: string | null = null;
  private reportedLiveAt = 0;

  /** Сейчас идёт живой захват окна Доты */
  isLive(): boolean {
    return this.source?.kind === LIVE_KIND;
  }

  constructor(private send: (msg: EngineToUi, transfer?: Transferable[]) => void) {
    this.statusTimer = setInterval(() => this.publishStatus(), STATUS_INTERVAL_MS);
  }

  /** GSI присылал данные в последние GSI_LIVE_MS */
  private gsiLive(now = Date.now()): boolean {
    return this.lastGsiAt !== null && now - this.lastGsiAt < GSI_LIVE_MS;
  }

  /** Тело GSI из main (приёмник на 127.0.0.1). Время — часы движка, как у кадров */
  ingestGsi(msg: GsiBodyMessage): void {
    const now = Date.now();
    const reading = readGsi(msg.body);
    // Меню или наблюдение — матча своего героя нет; heartbeat всё равно значит, что GSI работает
    this.lastGsiAt = now;
    if (!reading) return;
    if (reading.matchId !== null && reading.matchId !== this.gsiMatchId) {
      if (this.gsiMatchId !== null) this.agreement.reset();
      this.gsiMatchId = reading.matchId;
    }
    try {
      this.match.ingestGsi(reading, now);
      this.agreement.addGsi(reading, now);
    } catch (err) {
      this.lastError = { code: 'internal', message: `Ошибка данных GSI: ${(err as Error).message}`, fatal: false, at: now };
    }
    this.publishMatch(false);
  }

  setSender(send: (msg: EngineToUi, transfer?: Transferable[]) => void): void {
    this.send = send;
    this.publishStatus();
  }

  async start(o: ReplayStartOptions): Promise<void> {
    await this.stop('stopped');
    this.resetCounters();
    this.gate = new FrameGate(o.processingFpsCap);
    this.previewIntervalMs = 1000 / o.previewFps;
    this.label = o.source.label;
    this.live = null;
    const spec = o.source;
    if (spec.kind === LIVE_KIND) {
      if (!window.dotacoachEngine) throw new Error('Живой захват недоступен: нет API движка');
      this.source = new LiveScreenSource(window.dotacoachEngine);
    } else this.source = spec.kind === 'image-folder' ? new ImageFolderSource(spec.frames) : new VideoFileSource(spec.url);
    const src = this.source;
    this.setState('starting');
    await src.start(
      { fps: o.fps, maxWidth: o.maxWidth, loop: o.loop },
      {
        frame: (f) => (this.source === src ? this.onFrame(f) : f.bitmap.close()),
        error: (e) => {
          if (this.source !== src) return;
          this.lastError = e;
          if (e.fatal) void this.stop('error');
          else this.publishStatus();
        },
        ended: () => {
          if (this.source === src) void this.stop('ended');
        },
        live: (info, changed) => {
          if (this.source !== src) return;
          this.live = info;
          if (changed) this.publishStatus();
        },
      },
    );
    if (this.source === src && this.state === 'starting') this.setState('running');
  }

  pause(): void {
    if (this.state !== 'running') return;
    this.source?.pause();
    this.setState('paused');
  }

  resume(): void {
    if (this.state !== 'paused') return;
    this.source?.resume();
    this.setState('running');
  }

  async stop(finalState: CaptureState = 'stopped'): Promise<void> {
    const src = this.source;
    this.source = null;
    if (src) await src.stop();
    this.gate.reset();
    this.resetMatch();
    if (src || this.state !== 'idle') this.setState(finalState);
  }

  publishStatus(): void {
    this.send({ type: 'status', status: this.status() });
    this.reportLive();
    // Новых кадров может не быть (пауза записи, Дота свёрнута) — метки «видно сейчас/видели раньше» всё равно стареют
    if (this.source || (this.lastGsiAt !== null && Date.now() - this.lastGsiAt < GSI_PUBLISH_MS)) this.publishMatch(false);
  }

  /** Отправляет состояние матча: не чаще MATCH_UI_FPS раз в секунду, а при новом событии — сразу */
  private publishMatch(force: boolean): void {
    const now = performance.now();
    const newEvent = this.match.eventSeq !== this.sentEventSeq;
    if (!force && !newEvent && now - this.lastMatchSentAt < 1000 / MATCH_UI_FPS) return;
    this.lastMatchSentAt = now;
    this.sentEventSeq = this.match.eventSeq;
    const wallMs = Date.now();
    this.send({ type: 'match', state: this.match.snapshot(wallMs), agreement: this.agreement.report(wallMs) });
  }

  /** Новый источник или остановка — состояние прошлого матча больше не относится к делу (кроме матча из GSI) */
  private resetMatch(): void {
    if (this.gsiLive()) return;
    this.match.reset(Date.now());
    this.agreement.reset();
    this.publishMatch(true);
  }

  /** Короткий статус живого режима для main (значок поверх игры и журнал live.log) */
  private reportLive(): void {
    const api = window.dotacoachEngine;
    if (!api) return;
    const live = this.isLive() ? this.live : null;
    const state = live ? live.state : 'off';
    const reason = live?.reason ?? null;
    const error = live?.errorMessage ?? null;
    const key = `${state}|${reason}|${error}`;
    const now = Date.now();
    if (key === this.reportedLive && now - this.reportedLiveAt < 2e3) return;
    this.reportedLive = key;
    this.reportedLiveAt = now;
    try {
      api.reportLive({ state, reason, error, fps: state === 'off' ? 0 : round(this.inMeter.fps(performance.now())) });
    } catch {
      /* main недоступен — не критично */
    }
  }

  private onFrame(f: Frame): void {
    const now = performance.now();
    this.received++;
    this.inMeter.tick(now);
    this.lastFrameAt = Date.now();
    this.position = { index: f.index, total: this.source?.total ?? null, sourceTimeMs: f.sourceTimeMs };
    if (this.state === 'starting') this.setState('running');

    if (!this.gate.tryAcquire(now)) {
      this.dropped++;
      f.bitmap.close();
      return;
    }
    try {
      const reading = this.vision.run(f.bitmap, f.sourceTimeMs ?? Date.now());
      this.visionMsAvg = this.visionMsAvg === null ? reading.durationMs : this.visionMsAvg * 0.9 + reading.durationMs * 0.1;
      if (now - this.lastVisionSentAt >= 1000 / VISION_UI_FPS) {
        this.lastVisionSentAt = now;
        this.send({ type: 'vision', reading, frameIndex: f.index, sourceTimeMs: f.sourceTimeMs });
      }
      // Пока идёт GSI, кадры записи — другой матч: в модель идут только кадры живого захвата
      const wallMs = Date.now();
      if (this.isLive() || !this.gsiLive(wallMs)) {
        this.match.ingest(reading, wallMs);
        if (this.isLive()) this.agreement.addScreen(reading, wallMs);
        this.publishMatch(false);
      }
    } catch (err) {
      this.lastError = { code: 'internal', message: `Ошибка распознавания: ${(err as Error).message}`, fatal: false, at: Date.now() };
    } finally {
      this.processed++;
      this.procMeter.tick(performance.now());
      this.maybePreview(f, now);
      this.gate.done();
    }
  }

  private maybePreview(f: Frame, now: number): void {
    if (!this.uiVisible || this.previewBusy || now - this.lastPreviewAt < this.previewIntervalMs * 0.9) {
      f.bitmap.close();
      return;
    }
    this.lastPreviewAt = now;
    this.previewBusy = true;
    const size = fitWidth(f.width, f.height, PREVIEW_MAX_WIDTH);
    this.canvas ??= new OffscreenCanvas(size.width, size.height);
    if (this.canvas.width !== size.width || this.canvas.height !== size.height) {
      this.canvas.width = size.width;
      this.canvas.height = size.height;
    }
    const ctx = this.canvas.getContext('2d')!;
    ctx.drawImage(f.bitmap, 0, 0, size.width, size.height);
    f.bitmap.close();
    void this.canvas
      .convertToBlob({ type: 'image/jpeg', quality: 0.75 })
      .then((b) => b.arrayBuffer())
      .then((jpeg) => {
        this.send(
          { type: 'preview', jpeg, width: size.width, height: size.height, frameIndex: f.index, sourceTimeMs: f.sourceTimeMs },
          [jpeg],
        );
      })
      .catch(() => undefined)
      .finally(() => {
        this.previewBusy = false;
      });
  }

  private setState(s: CaptureState): void {
    this.state = s;
    this.publishStatus();
  }

  private resetCounters(): void {
    this.received = this.processed = this.dropped = 0;
    this.lastFrameAt = null;
    this.position = null;
    this.lastError = null;
    this.lastPreviewAt = -Infinity;
    this.lastVisionSentAt = -Infinity;
    this.visionMsAvg = null;
    this.inMeter.reset();
    this.procMeter.reset();
  }

  private status(): CaptureStatus {
    const now = performance.now();
    return {
      state: this.state,
      sourceKind: this.source?.kind ?? null,
      sourceLabel: this.label,
      framesReceived: this.received,
      framesProcessed: this.processed,
      framesDropped: this.dropped,
      measuredFps: round(this.inMeter.fps(now)),
      processingFps: round(this.procMeter.fps(now)),
      lastFrameAt: this.lastFrameAt,
      position: this.position,
      lastError: this.lastError,
      live: this.isLive() ? this.live : null,
      pipeline: { vision: 'hud-numbers', visionMs: this.visionMsAvg === null ? null : round(this.visionMsAvg) },
    };
  }

  dispose(): void {
    clearInterval(this.statusTimer);
    void this.stop();
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
