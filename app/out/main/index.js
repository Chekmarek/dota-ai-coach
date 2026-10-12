import { app, BrowserWindow, shell, protocol, ipcMain, dialog, MessageChannelMain } from "electron";
import { mkdirSync, readdirSync, existsSync, readFileSync, copyFileSync, writeFileSync, renameSync, statSync, createReadStream } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { z } from "zod";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import __cjs_mod__ from "node:module";
import { setupUpdater } from "./updater.js";
import { setupLive, setLiveEngine, allowLivePermission, onLiveSettingsChanged, onLiveEngineGone } from "./live.js";
const __filename = import.meta.filename;
const __dirname = import.meta.dirname;
const require2 = __cjs_mod__.createRequire(import.meta.url);
function resolveDataDir() {
  const override = process.env.DOTACOACH_DATA_DIR;
  const distribution2 = detectDistribution();
  let dataDir2;
  if (override) dataDir2 = override;
  else if (distribution2 === "portable") dataDir2 = join(dirname(app.getPath("exe")), "data");
  else dataDir2 = app.getPath("userData");
  mkdirSync(dataDir2, { recursive: true });
  return { dataDir: dataDir2, distribution: distribution2 };
}
function detectDistribution() {
  if (!app.isPackaged) return "dev";
  const exeDir = dirname(app.getPath("exe"));
  try {
    const hasUninstaller = readdirSync(exeDir).some((f) => /^Uninstall .*\.exe$/i.test(f));
    return hasUninstaller ? "installed" : "portable";
  } catch {
    return "installed";
  }
}
const preloadDir = join(__dirname, "../preload");
/** Репозиторий GitHub с релизами коуча — поле "updateRepo" в package.json */
function readUpdateRepo() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "../../package.json"), "utf8"));
    return typeof pkg.updateRepo === "string" && /^[\w.-]+\/[\w.-]+$/.test(pkg.updateRepo) ? pkg.updateRepo : null;
  } catch {
    return null;
  }
}
const rendererDir = join(__dirname, "../renderer");
function pageUrl(page) {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return { url: `${devServer}/${page}/index.html` };
  return { file: join(rendererDir, page, "index.html") };
}
function harden(contents) {
  contents.on("will-navigate", (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL;
    if (!(allowed && url.startsWith(allowed))) event.preventDefault();
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.session.setPermissionRequestHandler((wc, permission, callback, details) => callback(allowLivePermission(wc, permission, details)));
}
const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false
};
function createUiWindow() {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: "#0d1117",
    title: "Dota AI Coach",
    show: false,
    autoHideMenuBar: true,
    webPreferences: { ...secureWebPreferences, preload: join(preloadDir, "ui.cjs") }
  });
  harden(win.webContents);
  win.once("ready-to-show", () => win.show());
  const target = pageUrl("renderer");
  if (target.url) void win.loadURL(target.url);
  else void win.loadFile(target.file);
  return win;
}
function createEngineWindow() {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      ...secureWebPreferences,
      preload: join(preloadDir, "engine.cjs"),
      // Движок должен работать, даже когда окно скрыто
      backgroundThrottling: false
    }
  });
  harden(win.webContents);
  const target = pageUrl("engine");
  if (target.url) void win.loadURL(target.url);
  else void win.loadFile(target.file);
  return win;
}
const SETTINGS_SCHEMA_VERSION = 1;
const DEFAULTS = {
  capture: { targetFps: 2, maxWidth: 1920, processingFpsCap: 10, previewFps: 2 },
  replay: { loop: false },
  voice: { enabled: false, voiceId: null, rate: 1, volume: 0.8 },
  ui: { showRegions: true },
  live: { autoStart: true, fps: 10, overlay: true, overlayCorner: "top-right" }
};
const fields = {
  capture: {
    /** Сколько кадров в секунду брать из источника */
    targetFps: z.number().min(0.2).max(30),
    /** Максимальная ширина кадра после масштабирования (пиксели) */
    maxWidth: z.number().int().min(320).max(3840),
    /** Верхний предел частоты обработки — защита CPU */
    processingFpsCap: z.number().min(0.2).max(30),
    /** Частота превью-кадров для интерфейса */
    previewFps: z.number().min(0.2).max(10)
  },
  replay: {
    loop: z.boolean()
  },
  voice: {
    enabled: z.boolean(),
    voiceId: z.string().max(200).nullable(),
    rate: z.number().min(0.5).max(2),
    volume: z.number().min(0).max(1)
  },
  ui: {
    showRegions: z.boolean()
  },
  live: {
    /** Сам включать живой захват при запуске приложения */
    autoStart: z.boolean(),
    /** Сколько кадров в секунду брать с окна игры */
    fps: z.number().min(1).max(30),
    /** Показывать значок «Коуч» поверх игры */
    overlay: z.boolean(),
    overlayCorner: z.enum(["top-left", "top-right", "bottom-left", "bottom-right"])
  }
};
function tolerant(name) {
  const shape = Object.fromEntries(
    Object.entries(fields[name]).map(([k, s]) => [k, s.catch(DEFAULTS[name][k])])
  );
  return z.object(shape).catch(() => ({ ...DEFAULTS[name] }));
}
const settingsSchema = z.object({
  schemaVersion: z.literal(SETTINGS_SCHEMA_VERSION).catch(SETTINGS_SCHEMA_VERSION),
  capture: tolerant("capture"),
  replay: tolerant("replay"),
  voice: tolerant("voice"),
  ui: tolerant("ui"),
  live: tolerant("live")
});
function defaultSettings() {
  return settingsSchema.parse({});
}
const settingsPatchSchema = z.object({
  capture: z.object(fields.capture).partial().strict().optional(),
  replay: z.object(fields.replay).partial().strict().optional(),
  voice: z.object(fields.voice).partial().strict().optional(),
  ui: z.object(fields.ui).partial().strict().optional(),
  live: z.object(fields.live).partial().strict().optional()
}).strict();
function applySettingsPatch(current, patch) {
  return settingsSchema.parse({
    ...current,
    capture: { ...current.capture, ...patch.capture },
    replay: { ...current.replay, ...patch.replay },
    voice: { ...current.voice, ...patch.voice },
    ui: { ...current.ui, ...patch.ui },
    live: { ...current.live, ...patch.live }
  });
}
class SettingsStore {
  file;
  current;
  constructor(dataDir2) {
    this.file = join(dataDir2, "settings.json");
    this.current = this.load();
  }
  get() {
    return structuredClone(this.current);
  }
  update(patch) {
    this.current = applySettingsPatch(this.current, patch);
    this.save();
    return this.get();
  }
  load() {
    if (!existsSync(this.file)) return defaultSettings();
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8"));
      return settingsSchema.parse(raw);
    } catch {
      const stamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      try {
        copyFileSync(this.file, `${this.file}.corrupt-${stamp}`);
      } catch {
      }
      return defaultSettings();
    }
  }
  save() {
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.current, null, 2), "utf8");
    renameSync(tmp, this.file);
  }
}
const IPC = {
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  appInfo: "app:info",
  replayPickFolder: "replay:pick-folder",
  replayPickVideo: "replay:pick-video"
};
const POLICY = {
  replay: { allowed: true, reason: "Анализ заранее записанных кадров и видео." },
  "live-observe": {
    allowed: true,
    reason: "Живой захват окна Dota 2: только наблюдение, без подсказок во время матча."
  },
  "live-coach-unranked": {
    allowed: false,
    reason: "Подсказки во время матча выключены до проверки правил Valve (этап J)."
  },
  "live-coach-ranked": {
    allowed: false,
    reason: "Подсказки в рейтинговых матчах выключены до подтверждения допустимости (этап J)."
  }
};
function getPolicyState() {
  return {
    activeMode: "replay",
    modes: Object.keys(POLICY).map((mode) => ({ mode, ...POLICY[mode] }))
  };
}
const MEDIA_SCHEME = "dcmedia";
const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska"
};
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".bmp", ".webp"];
const VIDEO_EXTENSIONS = [".mp4", ".webm", ".mkv"];
const registry = /* @__PURE__ */ new Map();
const MAX_SOURCES = 8;
function registerMediaScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ]);
}
function registerSource(files) {
  const id = randomUUID().replace(/-/g, "");
  registry.set(id, files);
  while (registry.size > MAX_SOURCES) {
    const oldest = registry.keys().next().value;
    if (oldest === void 0) break;
    registry.delete(oldest);
  }
  return { id, urls: files.map((_, i) => `${MEDIA_SCHEME}://media/${id}/${i}`) };
}
function handleMediaProtocol() {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const [, id, indexStr] = url.pathname.split("/");
    const files = id ? registry.get(id) : void 0;
    const index = Number(indexStr);
    const file = files && Number.isInteger(index) ? files[index] : void 0;
    if (url.host !== "media" || !file) return new Response("Not found", { status: 404 });
    let size;
    try {
      size = statSync(file).size;
    } catch {
      return new Response("Gone", { status: 410 });
    }
    const headers = {
      "Content-Type": MIME[extname(file).toLowerCase()] ?? "application/octet-stream",
      "Accept-Ranges": "bytes",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-store"
    };
    const range = request.headers.get("range");
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && size > 0) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : size - 1;
      if (Number.isNaN(start)) {
        start = Math.max(0, size - end);
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${size}` } });
      }
      const stream2 = Readable.toWeb(createReadStream(file, { start, end }));
      return new Response(stream2, {
        status: 206,
        headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) }
      });
    }
    const stream = Readable.toWeb(createReadStream(file));
    return new Response(stream, { status: 200, headers: { ...headers, "Content-Length": String(size) } });
  });
}
const MAX_FRAMES = 1e5;
function openDialog(e, options) {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}
function registerIpc(deps) {
  const handle = (channel, fn) => {
    ipcMain.handle(channel, (e, arg) => {
      if (!deps.isTrustedSender(e)) throw new Error("Untrusted IPC sender");
      return fn(e, arg);
    });
  };
  handle(IPC.settingsGet, () => deps.settings.get());
  handle(IPC.settingsUpdate, (_e, arg) => {
    const patch = settingsPatchSchema.parse(arg);
    const next = deps.settings.update(patch);
    deps.onSettingsChanged?.(next);
    return next;
  });
  handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    dataDir: deps.dataDir,
    distribution: deps.distribution,
    policy: getPolicyState(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node
  }));
  handle(IPC.replayPickFolder, async (e) => {
    const res = await openDialog(e, {
      title: "Папка с кадрами (PNG/JPG)",
      properties: ["openDirectory"]
    });
    const dir = res.filePaths[0];
    if (res.canceled || !dir) return null;
    const files = readdirSync(dir).filter((f) => IMAGE_EXTENSIONS.includes(extname(f).toLowerCase())).sort((a, b) => a.localeCompare(b, void 0, { numeric: true })).slice(0, MAX_FRAMES).map((f) => join(dir, f)).filter((p) => statSync(p).isFile());
    if (files.length === 0) {
      throw new Error("В папке нет изображений PNG/JPG/BMP/WEBP");
    }
    const { id, urls } = registerSource(files);
    return { kind: "image-folder", id, label: `${basename(dir)} (${files.length} кадр.)`, frames: urls };
  });
  handle(IPC.replayPickVideo, async (e) => {
    const res = await openDialog(e, {
      title: "Видеозапись матча",
      properties: ["openFile"],
      filters: [{ name: "Видео", extensions: VIDEO_EXTENSIONS.map((x) => x.slice(1)) }]
    });
    const file = res.filePaths[0];
    if (res.canceled || !file) return null;
    if (!VIDEO_EXTENSIONS.includes(extname(file).toLowerCase())) throw new Error("Неподдерживаемый формат видео");
    const { id, urls } = registerSource([file]);
    return { kind: "video-file", id, label: basename(file), url: urls[0] };
  });
}
class EngineLink {
  constructor(ui) {
    this.ui = ui;
    ui.webContents.on("did-finish-load", () => {
      this.uiReady = true;
      this.connect();
    });
    ui.webContents.on("did-start-loading", () => {
      this.uiReady = false;
    });
  }
  ui;
  engine = null;
  engineReady = false;
  uiReady = false;
  restarts = 0;
  disposed = false;
  start() {
    this.spawn();
  }
  dispose() {
    this.disposed = true;
    if (this.engine && !this.engine.isDestroyed()) this.engine.destroy();
    this.engine = null;
  }
  spawn() {
    const win = createEngineWindow();
    this.engine = win;
    this.engineReady = false;
    setLiveEngine(win.webContents);
    win.webContents.on("did-finish-load", () => {
      this.engineReady = true;
      this.connect();
    });
    win.webContents.on("render-process-gone", (_e, details) => {
      console.error("[engine] процесс движка завершился:", details.reason);
      onLiveEngineGone();
      if (this.disposed) return;
      if (!win.isDestroyed()) win.destroy();
      if (this.restarts++ < 5) setTimeout(() => this.spawn(), 500);
    });
  }
  connect() {
    if (!this.engineReady || !this.uiReady || !this.engine || this.engine.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.engine.webContents.postMessage("engine:port", null, [port2]);
    this.ui.webContents.postMessage("ui:engine-port", null, [port1]);
  }
}
const { dataDir, distribution } = resolveDataDir();
app.setPath("userData", dataDir);
app.setAppUserModelId("app.dotacoach.desktop");
registerMediaScheme();
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let ui = null;
  let engine = null;
  app.on("second-instance", () => {
    if (!ui) return;
    if (ui.isMinimized()) ui.restore();
    ui.focus();
  });
  void app.whenReady().then(() => {
    handleMediaProtocol();
    const settings = new SettingsStore(dataDir);
    ui = createUiWindow();
    registerIpc({
      settings,
      dataDir,
      distribution,
      isTrustedSender: (e) => !!ui && !ui.isDestroyed() && e.sender.id === ui.webContents.id,
      onSettingsChanged: () => onLiveSettingsChanged()
    });
    setupLive({ settings, preloadDir, pageUrl, harden });
    setupUpdater({
      getUi: () => ui,
      isTrustedSender: (e) => !!ui && !ui.isDestroyed() && e.sender.id === ui.webContents.id,
      repo: readUpdateRepo()
    });
    engine = new EngineLink(ui);
    engine.start();
    ui.on("closed", () => {
      engine?.dispose();
      engine = null;
      ui = null;
      app.quit();
    });
  });
  app.on("window-all-closed", () => app.quit());
}
