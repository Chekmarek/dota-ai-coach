// Данные из игры (Valve Game State Integration) в main-процессе: приёмник на 127.0.0.1, файл в папке Dota,
// запись сессий и IPC для интерфейса. Единственный канал от игры (docs/POLICY.md): Dota сама присылает данные.
import { BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { IPC, type GsiState } from '@shared/ipc';
import type { Settings } from '@shared/schemas/settings';
import type { SettingsStore } from '../settings/store';
import { liveLog } from '../live/live';
import { GsiServer } from './server';
import { GSI_LAUNCH_OPTION, cfgPath, cfgStatus, installCfg, locateDota, refreshCfg, removeCfg, steamPathFromRegistry, type DotaLocation } from './setup';
import { SessionRecorder } from './recorder';
import { SerialRestarter } from './restart';

/** Состояние в интерфейс — не чаще раза в секунду (плюс сразу при изменениях) */
const PUSH_MS = 1000;

interface Deps {
  settings: SettingsStore;
  dataDir: string;
  getUi: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  /** Передать проверенное тело в движок */
  forward: (body: Record<string, unknown>, wallMs: number) => void;
}

class GsiService {
  /** Приёмник перезапускается строго по одному: два изменения порта подряд не оставят второй слушающий сервер */
  private readonly servers = new SerialRestarter<GsiServer>(
    (port) =>
      new GsiServer({
        port,
        token: this.deps.settings.get().gsi.token,
        log: liveLog,
        onBody: (body, wallMs) => this.onBody(body, wallMs),
      }),
    (server) => server.start(),
  );
  private location: DotaLocation = { dotaDir: null, steamPath: null, how: 'not-found', libraries: [] };
  private steamPath: string | null = null;
  private recorder: SessionRecorder;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPushAt = 0;
  private port: number;
  /** Когда коуч сам переписал устаревший файл в папке Dota (Dota подхватит его после перезапуска); null — не переписывал */
  private refreshedAt: number | null = null;

  constructor(private readonly deps: Deps) {
    this.recorder = new SessionRecorder(join(deps.dataDir, 'gsi-sessions'), liveLog);
    // Секрет создаётся один раз и хранится в настройках
    if (deps.settings.get().gsi.token === '') {
      deps.settings.updateGsiInternal({ token: randomBytes(32).toString('hex') });
      liveLog('gsi секрет создан');
    }
    this.port = deps.settings.get().gsi.port;
  }

  async start(): Promise<void> {
    this.steamPath = await steamPathFromRegistry();
    this.relocate();
    this.refreshStale('при запуске');
    await this.startServer();
  }

  /**
   * Свой файл в папке Dota устарел (другой порт, секрет или формат) — переписываем его.
   * Файла нет — не создаём: подключение остаётся решением пользователя.
   */
  private refreshStale(why: string): void {
    const dir = this.location.dotaDir;
    if (!dir) return;
    const s = this.deps.settings.get().gsi;
    try {
      if (refreshCfg(dir, s.port, s.token) === 'rewritten') {
        this.refreshedAt = Date.now();
        liveLog(`gsi файл в папке Dota устарел и переписан (${why}); Dota подхватит его после перезапуска`, cfgPath(dir));
      }
    } catch (err) {
      liveLog('gsi не удалось обновить файл в папке Dota', String((err as Error)?.message ?? err));
    }
  }

  async stop(): Promise<void> {
    await this.servers.stop();
  }

  private relocate(): void {
    const s = this.deps.settings.get().gsi;
    this.location = locateDota(this.steamPath, s.dotaDir);
    liveLog('gsi папка dota', { dir: this.location.dotaDir, how: this.location.how, libraries: this.location.libraries.length });
  }

  private async startServer(): Promise<void> {
    // Порт запоминается сразу (до ожидания): следующее изменение настроек сравнивается уже с ним
    this.port = this.deps.settings.get().gsi.port;
    await this.servers.restart(this.port);
    this.push(true);
  }

  private onBody(body: Record<string, unknown>, wallMs: number): void {
    this.deps.forward(body, wallMs);
    if (this.deps.settings.get().gsi.record) this.recorder.record(body, wallMs);
    this.push(false);
  }

  /** Настройки поменялись: новый порт — перезапуск приёмника и обновление своего файла в папке Dota */
  async onSettingsChanged(next: Settings): Promise<void> {
    if (next.gsi.port !== this.port) {
      await this.startServer();
      this.refreshStale(`новый порт ${next.gsi.port}`);
    }
    this.push(true);
  }

  state(): GsiState {
    const s = this.deps.settings.get().gsi;
    const st = this.servers.server?.status;
    const dir = this.location.dotaDir;
    const cfg = dir ? cfgStatus(dir, s.port, s.token) : null;
    return {
      server: st?.state ?? 'off',
      port: s.port,
      error: st?.error ?? null,
      dota: {
        dir,
        how: this.location.how,
        cfgPath: cfg?.path ?? null,
        installed: cfg?.installed ?? false,
        current: cfg?.current ?? false,
        refreshedAt: cfg?.installed ? this.refreshedAt : null,
      },
      lastBodyAt: st?.lastBodyAt ?? null,
      accepted: st?.accepted ?? 0,
      rejected: st?.rejected ?? 0,
      recording: s.record,
      launchOption: GSI_LAUNCH_OPTION,
    };
  }

  connect(): GsiState {
    this.relocate();
    const dir = this.location.dotaDir;
    if (!dir) throw new Error('Папка Dota 2 не найдена. Укажите её вручную кнопкой «Указать папку Dota».');
    const s = this.deps.settings.get().gsi;
    const path = installCfg(dir, s.port, s.token);
    this.refreshedAt = null;
    liveLog('gsi подключено: записан файл', path);
    return this.pushNow();
  }

  disconnect(): GsiState {
    const dir = this.location.dotaDir;
    if (dir && removeCfg(dir)) liveLog('gsi отключено: удалён файл', cfgPath(dir));
    this.refreshedAt = null;
    return this.pushNow();
  }

  async pickDota(e: IpcMainInvokeEvent): Promise<GsiState> {
    const win = BrowserWindow.fromWebContents(e.sender);
    const opts: Electron.OpenDialogOptions = { title: 'Папка «dota 2 beta» (steamapps\\common\\dota 2 beta)', properties: ['openDirectory'] };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    const dir = res.filePaths[0];
    if (!res.canceled && dir) {
      this.deps.settings.updateGsiInternal({ dotaDir: dir });
      this.relocate();
      if (!this.location.dotaDir) throw new Error('Это не папка Dota 2');
      this.refreshStale('выбрана папка Dota');
    }
    return this.pushNow();
  }

  private pushNow(): GsiState {
    const st = this.state();
    this.lastPushAt = Date.now();
    const ui = this.deps.getUi();
    if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.gsiState, st);
    return st;
  }

  /** Состояние в интерфейс: сразу или не чаще раза в секунду */
  private push(now: boolean): void {
    if (now) {
      if (this.pushTimer) clearTimeout(this.pushTimer);
      this.pushTimer = null;
      this.pushNow();
      return;
    }
    if (this.pushTimer) return;
    const wait = Math.max(0, PUSH_MS - (Date.now() - this.lastPushAt));
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      this.pushNow();
    }, wait);
  }
}

/** Подключает приёмник GSI и IPC интерфейса */
export function setupGsi(deps: Deps): { onSettingsChanged: (s: Settings) => void; dispose: () => Promise<void> } {
  const svc = new GsiService(deps);
  const handle = <T>(channel: string, fn: (e: IpcMainInvokeEvent) => T | Promise<T>) =>
    ipcMain.handle(channel, (e) => {
      if (!deps.isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      return fn(e);
    });
  handle(IPC.gsiGet, () => svc.state());
  handle(IPC.gsiConnect, () => svc.connect());
  handle(IPC.gsiDisconnect, () => svc.disconnect());
  handle(IPC.gsiPickDota, (e) => svc.pickDota(e));
  // В буфер обмена — только фиксированная строка параметра запуска
  handle(IPC.gsiCopyLaunchOption, () => clipboard.writeText(GSI_LAUNCH_OPTION));
  void svc.start().catch((err) => liveLog('gsi запуск не удался', String(err)));
  return {
    onSettingsChanged: (s) => void svc.onSettingsChanged(s).catch((err) => liveLog('gsi настройки', String(err))),
    dispose: () => svc.stop(),
  };
}
