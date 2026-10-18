// Окно подсказок поверх игры (этап 3, решение владельца 2026-10-16, docs/POLICY.md): прозрачное, без рамки,
// не берёт фокус, пропускает клики (setIgnoreMouseEvents), всегда сверху, исключено из захвата экрана.
// Занимает ровно окно Доты (window-rect.ts), а если его положение не узнать — экран, на котором Дота.
// Пока подсказок нет, окно спрятано: в простое оно ничего не рисует и процессор не тратит.
// Работает в режиме «полноэкранный в окне» / «окно»; в эксклюзивном полноэкранном Windows не даёт рисовать поверх
// игры — интерфейс сообщает об этом (videoMode = exclusive).
import { BrowserWindow, screen, type WebContents } from 'electron';
import { join } from 'node:path';
import { LIVE_IPC } from '@shared/ipc';
import { DEFAULT_HUD_OPTIONS, MODE_BANNER_MS, hudStateSchema, type HudHint, type HudOptions, type HudState, type ModeBanner } from '@shared/types/hud';
import type { Settings } from '@shared/schemas/settings';
import { sampleHints, type SampleScene } from '@shared/hud-samples';
import { WindowRectTracker, hwndFromSourceId, type WindowRect } from './window-rect';

const HUD_LEVEL = 'screen-saver' as const;
const ASSERT_MS = 1500;
/** Сколько ждать после последней подсказки, прежде чем спрятать окно (доигрывает анимация ухода) */
const HIDE_AFTER_MS = 600;
export const DEMO_MS = 12_000;


export interface HudDeps {
  settings: { get(): Settings };
  preloadDir: string;
  pageUrl: (page: 'hud') => { url?: string; file?: string };
  harden: (contents: WebContents) => void;
  log: (...parts: unknown[]) => void;
}

export function hudOptions(s: Settings): HudOptions {
  const h = s.hud;
  return { ...DEFAULT_HUD_OPTIONS, theme: h.theme, reduceMotion: h.reduceMotion, opacity: h.opacity, scale: h.scale, zones: h.zones, hiddenZones: h.hiddenZones };
}

/** Прямоугольник окна (физические пиксели) → координаты Electron (DIP) */
export function toDip(r: WindowRect): Electron.Rectangle {
  const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  return process.platform === 'win32' ? screen.screenToDipRect(null, rect) : rect;
}

export class HudOverlay {
  private win: BrowserWindow | null = null;
  private hints: HudHint[] = [];
  private demoHints: HudHint[] | null = null;
  private demoTimer: ReturnType<typeof setTimeout> | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  private assertTimer: ReturnType<typeof setInterval> | null = null;
  private seeing = false;
  private inMatch = false;
  private readonly tracker: WindowRectTracker;
  private lastBoundsKey = '';
  private modeBanner: ModeBanner | null = null;
  private modeTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: HudDeps) {
    this.tracker = new WindowRectTracker(() => this.refresh(), deps.log);
  }

  /** Окно Доты найдено (id источника desktopCapturer) */
  setDotaSource(sourceId: string | null): void {
    this.tracker.track(hwndFromSourceId(sourceId));
  }

  /** Живой захват видит Доту — без этого подсказки (кроме демо) не показываем */
  setSeeing(seeing: boolean): void {
    if (seeing === this.seeing) return;
    this.seeing = seeing;
    if (!seeing) this.tracker.stop();
    this.refresh();
  }

  /** Матч идёт по данным игры (GSI): подсказки показываем и без живого захвата — на экране, где Дота */
  setInMatch(inMatch: boolean): void {
    this.inMatch = inMatch;
  }

  /** Подсказки от движка (этап 4) */
  setHints(hints: HudHint[]): void {
    this.hints = hints;
    this.refresh();
  }

  /** Индикатор режима игры на MODE_BANNER_MS: показывается и без подсказок (окно появляется ради него) */
  setModeBanner(banner: ModeBanner): void {
    this.modeBanner = banner;
    if (this.modeTimer) clearTimeout(this.modeTimer);
    this.modeTimer = setTimeout(() => {
      this.modeTimer = null;
      this.modeBanner = null;
      this.refresh();
    }, MODE_BANNER_MS);
    this.modeTimer.unref?.();
    this.refresh();
  }

  /** Примеры подсказок поверх игры на DEMO_MS (кнопка в «Предпросмотре подсказок») */
  demo(scene: SampleScene): void {
    this.demoHints = sampleHints(scene, 'normal');
    if (this.demoTimer) clearTimeout(this.demoTimer);
    this.demoTimer = setTimeout(() => {
      this.demoHints = null;
      this.refresh();
    }, DEMO_MS);
    this.demoTimer.unref?.();
    this.refresh();
  }

  private state(): HudState {
    const live = this.demoHints === null && (this.seeing || this.inMatch);
    return hudStateSchema.parse({ hints: (this.demoHints ?? this.hints).slice(0, 12), options: hudOptions(this.deps.settings.get()), mode: live ? this.modeBanner : null });
  }

  /** Где рисовать: окно Доты или экран, где оно (или основной) */
  private bounds(): Electron.Rectangle {
    const r = this.tracker.rect;
    if (r && !r.minimized) return toDip(r);
    return screen.getPrimaryDisplay().bounds;
  }

  refresh(): void {
    const s = this.deps.settings.get();
    const list = this.demoHints ?? (this.seeing || this.inMatch ? this.hints : []);
    const banner = this.demoHints === null && (this.seeing || this.inMatch) && this.modeBanner !== null;
    const visible = s.hud.enabled && (list.length > 0 || banner) && !(this.tracker.rect?.minimized ?? false);
    if (!visible) {
      // отправляем пустой список (карточки и индикатор уходят анимацией), потом прячем окно
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) {
        this.win.webContents.send(LIVE_IPC.hudState, { ...this.state(), hints: [], mode: null });
        this.scheduleHide();
      }
      return;
    }
    this.cancelHide();
    const win = this.ensure();
    const b = this.bounds();
    const key = `${b.x},${b.y},${b.width},${b.height}`;
    if (key !== this.lastBoundsKey) {
      this.lastBoundsKey = key;
      win.setBounds(b);
      this.deps.log('hud bounds', { bounds: b, source: this.tracker.rect ? 'window' : 'display' });
    }
    if (!win.isVisible()) win.showInactive();
    win.webContents.send(LIVE_IPC.hudState, this.state());
    this.startAssert();
  }

  private scheduleHide(): void {
    if (this.hideTimer) return;
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null;
      this.win?.hide();
      this.stopAssert();
    }, HIDE_AFTER_MS);
  }

  private cancelHide(): void {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private startAssert(): void {
    if (this.assertTimer) return;
    // Windows поднимает игру при фокусе — периодически возвращаем окно наверх (фокус не берём)
    this.assertTimer = setInterval(() => {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.setAlwaysOnTop(true, HUD_LEVEL);
    }, ASSERT_MS);
  }

  private stopAssert(): void {
    if (this.assertTimer) clearInterval(this.assertTimer);
    this.assertTimer = null;
  }

  private ensure(): BrowserWindow {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const b = this.bounds();
    const win = new BrowserWindow({
      ...b,
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
      title: 'Dota AI Coach — подсказки',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        backgroundThrottling: false,
        preload: join(this.deps.preloadDir, 'hud.cjs'),
      },
    });
    this.deps.harden(win.webContents);
    win.setAlwaysOnTop(true, HUD_LEVEL);
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.setVisibleOnAllWorkspaces(true);
    win.webContents.on('did-finish-load', () => win.webContents.send(LIVE_IPC.hudState, this.state()));
    win.on('closed', () => {
      this.stopAssert();
      if (this.win === win) this.win = null;
      this.lastBoundsKey = '';
    });
    const target = this.deps.pageUrl('hud');
    if (target.url) void win.loadURL(target.url);
    else void win.loadFile(target.file!);
    this.win = win;
    this.lastBoundsKey = `${b.x},${b.y},${b.width},${b.height}`;
    return win;
  }

  dispose(): void {
    this.tracker.stop();
    this.stopAssert();
    this.cancelHide();
    if (this.demoTimer) clearTimeout(this.demoTimer);
    if (this.modeTimer) clearTimeout(this.modeTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

