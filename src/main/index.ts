import { app, BrowserWindow } from 'electron';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from './application/paths';
import { createUiWindow, harden, pageUrl, preloadDir } from './application/windows';
import { SettingsStore } from './settings/store';
import { KbStore } from './knowledge/kb-store';
import { registerIpc } from './ipc/register';
import { EngineLink } from './lifecycle/engine-link';
import { handleMediaProtocol, registerMediaScheme } from './media/media-protocol';
import { onLiveSettingsChanged, setupLive } from './live/live';
import { setupUpdater } from './live/updater';

// Данные (настройки, кэш Chromium) — в одной папке: для портативной версии это ./data рядом с exe
const { dataDir, distribution } = resolveDataDir();
app.setPath('userData', dataDir);
app.setAppUserModelId('app.dotacoach.desktop');
registerMediaScheme();

/** Репозиторий GitHub с релизами коуча — поле "updateRepo" в package.json */
function readUpdateRepo(): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, '../../package.json'), 'utf8')) as { updateRepo?: unknown };
    return typeof pkg.updateRepo === 'string' && /^[\w.-]+\/[\w.-]+$/.test(pkg.updateRepo) ? pkg.updateRepo : null;
  } catch {
    return null;
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let ui: BrowserWindow | null = null;
  let engine: EngineLink | null = null;

  app.on('second-instance', () => {
    if (!ui) return;
    if (ui.isMinimized()) ui.restore();
    ui.focus();
  });

  void app.whenReady().then(() => {
    handleMediaProtocol();
    const settings = new SettingsStore(dataDir);
    const isTrustedSender = (e: Electron.IpcMainInvokeEvent) => !!ui && !ui.isDestroyed() && e.sender.id === ui.webContents.id;

    ui = createUiWindow();
    registerIpc({
      settings,
      kb: new KbStore(),
      dataDir,
      distribution,
      isTrustedSender,
      onSettingsChanged: () => onLiveSettingsChanged(),
    });
    // Живой захват окна Dota 2 (только наблюдение) и проверка обновлений
    setupLive({ settings, preloadDir, pageUrl, harden });
    // DOTACOACH_NO_UPDATE_CHECK — для автотестов: не ходить в сеть
    setupUpdater({ getUi: () => ui, isTrustedSender, repo: process.env.DOTACOACH_NO_UPDATE_CHECK ? null : readUpdateRepo() });

    engine = new EngineLink(ui);
    engine.start();

    ui.on('closed', () => {
      engine?.dispose();
      engine = null;
      ui = null;
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
