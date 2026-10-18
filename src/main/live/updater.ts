// Обновление коуча из GitHub Releases (перенос out/main/updater.js из обновления 0.5.0).
// Релиз содержит app.asar и app.asar.sha256. Коуч скачивает файл, сверяет SHA-256,
// а подмену делает маленький cmd-скрипт уже после выхода из приложения (запущенный app.asar занят).
// В Program Files нужны права администратора — тогда скрипт запускается через elevate.exe (UAC).
import { app, BrowserWindow, ipcMain, net, type IpcMainInvokeEvent } from 'electron';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC, type ReleaseInfo, type UpdateState } from '@shared/ipc';
import { compareVersions } from '@shared/version';
import { liveLog } from './live';
import { streamToFile } from './stream-to-file';

const FIRST_CHECK_DELAY_MS = 5e3;
const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1e3;
const ELEVATION_WAIT_MS = 120e3;
const WAITING_UAC =
  'Windows ждёт подтверждения: нажмите «Да» в окне «Контроль учётных записей» (оно могло спрятаться за другими окнами — найдите его на панели задач). После этого коуч перезапустится сам.';

interface GithubAsset {
  name?: string;
  size?: number;
  browser_download_url?: string;
}

interface GithubRelease {
  tag_name?: string;
  body?: string;
  published_at?: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: GithubAsset[];
}

interface ReleaseFiles {
  version: string;
  asarUrl: string;
  asarSize: number;
  sumUrl: string;
}

export interface UpdaterDeps {
  getUi: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  repo: string | null;
}

const errText = (err: unknown): string => (err as Error)?.message ?? String(err);

/**
 * Куда перенаправляет адрес (без перехода по нему). net.fetch тут не годится: после перенаправления
 * res.url пустой, а redirect: 'manual' обрывает запрос ошибкой — поэтому net.request и событие 'redirect'.
 */
function redirectTarget(url: string, timeoutMs = 15e3): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({ url, method: 'HEAD', redirect: 'manual' });
    const timer = setTimeout(() => {
      req.abort();
      reject(new Error('GitHub не ответил'));
    }, timeoutMs);
    req.setHeader('User-Agent', 'DotaAICoach-Updater');
    req.on('redirect', (_status, _method, redirectUrl) => {
      clearTimeout(timer);
      resolve(redirectUrl);
      req.abort();
    });
    req.on('response', (res) => {
      clearTimeout(timer);
      reject(new Error(`GitHub ответил ${res.statusCode}`));
    });
    req.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

class Updater {
  private readonly repo: string | null;
  private release: ReleaseFiles | null = null;
  state: UpdateState;

  constructor(private readonly deps: UpdaterDeps) {
    this.repo = deps.repo ?? null;
    this.state = { status: 'idle', current: app.getVersion(), latest: null, history: [], checkedAt: null, progress: null, error: null, repo: this.repo };
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    const ui = this.deps.getUi();
    if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.updateState, this.state);
  }

  async check(): Promise<void> {
    if (!this.repo) return this.set({ status: 'error', error: 'Не указан репозиторий обновлений' });
    if (this.state.status === 'downloading' || this.state.status === 'installing') return;
    this.set({ status: 'checking', error: null });
    try {
      // Для проверки запасного пути: DOTACOACH_UPDATE_NO_API=1 — сразу без API
      if (process.env.DOTACOACH_UPDATE_NO_API === '1') return await this.checkWithoutApi();
      // Список последних релизов: из него берём и новую версию, и историю изменений для вкладки «Обновления»
      const res = await net.fetch(`https://api.github.com/repos/${this.repo}/releases?per_page=10`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'DotaAICoach-Updater' },
      });
      if (!res.ok) {
        // API без входа — 60 запросов в час на адрес; через общий VPN или прокси лимит часто съеден чужими
        // запросами (403). Тогда — обычные страницы github.com, у них такого лимита нет.
        liveLog('update check: API GitHub ответил', res.status, '— проверяю без API');
        return await this.checkWithoutApi();
      }
      const list = ((await res.json()) as GithubRelease[]).filter((r) => r && !r.draft && !r.prerelease);
      const history: ReleaseInfo[] = list
        .map((r) => ({
          version: String(r.tag_name ?? '').replace(/^v/, ''),
          notes: String(r.body ?? '').slice(0, 4e3),
          publishedAt: r.published_at ?? null,
          url: r.html_url ?? null,
        }))
        .filter((r) => r.version);
      const checkedAt = Date.now();
      const rel = list.find((r) => r.assets?.some((a) => a.name === 'app.asar') && r.assets?.some((a) => a.name === 'app.asar.sha256'));
      const asar = rel?.assets?.find((a) => a.name === 'app.asar');
      const sum = rel?.assets?.find((a) => a.name === 'app.asar.sha256');
      if (!rel || !asar?.browser_download_url || !sum?.browser_download_url) {
        this.release = null;
        return this.set({ status: 'up-to-date', latest: history[0] ?? null, history, checkedAt });
      }
      const version = String(rel.tag_name ?? '').replace(/^v/, '');
      const latest = history.find((h) => h.version === version) ?? null;
      this.release = { version, asarUrl: asar.browser_download_url, asarSize: asar.size ?? 0, sumUrl: sum.browser_download_url };
      const newer = compareVersions(version, this.state.current) > 0;
      this.set({ status: newer ? 'available' : 'up-to-date', latest, history, checkedAt });
      liveLog('update check', { current: this.state.current, latest: version, newer });
    } catch (err) {
      liveLog('update check failed', errText(err));
      this.set({ status: 'error', checkedAt: Date.now(), error: `Не удалось проверить обновления: ${errText(err)}` });
    }
  }

  /**
   * Проверка без API GitHub: github.com/<репо>/releases/latest перенаправляет на страницу последнего релиза
   * (…/releases/tag/v0.13.0) — из адреса берём версию; файлы — по прямым ссылкам releases/download,
   * заметки — docs/release-notes/v<версия>.md из исходников этого тега. История — только последний релиз.
   */
  private async checkWithoutApi(): Promise<void> {
    const headers = { 'User-Agent': 'DotaAICoach-Updater' };
    const pageUrl = await redirectTarget(`https://github.com/${this.repo}/releases/latest`);
    const tag = /\/releases\/tag\/([^/?#]+)$/.exec(pageUrl)?.[1];
    if (!tag) throw new Error('на GitHub нет релизов');
    const version = decodeURIComponent(tag).replace(/^v/, '');
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`непонятная версия релиза «${tag}»`);
    const base = `https://github.com/${this.repo}/releases/download/${tag}`;
    let notes = '';
    try {
      const n = await net.fetch(`https://raw.githubusercontent.com/${this.repo}/${tag}/docs/release-notes/${tag}.md`, { headers });
      if (n.ok) notes = (await n.text()).slice(0, 4e3);
    } catch {
      // без заметок обновление всё равно ставится
    }
    const latest: ReleaseInfo = { version, notes, publishedAt: null, url: pageUrl };
    // есть ли в релизе app.asar, узнаем при загрузке контрольной суммы — её нет, значит и установить нечего
    this.release = { version, asarUrl: `${base}/app.asar`, asarSize: 0, sumUrl: `${base}/app.asar.sha256` };
    const newer = compareVersions(version, this.state.current) > 0;
    this.set({ status: newer ? 'available' : 'up-to-date', latest, history: [latest], checkedAt: Date.now() });
    liveLog('update check (без API)', { current: this.state.current, latest: version, newer });
  }

  private async download(r: ReleaseFiles): Promise<string> {
    const dir = join(app.getPath('userData'), 'updates');
    fs.mkdirSync(dir, { recursive: true });
    const target = join(dir, `app-${r.version}.asar.download`);
    const sumRes = await net.fetch(r.sumUrl, { headers: { 'User-Agent': 'DotaAICoach-Updater' } });
    if (!sumRes.ok) throw new Error(`контрольная сумма: HTTP ${sumRes.status}`);
    const expected = (await sumRes.text()).trim().slice(0, 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('неверный формат контрольной суммы');
    const res = await net.fetch(r.asarUrl, { headers: { 'User-Agent': 'DotaAICoach-Updater' } });
    if (!res.ok || !res.body) throw new Error(`загрузка: HTTP ${res.status}`);
    const total = Number(res.headers.get('content-length')) || r.asarSize || 0;
    const hash = createHash('sha256');
    let got = 0;
    let lastSent = 0;
    // ошибка диска — понятный текст и статус «ошибка», а не вечное «Скачивается…» (stream-to-file.ts)
    await streamToFile(res.body, target, (value) => {
      hash.update(value);
      got += value.length;
      const now = Date.now();
      if (total && now - lastSent > 200) {
        lastSent = now;
        this.set({ progress: Math.min(99, Math.round((got * 100) / total)) });
      }
    });
    const actual = hash.digest('hex');
    if (actual !== expected) {
      fs.rmSync(target, { force: true });
      throw new Error('файл повреждён (SHA-256 не совпал)');
    }
    this.set({ progress: 100 });
    return target;
  }

  /** Можно ли писать в папку resources без прав администратора */
  private canWrite(dir: string): boolean {
    const probe = join(dir, `.dc-write-test-${process.pid}`);
    try {
      fs.writeFileSync(probe, '1');
      fs.rmSync(probe, { force: true });
      return true;
    } catch {
      return false;
    }
  }

  /** Запрос UAC показан и ещё не отвечен: второй запрос не создаём */
  private waitingElevation = false;

  async install(): Promise<void> {
    const release = this.release;
    if (this.waitingElevation) return this.set({ error: WAITING_UAC });
    if (this.state.status !== 'available' || !release) return;
    if (process.platform !== 'win32') return this.set({ status: 'error', error: 'Установка обновлений поддерживается только в Windows' });
    try {
      this.set({ status: 'downloading', progress: 0, error: null });
      const file = await this.download(release);
      this.set({ status: 'installing' });
      const resources = process.resourcesPath;
      const exe = process.execPath;
      const marker = join(tmpdir(), `dotacoach-update-${process.pid}.started`);
      const script = join(tmpdir(), `dotacoach-update-${process.pid}.cmd`);
      fs.rmSync(marker, { force: true });
      const lines = [
        '@echo off',
        `echo started> "${marker}"`,
        ':wait',
        `tasklist /FI "PID eq ${process.pid}" 2>nul | find "${process.pid}" >nul && (timeout /t 1 /nobreak >nul & goto wait)`,
        'timeout /t 1 /nobreak >nul',
        `copy /Y "${resources}\\app.asar" "${resources}\\app.asar.prev" >nul`,
        'set N=0',
        ':copy',
        `copy /Y "${file}" "${resources}\\app.asar" >nul && goto done`,
        'set /a N+=1',
        'if %N% geq 10 goto fail',
        'timeout /t 1 /nobreak >nul',
        'goto copy',
        ':fail',
        `copy /Y "${resources}\\app.asar.prev" "${resources}\\app.asar" >nul`,
        ':done',
        // Перезапуск без прав администратора, даже если скрипт сам с ними
        `explorer.exe "${exe}"`,
        'del "%~f0"',
      ];
      fs.writeFileSync(script, lines.join('\r\n') + '\r\n', 'utf8');
      const elevate = !this.canWrite(resources);
      liveLog('update install', { version: release.version, elevate, resources });
      let child: ChildProcess;
      if (elevate) {
        const elevateExe = join(resources, 'elevate.exe');
        child = fs.existsSync(elevateExe)
          ? spawn(elevateExe, ['cmd.exe', '/c', script], { detached: true, stdio: 'ignore', windowsHide: true })
          : spawn(
              'powershell.exe',
              ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `Start-Process -FilePath cmd.exe -ArgumentList '/c', '"${script}"' -Verb RunAs -WindowStyle Hidden`],
              { detached: true, stdio: 'ignore', windowsHide: true },
            );
      } else {
        child = spawn('cmd.exe', ['/c', script], { detached: true, stdio: 'ignore', windowsHide: true });
      }
      child.unref();
      // Ждём, пока скрипт реально стартует. Запрос UAC может долго висеть за другими окнами: после ELEVATION_WAIT_MS
      // не считаем установку отменённой, а подсказываем, где окно, и ждём дальше — до ответа «Да» или «Нет».
      let declined = false;
      child.once('exit', (code) => {
        if (code)
          setTimeout(() => {
            if (!fs.existsSync(marker)) declined = true;
          }, 1500);
      });
      const deadline = Date.now() + ELEVATION_WAIT_MS;
      for (;;) {
        if (fs.existsSync(marker)) break;
        if (declined) {
          this.waitingElevation = false;
          this.set({ status: 'available', progress: null, error: 'Установка отменена: нужны права администратора (подтверди запрос Windows)' });
          return;
        }
        if (Date.now() > deadline && !this.waitingElevation) {
          this.waitingElevation = true;
          liveLog('update ждёт подтверждения UAC');
          this.set({ status: 'available', progress: null, error: WAITING_UAC });
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      this.waitingElevation = false;
      fs.rmSync(marker, { force: true });
      for (const w of BrowserWindow.getAllWindows()) w.destroy();
      app.quit();
    } catch (err) {
      liveLog('update failed', errText(err));
      this.set({ status: 'available', progress: null, error: `Обновление не установлено: ${errText(err)}` });
    }
  }

  start(): void {
    setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
    setInterval(() => void this.check(), CHECK_INTERVAL_MS);
    // Убираем скачанные файлы прошлых версий
    try {
      const dir = join(app.getPath('userData'), 'updates');
      for (const f of fs.readdirSync(dir)) {
        const m = /^app-(.+)\.asar\.download$/.exec(f);
        if (m && compareVersions(m[1]!, this.state.current) <= 0) fs.rmSync(join(dir, f), { force: true });
      }
    } catch {
      // папки ещё нет — нечего чистить
    }
  }
}

export function setupUpdater(deps: UpdaterDeps): Updater {
  const updater = new Updater(deps);
  const handle = (channel: string, fn: () => unknown) =>
    ipcMain.handle(channel, (e) => {
      if (!deps.isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      return fn();
    });
  handle(IPC.updateGet, () => updater.state);
  handle(IPC.updateCheck, async () => {
    await updater.check();
    return updater.state;
  });
  handle(IPC.updateInstall, async () => {
    await updater.install();
    return updater.state;
  });
  updater.start();
  return updater;
}
