// Обновление коуча из GitHub Releases.
// Релиз содержит app.asar и app.asar.sha256. Коуч скачивает файл, сверяет SHA-256,
// а подмену делает маленький cmd-скрипт уже после выхода из приложения (запущенный app.asar занят).
// В Program Files нужны права администратора — тогда скрипт запускается через elevate.exe (UAC).
import { app, BrowserWindow, ipcMain, net } from "electron";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { liveLog } from "./live.js";

export const UPDATE_IPC = {
  state: "update:state",
  get: "update:get",
  check: "update:check",
  install: "update:install"
};

const FIRST_CHECK_DELAY_MS = 5e3;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1e3;
const ELEVATION_WAIT_MS = 120e3;

export function compareVersions(a, b) {
  const pa = String(a).replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const pb = String(b).replace(/^v/, "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return Math.sign(d);
  }
  return 0;
}

class Updater {
  constructor(deps) {
    this.deps = deps;
    this.repo = deps.repo ?? null;
    this.state = { status: "idle", current: app.getVersion(), latest: null, progress: null, error: null, repo: this.repo };
  }
  deps;
  repo;
  state;
  release = null;
  file = null;

  set(patch) {
    this.state = { ...this.state, ...patch };
    const ui = this.deps.getUi();
    if (ui && !ui.isDestroyed()) ui.webContents.send(UPDATE_IPC.state, this.state);
  }

  async check() {
    if (!this.repo) return this.set({ status: "error", error: "Не указан репозиторий обновлений" });
    if (["downloading", "installing"].includes(this.state.status)) return;
    this.set({ status: "checking", error: null });
    try {
      const res = await net.fetch(`https://api.github.com/repos/${this.repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "DotaAICoach-Updater" }
      });
      if (res.status === 404) return this.set({ status: "up-to-date", latest: null });
      if (!res.ok) throw new Error(`GitHub ответил ${res.status}`);
      const rel = await res.json();
      const version = String(rel.tag_name ?? "").replace(/^v/, "");
      const asar = rel.assets?.find((a) => a.name === "app.asar");
      const sum = rel.assets?.find((a) => a.name === "app.asar.sha256");
      const latest = { version, notes: String(rel.body ?? "").slice(0, 4e3), publishedAt: rel.published_at ?? null, url: rel.html_url ?? null };
      if (!version || !asar || !sum) return this.set({ status: "up-to-date", latest });
      this.release = { version, asarUrl: asar.browser_download_url, asarSize: asar.size, sumUrl: sum.browser_download_url };
      const newer = compareVersions(version, this.state.current) > 0;
      this.set({ status: newer ? "available" : "up-to-date", latest });
      liveLog("update check", { current: this.state.current, latest: version, newer });
    } catch (err) {
      liveLog("update check failed", String(err?.message ?? err));
      this.set({ status: "error", error: `Не удалось проверить обновления: ${err?.message ?? err}` });
    }
  }

  async download() {
    const r = this.release;
    const dir = join(app.getPath("userData"), "updates");
    fs.mkdirSync(dir, { recursive: true });
    const target = join(dir, `app-${r.version}.asar.download`);
    const sumRes = await net.fetch(r.sumUrl, { headers: { "User-Agent": "DotaAICoach-Updater" } });
    if (!sumRes.ok) throw new Error(`контрольная сумма: HTTP ${sumRes.status}`);
    const expected = (await sumRes.text()).trim().slice(0, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error("неверный формат контрольной суммы");
    const res = await net.fetch(r.asarUrl, { headers: { "User-Agent": "DotaAICoach-Updater" } });
    if (!res.ok || !res.body) throw new Error(`загрузка: HTTP ${res.status}`);
    const total = Number(res.headers.get("content-length")) || r.asarSize || 0;
    const hash = createHash("sha256");
    const out = fs.createWriteStream(target);
    let got = 0;
    let lastSent = 0;
    const reader = res.body.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        hash.update(value);
        got += value.length;
        if (!out.write(Buffer.from(value))) await new Promise((ok) => out.once("drain", ok));
        const now = Date.now();
        if (total && now - lastSent > 200) {
          lastSent = now;
          this.set({ progress: Math.min(99, Math.round(got * 100 / total)) });
        }
      }
    } finally {
      await new Promise((ok) => out.end(ok));
    }
    const actual = hash.digest("hex");
    if (actual !== expected) {
      fs.rmSync(target, { force: true });
      throw new Error("файл повреждён (SHA-256 не совпал)");
    }
    this.set({ progress: 100 });
    return target;
  }

  /** Можно ли писать в папку resources без прав администратора */
  canWrite(dir) {
    const probe = join(dir, `.dc-write-test-${process.pid}`);
    try {
      fs.writeFileSync(probe, "1");
      fs.rmSync(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  async install() {
    if (this.state.status !== "available" || !this.release) return;
    if (process.platform !== "win32") return this.set({ status: "error", error: "Установка обновлений поддерживается только в Windows" });
    try {
      this.set({ status: "downloading", progress: 0, error: null });
      const file = await this.download();
      this.set({ status: "installing" });
      const resources = process.resourcesPath;
      const exe = process.execPath;
      const marker = join(tmpdir(), `dotacoach-update-${process.pid}.started`);
      const script = join(tmpdir(), `dotacoach-update-${process.pid}.cmd`);
      fs.rmSync(marker, { force: true });
      const lines = [
        "@echo off",
        `echo started> "${marker}"`,
        ":wait",
        `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
        "timeout /t 1 /nobreak >nul",
        `copy /Y "${resources}\\app.asar" "${resources}\\app.asar.prev" >nul`,
        "set N=0",
        ":copy",
        `copy /Y "${file}" "${resources}\\app.asar" >nul && goto done`,
        "set /a N+=1",
        "if %N% geq 10 goto fail",
        "timeout /t 1 /nobreak >nul",
        "goto copy",
        ":fail",
        `copy /Y "${resources}\\app.asar.prev" "${resources}\\app.asar" >nul`,
        ":done",
        // Перезапуск без прав администратора, даже если скрипт сам с ними
        `explorer.exe "${exe}"`,
        `del "%~f0"`
      ];
      fs.writeFileSync(script, lines.join("\r\n") + "\r\n", "utf8");
      const elevate = !this.canWrite(resources);
      liveLog("update install", { version: this.release.version, elevate, resources });
      let child;
      if (elevate) {
        const elevateExe = join(resources, "elevate.exe");
        child = fs.existsSync(elevateExe) ? spawn(elevateExe, ["cmd.exe", "/c", script], { detached: true, stdio: "ignore", windowsHide: true }) : spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", `Start-Process -FilePath cmd.exe -ArgumentList '/c', '"${script}"' -Verb RunAs -WindowStyle Hidden`], { detached: true, stdio: "ignore", windowsHide: true });
      } else {
        child = spawn("cmd.exe", ["/c", script], { detached: true, stdio: "ignore", windowsHide: true });
      }
      child.unref();
      // Ждём, пока скрипт реально стартует (пользователь мог отменить запрос UAC)
      const started = await new Promise((resolve) => {
        const deadline = Date.now() + ELEVATION_WAIT_MS;
        const timer = setInterval(() => {
          if (fs.existsSync(marker)) {
            clearInterval(timer);
            resolve(true);
          } else if (Date.now() > deadline) {
            clearInterval(timer);
            resolve(false);
          }
        }, 300);
        child.once("exit", (code) => {
          if (code && !fs.existsSync(marker)) setTimeout(() => {
            if (!fs.existsSync(marker)) {
              clearInterval(timer);
              resolve(false);
            }
          }, 1500);
        });
      });
      if (!started) {
        this.set({ status: "available", progress: null, error: "Установка отменена: нужны права администратора (подтвердите запрос Windows)" });
        return;
      }
      fs.rmSync(marker, { force: true });
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
      app.quit();
    } catch (err) {
      liveLog("update failed", String(err?.message ?? err));
      this.set({ status: "available", progress: null, error: `Обновление не установлено: ${err?.message ?? err}` });
    }
  }

  start() {
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    // Убираем скачанные файлы прошлых версий
    try {
      const dir = join(app.getPath("userData"), "updates");
      for (const f of fs.readdirSync(dir)) {
        const m = /^app-(.+)\.asar\.download$/.exec(f);
        if (m && compareVersions(m[1], this.state.current) <= 0) fs.rmSync(join(dir, f), { force: true });
      }
    } catch {
    }
  }
}

/** deps: { getUi, isTrustedSender, repo } */
export function setupUpdater(deps) {
  const updater = new Updater(deps);
  const handle = (channel, fn) => ipcMain.handle(channel, (e) => {
    if (!deps.isTrustedSender(e)) throw new Error("Untrusted IPC sender");
    return fn();
  });
  handle(UPDATE_IPC.get, () => updater.state);
  handle(UPDATE_IPC.check, async () => {
    await updater.check();
    return updater.state;
  });
  handle(UPDATE_IPC.install, async () => {
    await updater.install();
    return updater.state;
  });
  updater.start();
  return updater;
}
