// Живой захват окна Dota 2 (движок).
// Источник кадров с тем же интерфейсом, что ImageFolderSource и VideoFileSource:
// start(opts, events) / pause() / resume() / stop(). Дополнительно сообщает events.live(info).
// Никогда не завершается фатальной ошибкой: если Доты нет — ждёт и переподключается сам.

export const LIVE_KIND = "live-screen";
export const LIVE_RETRY_MS = 3e3;
export const LIVE_RETRY_SLOW_MS = 1e4;
export const LIVE_RETRY_SLOW_AFTER_MS = 6e4;
export const LIVE_NO_FRAME_MS = 2e3;
export const LIVE_DARK_MS = 3e3;
export const LIVE_FROZEN_MS = 1e4;
export const LIVE_RECONNECT_MS = 15e3;
export const LIVE_DARK_LUMA = 4;
const TICK_MS = 500;
const SAMPLE_MS = 500;
const SAMPLE_W = 64;
const SAMPLE_H = 36;

/**
 * Чистая функция: по фактам о захвате возвращает состояние и причину.
 * f: { running, hasStream, now, streamStartedAt, lastFrameAt, darkSince, frozenSince, lastError }
 * state: off | waiting-dota | no-image | seeing
 */
export function computeLiveState(f) {
  if (!f.running) return { state: "off", reason: null };
  if (!f.hasStream) return { state: "waiting-dota", reason: f.lastError ?? "not-found" };
  const last = f.lastFrameAt ?? f.streamStartedAt;
  if (f.now - last > LIVE_NO_FRAME_MS) return { state: "no-image", reason: "no-frames" };
  if (f.darkSince !== null && f.now - f.darkSince >= LIVE_DARK_MS) return { state: "no-image", reason: "dark" };
  if (f.frozenSince !== null && f.now - f.frozenSince >= LIVE_FROZEN_MS) return { state: "no-image", reason: "frozen" };
  return { state: "seeing", reason: null };
}

/** Чистая функция: пауза между попытками найти Доту — 3 с первые 60 с ожидания, затем 10 с */
export function liveRetryDelay(waitedMs) {
  return waitedMs < LIVE_RETRY_SLOW_AFTER_MS ? LIVE_RETRY_MS : LIVE_RETRY_SLOW_MS;
}

function fitWidth(width, height, maxWidth) {
  if (width <= 0 || height <= 0) return { width: 0, height: 0 };
  if (width <= maxWidth) return { width, height };
  return { width: maxWidth, height: Math.max(1, Math.round(height * maxWidth / width)) };
}

function liveError(code, message) {
  return { code, message, fatal: false, at: Date.now() };
}

/** Быстрый хеш байтов (FNV-1a) — чтобы заметить полностью застывшую картинку */
function hashBytes(data) {
  let h = 2166136261;
  for (let i = 0; i < data.length; i += 4) {
    h ^= data[i] | data[i + 1] << 8 | data[i + 2] << 16;
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export class LiveScreenSource {
  /** api: { findDota(): Promise<{id,name}|null> } — из preload движка */
  constructor(api) {
    this.api = api;
  }
  api;
  kind = LIVE_KIND;
  total = null;
  opts;
  events;
  running = false;
  paused = false;
  connecting = false;
  stream = null;
  video = null;
  reader = null;
  grabTimer = null;
  tickTimer = null;
  gen = 0;
  windowName = null;
  srcSize = null;
  streamStartedAt = 0;
  lastAttemptAt = -Infinity;
  waitingSince = null;
  lastFrameAt = null;
  lastEmitAt = -Infinity;
  busy = false;
  index = 0;
  darkSince = null;
  frozenSince = null;
  lastHash = null;
  lastSampleAt = -Infinity;
  lastError = null;
  latencyMs = null;
  captureStamps = [];
  sampleCanvas = null;
  lastState = null;
  seenWindows = [];
  errorMessage = null;

  async start(opts, events) {
    this.opts = opts;
    this.events = events;
    this.running = true;
    this.waitingSince = null;
    this.lastAttemptAt = -Infinity;
    this.tickTimer = setInterval(() => this.tick(), TICK_MS);
    this.tick();
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  async stop() {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    this.tickTimer = null;
    this.detach();
    this.emitLive(true);
  }

  tick() {
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

  async connect() {
    this.connecting = true;
    try {
      const res = await this.api.findDota();
      if (!this.running) return;
      this.seenWindows = Array.isArray(res?.windows) ? res.windows : [];
      const src = res?.source ?? null;
      if (!src) {
        this.lastError = "not-found";
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
      this.lastError = "open-failed";
      this.errorMessage = `${err?.name ?? "Error"}: ${err?.message ?? err}`.slice(0, 380);
      if (this.running) this.events.error(liveError("live-open-failed", `Не удалось подключиться к окну Доты: ${err?.message ?? err}`));
    } finally {
      this.connecting = false;
      this.lastAttemptAt = performance.now();
    }
  }

  async open(sourceId) {
    try {
      // Основной путь Electron: захват конкретного окна по id, без системного диалога
      return await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: "desktop",
            chromeMediaSourceId: sourceId,
            maxFrameRate: this.opts.fps,
            maxWidth: this.opts.maxWidth,
            maxHeight: Math.ceil(this.opts.maxWidth * 0.75)
          }
        }
      });
    } catch (first) {
      // Запасной путь: getDisplayMedia, main отдаёт только окно Доты
      try {
        return await navigator.mediaDevices.getDisplayMedia({
          audio: false,
          video: {
            frameRate: { ideal: this.opts.fps, max: this.opts.fps },
            width: { ideal: this.opts.maxWidth },
            height: { ideal: Math.ceil(this.opts.maxWidth * 0.75) }
          }
        });
      } catch {
        throw first;
      }
    }
  }

  attach(stream) {
    const track = stream.getVideoTracks()[0];
    if (!track) {
      stream.getTracks().forEach((t) => t.stop());
      throw new Error("в потоке нет видео");
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
    track.addEventListener("ended", () => {
      if (this.gen === gen) this.detach();
    });
    if (typeof MediaStreamTrackProcessor === "function") void this.readLoop(track, gen);
    else this.videoLoop(stream, gen);
    this.emitLive(true);
  }

  detach() {
    this.gen++;
    const reader = this.reader;
    this.reader = null;
    if (reader) reader.cancel().catch(() => void 0);
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

  async readLoop(track, gen) {
    const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
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

  videoLoop(stream, gen) {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    this.video = video;
    void video.play().catch(() => void 0);
    this.grabTimer = setInterval(() => {
      if (this.gen !== gen || video.readyState < 2) return;
      void this.onSourceFrame(video, video.videoWidth, video.videoHeight);
    }, 1e3 / this.opts.fps);
  }

  async onSourceFrame(src, width, height) {
    const now = performance.now();
    this.lastFrameAt = now;
    this.captureStamps.push(now);
    while (this.captureStamps.length && this.captureStamps[0] < now - 3e3) this.captureStamps.shift();
    if (this.paused || this.busy || now - this.lastEmitAt < 1e3 / this.opts.fps * 0.9) return;
    if (!width || !height) return;
    this.busy = true;
    this.lastEmitAt = now;
    try {
      this.srcSize = { width, height };
      const size = fitWidth(width, height, this.opts.maxWidth);
      const bitmap = await createImageBitmap(src, { resizeWidth: size.width, resizeHeight: size.height, resizeQuality: "medium" });
      if (!this.running) {
        bitmap.close();
        return;
      }
      this.sample(bitmap, now);
      const took = performance.now() - now;
      this.latencyMs = this.latencyMs === null ? took : this.latencyMs * 0.8 + took * 0.2;
      this.events.frame({ bitmap, width: bitmap.width, height: bitmap.height, index: this.index++, sourceTimeMs: null, capturedAt: now });
    } catch (err) {
      this.events.error(liveError("live-frame-failed", `Кадр не получен: ${err?.message ?? err}`));
    } finally {
      this.busy = false;
    }
  }

  /** Раз в 0,5 с: средняя яркость (чёрный экран) и хеш (застывшая картинка) по уменьшенному кадру */
  sample(bitmap, now) {
    if (now - this.lastSampleAt < SAMPLE_MS) return;
    this.lastSampleAt = now;
    this.sampleCanvas ??= new OffscreenCanvas(SAMPLE_W, SAMPLE_H);
    const ctx = this.sampleCanvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(bitmap, 0, 0, SAMPLE_W, SAMPLE_H);
    const data = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
    const luma = sum / (data.length / 4);
    if (luma < LIVE_DARK_LUMA) this.darkSince ??= now;
    else this.darkSince = null;
    const h = hashBytes(data);
    if (h === this.lastHash) this.frozenSince ??= now;
    else this.frozenSince = null;
    this.lastHash = h;
  }

  info() {
    const now = performance.now();
    const { state, reason } = computeLiveState({
      running: this.running,
      hasStream: !!this.stream,
      now,
      streamStartedAt: this.streamStartedAt,
      lastFrameAt: this.lastFrameAt,
      darkSince: this.darkSince,
      frozenSince: this.frozenSince,
      lastError: this.lastError
    });
    const span = this.captureStamps.length > 1 ? this.captureStamps[this.captureStamps.length - 1] - this.captureStamps[0] : 0;
    return {
      state,
      reason,
      windowName: this.stream ? this.windowName : null,
      width: this.srcSize?.width ?? null,
      height: this.srcSize?.height ?? null,
      captureFps: span > 0 ? Math.round((this.captureStamps.length - 1) * 1e4 / span) / 10 : 0,
      latencyMs: this.latencyMs === null ? null : Math.round(this.latencyMs),
      errorMessage: state === "waiting-dota" ? this.errorMessage : null,
      seenWindows: state === "waiting-dota" ? this.seenWindows : []
    };
  }

  emitLive(force) {
    if (!this.events) return;
    const info = this.info();
    const key = `${info.state}|${info.reason}`;
    const changed = key !== this.lastState;
    this.lastState = key;
    this.events.live?.(info, force || changed);
  }
}
