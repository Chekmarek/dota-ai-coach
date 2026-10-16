// Живой захват окна Dota 2 (main-процесс). Перенесено из обновлений 0.5.0–0.7.0 (out/main/live.js), логика не менялась.
// Всё, что относится к живому режиму, собрано здесь: поиск окна игры, разрешение
// захвата только для окна движка, приём статуса от движка и значок поверх игры.
// Доступ к игре только на чтение: снимок окна средствами Windows, без чтения памяти
// и без вмешательства в процесс dota2.exe.
import { HudOverlay } from './hud-window';
import type { HudHint } from '@shared/types/hud';
import type { SampleScene } from '@shared/hud-samples';
import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, webContents, type WebContents } from 'electron';
import { appendFileSync, renameSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { LIVE_IPC, type FindDotaResult } from '@shared/ipc';
import type { OverlayCorner, Settings } from '@shared/schemas/settings';
import type { LiveState } from '@shared/types/capture';
import { detectDotaVideo, type DotaVideo } from './dota-video';

const LIVE_STATES = ['off', 'waiting-dota', 'no-image', 'seeing'] as const;
// Проверено на настоящей Доте: заголовок окна «Dota 2»; окна самого коуча пропускаются
const DOTA_WINDOW_TITLE = /dota\s*2/i;
const OWN_WINDOW_TITLE = /dota ai coach/i;

// Журнал диагностики: <папка данных>/live.log (не больше ~256 КБ, старый — live.log.old)
const LOG_MAX = 256 * 1024;
let logFile: string | null = null;
export function liveLog(...parts: unknown[]): void {
  try {
    logFile ??= join(app.getPath('userData'), 'live.log');
    try {
      if (statSync(logFile).size > LOG_MAX) renameSync(logFile, `${logFile}.old`);
    } catch {
      /* файла ещё нет */
    }
    const line = parts.map((p) => (typeof p === 'string' ? p : JSON.stringify(p))).join(' ');
    appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    /* журнал не должен ронять приложение */
  }
}

let engineContentsId: number | null = null;

/** Вызывается при каждом (пере)создании окна движка */
export function setLiveEngine(contents: WebContents | null): void {
  engineContentsId = contents ? contents.id : null;
}

export function isLiveEngine(contents: WebContents | null | undefined): boolean {
  return !!contents && engineContentsId !== null && contents.id === engineContentsId;
}

/**
 * Разрешение для permission-обработчика: только видео (захват окна) и только окну движка.
 * Всё остальное по-прежнему запрещено.
 * ⚠ Windows присылает mediaTypes: [] — пустой список тоже допустим (проверено на настоящей Доте:
 * со строгой проверкой length > 0 коуч Доту не видел).
 */
export function allowLivePermission(contents: WebContents | null, permission: string, details?: { mediaTypes?: unknown }): boolean {
  if (permission !== 'media' || !isLiveEngine(contents)) {
    if (isLiveEngine(contents)) liveLog('permission denied', permission);
    return false;
  }
  const types = details && Array.isArray(details.mediaTypes) ? (details.mediaTypes as unknown[]) : [];
  // Захват окна приходит как media без звука; mediaTypes может быть пустым или ["video"]
  const ok = types.every((t) => t === 'video');
  liveLog('permission media', { mediaTypes: types, granted: ok });
  return ok;
}

// Режим экрана Доты (exclusive / borderless / windowed / unknown) читаем не чаще раза в 30 с (с 0.6.0)
const VIDEO_CHECK_MS = 30e3;
let videoCache: DotaVideo | null = null;
let videoAt = -Infinity;
let videoPending: Promise<DotaVideo> | null = null;
let lastVideoKey: string | null = null;
async function dotaVideoMode(): Promise<DotaVideo> {
  if (videoPending) return videoPending;
  if (videoCache && Date.now() - videoAt < VIDEO_CHECK_MS) return videoCache;
  videoPending = detectDotaVideo()
    .then((res) => {
      videoCache = res;
      videoAt = Date.now();
      const key = `${res.mode}|${res.file}|${JSON.stringify(res.raw)}`;
      if (key !== lastVideoKey) {
        lastVideoKey = key;
        liveLog('dota-video', res);
      }
      return res;
    })
    .finally(() => {
      videoPending = null;
    });
  return videoPending;
}

let lastWindowsKey: string | null = null;
/** Ищет окно Доты; windows — заголовки всех найденных окон (для диагностики), videoMode — режим экрана */
async function findDotaSource(): Promise<{ source: Electron.DesktopCapturerSource | null; windows: string[]; videoMode: DotaVideo['mode'] | null }> {
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false,
  });
  const names = sources.map((s) => s.name.trim()).filter(Boolean);
  const candidates = sources.filter((s) => DOTA_WINDOW_TITLE.test(s.name) && !OWN_WINDOW_TITLE.test(s.name));
  // Сначала точное «Dota 2», потом любое окно с «Dota 2» в заголовке
  const source = candidates.find((s) => s.name.trim() === 'Dota 2') ?? candidates[0] ?? null;
  const key = `${source?.name ?? '-'}|${names.join('|')}`;
  if (key !== lastWindowsKey) {
    lastWindowsKey = key;
    liveLog('windows', { found: source ? { id: source.id, name: source.name } : null, all: names.slice(0, 40) });
  }
  // Режим экрана проверяем только когда окно Доты найдено
  const video = source ? await dotaVideoMode() : null;
  return { source, windows: names.slice(0, 30), videoMode: video?.mode ?? null };
}

const liveStatusSchema = z.object({
  state: z.enum(LIVE_STATES),
  fps: z.number().min(0).max(1000),
  reason: z.string().max(40).nullable().optional(),
  error: z.string().max(400).nullable().optional(),
});

// Окно чуть больше самого значка (172×46): запас под искры и угольки, он прозрачный и мышь пропускает
const OVERLAY_SIZE = { width: 196, height: 62 };
const OVERLAY_MARGIN = 12;
// Сколько ждать, пока значок уйдёт анимацией, прежде чем спрятать окно
const OVERLAY_FOLD_MS = 400;

// Значок должен оставаться поверх окна Доты. Windows поднимает окно игры при фокусе,
// поэтому z-порядок периодически восстанавливаем. Фокус значок не забирает никогда.
const OVERLAY_ASSERT_MS = 1500;
const OVERLAY_LEVEL = 'screen-saver' as const;
const OVERLAY_RELATIVE_LEVEL = 1;

export interface LiveDeps {
  settings: { get(): Settings };
  preloadDir: string;
  pageUrl: (page: 'overlay' | 'hud') => { url?: string; file?: string };
  harden: (contents: WebContents) => void;
}

interface OverlayStatus {
  state: LiveState;
  fps: number;
}

/** Значок «Коуч» поверх игры: прозрачный, без фокуса, пропускает клики, не попадает в захват */
class Overlay {
  private win: BrowserWindow | null = null;
  private last: OverlayStatus = { state: 'off', fps: 0 };
  private assertTimer: ReturnType<typeof setInterval> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private lastLogKey: string | null = null;

  constructor(private readonly deps: LiveDeps) {}

  update(status: OverlayStatus): void {
    this.last = status;
    this.refresh();
  }

  refresh(): void {
    const live = this.deps.settings.get().live;
    const visible = live.overlay && (this.last.state === 'seeing' || this.last.state === 'no-image');
    if (!visible) {
      const win = this.win;
      if (win && !win.isDestroyed() && win.isVisible()) {
        // Сначала отправляем скрытое состояние: значок уходит анимацией, окно прячем позже
        win.webContents.send(LIVE_IPC.overlayState, this.payload());
        this.scheduleHide();
      } else {
        this.stopAssert();
      }
      this.logState(false, live.overlayCorner, null);
      return;
    }
    this.cancelHide();
    const win = this.ensure();
    const bounds = this.bounds(live.overlayCorner);
    win.setBounds(bounds);
    if (!win.isVisible()) {
      win.showInactive();
      this.assertTop();
    }
    this.startAssert();
    win.webContents.send(LIVE_IPC.overlayState, this.payload());
    this.logState(true, live.overlayCorner, bounds);
  }

  hide(): void {
    this.last = { state: 'off', fps: 0 };
    this.refresh();
  }

  /** Состояние для значка и угол: от угла зависит, где прижат сам значок внутри окна */
  private payload(): OverlayStatus & { corner: OverlayCorner } {
    return { ...this.last, corner: this.deps.settings.get().live.overlayCorner };
  }

  private scheduleHide(): void {
    if (this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      const win = this.win;
      if (win && !win.isDestroyed()) win.hide();
      this.stopAssert();
    }, OVERLAY_FOLD_MS);
  }

  private cancelHide(): void {
    if (!this.hideTimer) return;
    clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  /** Журнал только при изменении видимости, угла или положения */
  private logState(visible: boolean, corner: OverlayCorner, bounds: Electron.Rectangle | null): void {
    const key = `${visible}|${corner}|${bounds ? `${bounds.x},${bounds.y},${bounds.width},${bounds.height}` : '-'}`;
    if (key === this.lastLogKey) return;
    this.lastLogKey = key;
    liveLog('overlay', { visible, corner, bounds });
  }

  /** Возвращает значок наверх, не активируя его */
  private assertTop(): void {
    const win = this.win;
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    if (!win.isAlwaysOnTop()) win.setAlwaysOnTop(true, OVERLAY_LEVEL, OVERLAY_RELATIVE_LEVEL);
    win.moveTop();
  }

  private startAssert(): void {
    if (this.assertTimer) return;
    this.assertTimer = setInterval(() => this.assertTop(), OVERLAY_ASSERT_MS);
  }

  private stopAssert(): void {
    if (this.assertTimer) clearInterval(this.assertTimer);
    this.assertTimer = null;
  }

  private bounds(corner: OverlayCorner): Electron.Rectangle {
    const area = screen.getPrimaryDisplay().bounds;
    const left = corner.endsWith('left');
    const top = corner.startsWith('top');
    return {
      x: left ? area.x + OVERLAY_MARGIN : area.x + area.width - OVERLAY_SIZE.width - OVERLAY_MARGIN,
      y: top ? area.y + OVERLAY_MARGIN : area.y + area.height - OVERLAY_SIZE.height - OVERLAY_MARGIN,
      ...OVERLAY_SIZE,
    };
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      ...OVERLAY_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: 'Dota AI Coach — индикатор',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        preload: join(this.deps.preloadDir, 'overlay.cjs'),
      },
    });
    this.deps.harden(win.webContents);
    win.setAlwaysOnTop(true, OVERLAY_LEVEL, OVERLAY_RELATIVE_LEVEL);
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.setVisibleOnAllWorkspaces(true);
    win.on('always-on-top-changed', (_e, isOnTop) => {
      if (!isOnTop) this.assertTop();
    });
    win.on('closed', () => {
      this.stopAssert();
      this.cancelHide();
      if (this.win === win) this.win = null;
    });
    win.webContents.on('did-finish-load', () => win.webContents.send(LIVE_IPC.overlayState, this.payload()));
    const target = this.deps.pageUrl('overlay');
    if (target.url) void win.loadURL(target.url);
    else void win.loadFile(target.file!);
    this.win = win;
    return win;
  }
}

let overlay: Overlay | null = null;
/** Окно подсказок поверх игры (этап 3) */
let hud: HudOverlay | null = null;
let lastLoggedState: string | null = null;
/** Последнее состояние живого захвата и когда оно пришло */
let liveSeen: { state: string; at: number } = { state: 'off', at: 0 };

/** Живой захват видит окно Доты (статус не старше 10 с) — ИИ тогда бережёт CPU */
export function liveSeesDota(): boolean {
  return liveSeen.state === 'seeing' && Date.now() - liveSeen.at < 10_000;
}
let lastLoggedReason: string | null | undefined = null;
let lastLoggedError: string | null | undefined = null;

/** Подключает живой режим */
export function setupLive(deps: LiveDeps): void {
  liveLog('setup', { app: app.getVersion(), electron: process.versions.electron, platform: process.platform });
  overlay = new Overlay(deps);
  hud = new HudOverlay({ ...deps, log: liveLog });

  ipcMain.handle(LIVE_IPC.findDota, async (e): Promise<FindDotaResult> => {
    if (!isLiveEngine(e.sender)) throw new Error('Untrusted IPC sender');
    try {
      const { source, windows, videoMode } = await findDotaSource();
      hud?.setDotaSource(source?.id ?? null);
      return { source: source ? { id: source.id, name: source.name } : null, windows, videoMode };
    } catch (err) {
      liveLog('getSources failed', String((err as Error)?.stack ?? err));
      throw err;
    }
  });

  ipcMain.on(LIVE_IPC.liveStatus, (e, arg: unknown) => {
    if (!isLiveEngine(e.sender)) return;
    const parsed = liveStatusSchema.safeParse(arg);
    if (!parsed.success) return;
    const st = parsed.data;
    liveSeen = { state: st.state, at: Date.now() };
    if (st.state !== lastLoggedState || st.reason !== lastLoggedReason || (st.error && st.error !== lastLoggedError)) {
      liveLog('engine', st);
      lastLoggedState = st.state;
      lastLoggedReason = st.reason;
      lastLoggedError = st.error;
    }
    overlay?.update({ state: st.state, fps: st.fps });
    hud?.setSeeing(st.state === 'seeing');
  });

  // Запасной путь: если движок попросит getDisplayMedia — отдаём только окно Доты.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const from = request.frame ? webContents.fromFrame(request.frame) : null;
    liveLog('display-media request', { fromEngine: isLiveEngine(from) });
    if (!isLiveEngine(from)) return callback({});
    findDotaSource()
      .then(({ source }) => callback(source ? { video: source } : {}))
      .catch(() => callback({}));
  });
}

/** Настройки поменялись — пересчитать видимость и угол значка */
export function onLiveSettingsChanged(): void {
  overlay?.refresh();
  hud?.refresh();
}

/** Примеры подсказок поверх игры (кнопка «Показать поверх игры» в предпросмотре) */
export function showHudDemo(scene: SampleScene): void {
  hud?.demo(scene);
}

/** Подсказки движка → окно поверх игры (подключается на этапе 4) */
export function setHudHints(hints: HudHint[]): void {
  hud?.setHints(hints);
}

/** Движок упал или перезапускается — значок прячем до нового статуса */
export function onLiveEngineGone(): void {
  setLiveEngine(null);
  overlay?.hide();
  hud?.setSeeing(false);
}
