// Живой захват окна Dota 2 (main-процесс).
// Всё, что относится к живому режиму, собрано здесь: поиск окна игры, разрешение
// захвата только для окна движка, приём статуса от движка и значок поверх игры.
// Доступ к игре только на чтение: снимок окна средствами Windows, без чтения памяти
// и без вмешательства в процесс dota2.exe.
import { app, BrowserWindow, desktopCapturer, ipcMain, screen, session, webContents } from "electron";
import { appendFileSync, statSync, renameSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const LIVE_IPC = {
  findDota: "engine:find-dota",
  liveStatus: "engine:live-status",
  overlayState: "overlay:state"
};

const LIVE_STATES = ["off", "waiting-dota", "no-image", "seeing"];
const DOTA_WINDOW_TITLE = /dota\s*2/i;
const OWN_WINDOW_TITLE = /dota ai coach/i;

// Журнал диагностики: <папка данных>/live.log (не больше ~256 КБ, старый — live.log.old)
const LOG_MAX = 256 * 1024;
let logFile = null;
export function liveLog(...parts) {
  try {
    logFile ??= join(app.getPath("userData"), "live.log");
    try {
      if (statSync(logFile).size > LOG_MAX) renameSync(logFile, `${logFile}.old`);
    } catch {
    }
    const line = parts.map((p) => typeof p === "string" ? p : JSON.stringify(p)).join(" ");
    appendFileSync(logFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${line}\n`, "utf8");
  } catch {
  }
}

let engineContentsId = null;

/** Вызывается при каждом (пере)создании окна движка */
export function setLiveEngine(contents) {
  engineContentsId = contents ? contents.id : null;
}

export function isLiveEngine(contents) {
  return !!contents && engineContentsId !== null && contents.id === engineContentsId;
}

/**
 * Разрешение для permission-обработчика: только видео (захват окна) и только окну движка.
 * Всё остальное по-прежнему запрещено.
 */
export function allowLivePermission(contents, permission, details) {
  if (permission !== "media" || !isLiveEngine(contents)) {
    if (isLiveEngine(contents)) liveLog("permission denied", permission);
    return false;
  }
  const types = details && Array.isArray(details.mediaTypes) ? details.mediaTypes : [];
  // Захват окна приходит как media без звука; mediaTypes может быть пустым или ["video"]
  const ok = types.every((t) => t === "video");
  liveLog("permission media", { mediaTypes: types, granted: ok });
  return ok;
}

let lastWindowsKey = null;
/** Ищет окно Доты; возвращает { source, windows } — windows: заголовки всех найденных окон (для диагностики) */
async function findDotaSource() {
  const sources = await desktopCapturer.getSources({
    types: ["window"],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  });
  const names = sources.map((s) => s.name.trim()).filter(Boolean);
  const candidates = sources.filter((s) => DOTA_WINDOW_TITLE.test(s.name) && !OWN_WINDOW_TITLE.test(s.name));
  // Сначала точное «Dota 2», потом любое окно с «Dota 2» в заголовке
  const source = candidates.find((s) => s.name.trim() === "Dota 2") ?? candidates[0] ?? null;
  const key = `${source?.name ?? "-"}|${names.join("|")}`;
  if (key !== lastWindowsKey) {
    lastWindowsKey = key;
    liveLog("windows", { found: source ? { id: source.id, name: source.name } : null, all: names.slice(0, 40) });
  }
  return { source, windows: names.slice(0, 30) };
}

const liveStatusSchema = z.object({
  state: z.enum(LIVE_STATES),
  fps: z.number().min(0).max(1000),
  reason: z.string().max(40).nullable().optional(),
  error: z.string().max(400).nullable().optional()
});

const OVERLAY_SIZE = { width: 172, height: 46 };
const OVERLAY_MARGIN = 12;

class Overlay {
  constructor(deps) {
    this.deps = deps;
  }
  deps;
  win = null;
  last = { state: "off", fps: 0 };

  update(status) {
    this.last = status;
    this.refresh();
  }

  refresh() {
    const live = this.deps.settings.get().live;
    const visible = live.overlay && (this.last.state === "seeing" || this.last.state === "no-image");
    if (!visible) {
      if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
      return;
    }
    const win = this.ensure();
    win.setBounds(this.bounds(live.overlayCorner));
    if (!win.isVisible()) win.showInactive();
    win.webContents.send(LIVE_IPC.overlayState, this.last);
  }

  hide() {
    this.last = { state: "off", fps: 0 };
    this.refresh();
  }

  bounds(corner) {
    const area = screen.getPrimaryDisplay().bounds;
    const left = corner.endsWith("left");
    const top = corner.startsWith("top");
    return {
      x: left ? area.x + OVERLAY_MARGIN : area.x + area.width - OVERLAY_SIZE.width - OVERLAY_MARGIN,
      y: top ? area.y + OVERLAY_MARGIN : area.y + area.height - OVERLAY_SIZE.height - OVERLAY_MARGIN,
      ...OVERLAY_SIZE
    };
  }

  ensure() {
    if (this.win && !this.win.isDestroyed()) return this.win;
    const win = new BrowserWindow({
      ...OVERLAY_SIZE,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      alwaysOnTop: true,
      title: "Dota AI Coach — индикатор",
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        spellcheck: false,
        preload: join(this.deps.preloadDir, "overlay.cjs")
      }
    });
    this.deps.harden(win.webContents);
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    win.setContentProtection(true);
    win.setVisibleOnAllWorkspaces(true);
    win.webContents.on("did-finish-load", () => win.webContents.send(LIVE_IPC.overlayState, this.last));
    const target = this.deps.pageUrl("overlay");
    if (target.url) void win.loadURL(target.url);
    else void win.loadFile(target.file);
    this.win = win;
    return win;
  }
}

let overlay = null;

/** Подключает живой режим. deps: { settings, preloadDir, pageUrl, harden } */
let lastLoggedState = null;
let lastLoggedReason = null;
let lastLoggedError = null;

export function setupLive(deps) {
  liveLog("setup", { app: app.getVersion(), electron: process.versions.electron, platform: process.platform });
  overlay = new Overlay(deps);

  ipcMain.handle(LIVE_IPC.findDota, async (e) => {
    if (!isLiveEngine(e.sender)) throw new Error("Untrusted IPC sender");
    try {
      const { source, windows } = await findDotaSource();
      return { source: source ? { id: source.id, name: source.name } : null, windows };
    } catch (err) {
      liveLog("getSources failed", String(err?.stack ?? err));
      throw err;
    }
  });

  ipcMain.on(LIVE_IPC.liveStatus, (e, arg) => {
    if (!isLiveEngine(e.sender)) return;
    const parsed = liveStatusSchema.safeParse(arg);
    if (!parsed.success) return;
    const st = parsed.data;
    if (st.state !== lastLoggedState || st.reason !== lastLoggedReason || st.error && st.error !== lastLoggedError) {
      liveLog("engine", st);
      lastLoggedState = st.state;
      lastLoggedReason = st.reason;
      lastLoggedError = st.error;
    }
    overlay?.update({ state: st.state, fps: st.fps });
  });

  // Запасной путь: если движок попросит getDisplayMedia — отдаём только окно Доты.
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const from = request.frame ? webContents.fromFrame(request.frame) : null;
    liveLog("display-media request", { fromEngine: isLiveEngine(from) });
    if (!isLiveEngine(from)) return callback({});
    findDotaSource().then(({ source }) => callback(source ? { video: source } : {})).catch(() => callback({}));
  });
}

/** Настройки поменялись — пересчитать видимость и угол значка */
export function onLiveSettingsChanged() {
  overlay?.refresh();
}

/** Движок упал или перезапускается — значок прячем до нового статуса */
export function onLiveEngineGone() {
  setLiveEngine(null);
  overlay?.hide();
}
