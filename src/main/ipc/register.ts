import { app, BrowserWindow, dialog, ipcMain, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { readdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { IPC, type AppInfo } from '@shared/ipc';
import { settingsPatchSchema, type Settings } from '@shared/schemas/settings';
import type { ReplaySourceSpec } from '@shared/types/capture';
import type { SettingsStore } from '../settings/store';
import { getPolicyState } from '../policy/policy-gate';
import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, registerSource } from '../media/media-protocol';
import type { Distribution } from '../application/paths';
import type { KbStore } from '../knowledge/kb-store';

const MAX_FRAMES = 100_000;

function openDialog(e: IpcMainInvokeEvent, options: Electron.OpenDialogOptions) {
  const win = BrowserWindow.fromWebContents(e.sender);
  return win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options);
}

interface Deps {
  settings: SettingsStore;
  kb: KbStore;
  dataDir: string;
  distribution: Distribution;
  /** Принимаем вызовы только от этого окна */
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
  /** Примеры подсказок поверх игры (этап 3) */
  onHudDemo?: (scene: 'alive' | 'dead' | 'match') => void;
  /** Настройки изменились (живой режим пересчитывает значок поверх игры) */
  onSettingsChanged?: (settings: Settings) => void;
}

/** Секрет GSI интерфейсу не нужен — не отдаём его из main */
export function forUi(s: Settings): Settings {
  return { ...s, gsi: { ...s.gsi, token: '' } };
}

export function registerIpc(deps: Deps): void {
  const handle = <T>(channel: string, fn: (e: IpcMainInvokeEvent, arg: unknown) => T | Promise<T>) => {
    ipcMain.handle(channel, (e, arg: unknown) => {
      if (!deps.isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      return fn(e, arg);
    });
  };

  handle(IPC.settingsGet, () => forUi(deps.settings.get()));

  handle(IPC.hudDemo, (_e, arg) => {
    deps.onHudDemo?.(z.enum(['alive', 'dead', 'match']).parse(arg));
  });

  handle(IPC.kbGet, () => deps.kb.get());

  handle(IPC.settingsUpdate, (_e, arg) => {
    const patch = settingsPatchSchema.parse(arg);
    const next = deps.settings.update(patch);
    deps.onSettingsChanged?.(next);
    return forUi(next);
  });

  handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    dataDir: deps.dataDir,
    distribution: deps.distribution,
    policy: getPolicyState(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    dev: process.env.DOTACOACH_DEV === '1',
  }));

  handle(IPC.replayPickFolder, async (e): Promise<ReplaySourceSpec | null> => {
    const res = await openDialog(e, {
      title: 'Папка с кадрами (PNG/JPG)',
      properties: ['openDirectory'],
    });
    const dir = res.filePaths[0];
    if (res.canceled || !dir) return null;
    const files = readdirSync(dir)
      .filter((f) => IMAGE_EXTENSIONS.includes(extname(f).toLowerCase()))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .slice(0, MAX_FRAMES)
      .map((f) => join(dir, f))
      .filter((p) => statSync(p).isFile());
    if (files.length === 0) {
      throw new Error('В папке нет изображений PNG/JPG/BMP/WEBP');
    }
    const { id, urls } = registerSource(files);
    return { kind: 'image-folder', id, label: `${basename(dir)} (${files.length} кадр.)`, frames: urls };
  });

  handle(IPC.replayPickVideo, async (e): Promise<ReplaySourceSpec | null> => {
    const res = await openDialog(e, {
      title: 'Видеозапись матча',
      properties: ['openFile'],
      filters: [{ name: 'Видео', extensions: VIDEO_EXTENSIONS.map((x) => x.slice(1)) }],
    });
    const file = res.filePaths[0];
    if (res.canceled || !file) return null;
    if (!VIDEO_EXTENSIONS.includes(extname(file).toLowerCase())) throw new Error('Неподдерживаемый формат видео');
    const { id, urls } = registerSource([file]);
    return { kind: 'video-file', id, label: basename(file), url: urls[0]! };
  });
}
