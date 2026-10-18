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
import { AgreementTracker, GameModeTracker, VisionAgreementTracker, parseSpectatorGsi } from '@core/gsi/index.ts';
import type { GsiBodyMessage } from '@shared/ipc';
import { readGsi } from './gsi';
import type { GsiReading } from '@core/gsi/index.ts';

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
/** Снимок матча для движка подсказок в main — не чаще (мс) */
const COACH_EVERY_MS = 500;
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
  private lastReading: GsiReading | null = null;
  private lastReadingAt: number | null = null;
  private lastCoachAt = 0;
  /** Сверка зрения с GSI (только кадры живого захвата — это тот же матч) */
  private readonly agreement = new AgreementTracker();
  /** Режим игры по потоку GSI: Турбо, обычный, против ботов (часы в начале подготовки) */
  private readonly modeTracker = new GameModeTracker();
  /** Точность зрения о союзниках и врагах — только когда Dota присылает GSI наблюдателя (все 10 героев) */
  private readonly visionAgreement = new VisionAgreementTracker();
  private spectatorMatchId: string | null = null;
  private lastGsiAt: number | null = null;
  /** Свой герой из последнего GSI (ячейка и координаты) — для самокалибровки мини-карты; со временем получения */
  private ownHero: { slot: number; x: number; y: number; at: number } | null = null;
  private gsiMatchId: string | null = null;
  private lastMatchSentAt = -Infinity;
  private sentEventSeq = -1;
  /** Окно интерфейса видно? Если скрыто — превью не кодируем (обработка кадров продолжается) */
  uiVisible = true;
  private live: LiveInfo | null = null;
  private reportedLive: string | null = null;
  private reportedLiveAt = 0;
  /** Набор кадров для проверки зрения (только режим разработчика): каждый N-й кадр живого захвата; 0 — выключено */
  private datasetEveryN = 0;
  private datasetBusy = false;
  private datasetCanvas: OffscreenCanvas | null = null;

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
    // Режим игры — по всему потоку тел (часы в начале подготовки видны и в телах без своего героя)
    const mode = this.modeTracker.feed(msg.body, now);
    const raw = readGsi(msg.body);
    const reading = raw ? { ...raw, gameMode: mode } : null;
    // Меню или наблюдение — матча своего героя нет; heartbeat всё равно значит, что GSI работает
    this.lastGsiAt = now;
    // Наблюдатель: своего героя нет (reading будет null), сверка зрения — по всем 10 героям; новый матч — с нуля
    const spectator = parseSpectatorGsi(msg.body);
    const spectatorMatch = (msg.body as { map?: { matchid?: unknown } } | null)?.map?.matchid;
    if (spectator && typeof spectatorMatch === 'string' && spectatorMatch !== this.spectatorMatchId) {
      this.spectatorMatchId = spectatorMatch;
      this.visionAgreement.reset();
    }
    this.visionAgreement.addSpectator(spectator, now);
    if (!reading) return;
    this.lastReading = reading;
    this.lastReadingAt = now;
    if (reading.slot !== null && reading.hero.x !== null && reading.hero.y !== null) this.ownHero = { slot: reading.slot, x: reading.hero.x, y: reading.hero.y, at: now };
    if (reading.matchId !== null && reading.matchId !== this.gsiMatchId) {
      if (this.gsiMatchId !== null) {
        this.agreement.reset();
        this.visionAgreement.reset();
      }
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

  /** Запись набора кадров (main решает, включена ли: только DOTACOACH_DEV=1 и настройка) */
  setDatasetEveryN(n: number): void {
    this.datasetEveryN = Number.isInteger(n) && n > 0 ? n : 0;
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
    const state = this.match.snapshot(wallMs);
    this.send({ type: 'match', state, agreement: { ...this.agreement.report(wallMs), ...this.visionAgreement.report() } });
    this.reportCoach(state, wallMs);
  }

  /** Снимок матча → движок подсказок в main: только живая игра или данные из игры (не разбор записи) */
  private reportCoach(state: ReturnType<MatchStateModel['snapshot']>, wallMs: number): void {
    const api = window.dotacoachEngine;
    if (!api?.reportCoach || wallMs - this.lastCoachAt < COACH_EVERY_MS) return;
    const gsiFresh = this.lastGsiAt !== null && wallMs - this.lastGsiAt < GSI_PUBLISH_MS;
    if (!this.isLive() && !gsiFresh) return;
    this.lastCoachAt = wallMs;
    api.reportCoach({ state, gsi: gsiFresh ? this.lastReading : null, gsiWallMs: gsiFresh ? this.lastReadingAt : null });
  }

  /** Новый источник или остановка — состояние прошлого матча больше не относится к делу (кроме матча из GSI) */
  private resetMatch(): void {
    if (this.gsiLive()) return;
    this.match.reset(Date.now());
    this.agreement.reset();
    this.visionAgreement.reset();
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
    if (this.datasetEveryN > 0 && this.isLive() && this.received % this.datasetEveryN === 0) this.saveDatasetFrame(f);

    if (!this.gate.tryAcquire(now)) {
      this.dropped++;
      f.bitmap.close();
      return;
    }
    try {
      // Свой герой для самокалибровки мини-карты — только живой захват и только свежий GSI (кадр и координаты одного момента)
      const own = this.isLive() && this.ownHero && Date.now() - this.ownHero.at < 300 ? this.ownHero : null;
      const reading = this.vision.run(f.bitmap, f.sourceTimeMs ?? Date.now(), own);
      this.visionMsAvg = this.visionMsAvg === null ? reading.durationMs : this.visionMsAvg * 0.9 + reading.durationMs * 0.1;
      if (now - this.lastVisionSentAt >= 1000 / VISION_UI_FPS) {
        this.lastVisionSentAt = now;
        this.send({ type: 'vision', reading, frameIndex: f.index, sourceTimeMs: f.sourceTimeMs });
      }
      // Пока идёт GSI, кадры записи — другой матч: в модель идут только кадры живого захвата
      const wallMs = Date.now();
      if (this.isLive() || !this.gsiLive(wallMs)) {
        this.match.ingest(reading, wallMs);
        if (this.isLive()) {
          this.agreement.addScreen(reading, wallMs);
          this.visionAgreement.addScreen(reading, wallMs);
        }
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

  /**
   * Кадр полного размера → PNG → main (там он сохраняется вместе с GSI наблюдателя).
   * Рисуем сразу (bitmap дальше закроется), кодируем асинхронно; пока предыдущий не ушёл — новый пропускаем.
   */
  private saveDatasetFrame(f: Frame): void {
    const api = window.dotacoachEngine;
    if (!api || this.datasetBusy) return;
    this.datasetBusy = true;
    const wallMs = Date.now();
    this.datasetCanvas ??= new OffscreenCanvas(f.width, f.height);
    const c = this.datasetCanvas;
    if (c.width !== f.width || c.height !== f.height) {
      c.width = f.width;
      c.height = f.height;
    }
    c.getContext('2d')!.drawImage(f.bitmap, 0, 0);
    void c
      .convertToBlob({ type: 'image/png' })
      .then((b) => b.arrayBuffer())
      .then((png) => api.saveDatasetFrame({ png, width: f.width, height: f.height, wallMs }))
      .catch(() => undefined)
      .finally(() => {
        this.datasetBusy = false;
      });
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
