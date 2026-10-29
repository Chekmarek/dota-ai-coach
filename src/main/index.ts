import { app, BrowserWindow, ipcMain } from 'electron';
import { IPC } from '@shared/ipc';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveDataDir } from './application/paths';
import { createUiWindow, harden, pageUrl, preloadDir } from './application/windows';
import { SettingsStore } from './settings/store';
import { KbStore } from './knowledge/kb-store';
import { StratzSync } from './knowledge/stratz-sync';
import { MetaService } from './knowledge/meta-sync';
import { z } from 'zod';
import { registerIpc } from './ipc/register';
import { EngineLink } from './lifecycle/engine-link';
import { handleMediaProtocol, registerMediaScheme } from './media/media-protocol';
import { liveLog, liveSeesDota, onLiveSettingsChanged, setupLive, showHudDemo } from './live/live';
import { setupAi } from './ai';
import { setupCoach, type CoachHandle } from './coach';
import { gsiPhase } from '@core/gsi/map.ts';
import { gameStage, type GameStage } from '@core/ai/draft-model.ts';
import { setupUpdater } from './live/updater';
import { setupGsi } from './gsi';
import { setupDevDataset } from './dev';

// Данные (настройки, кэш Chromium) — в одной папке: для портативной версии это ./data рядом с exe
const { dataDir, distribution } = resolveDataDir();
app.setPath('userData', dataDir);
app.setAppUserModelId('app.dotacoach.desktop');
registerMediaScheme();

// Необработанные ошибки main — в live.log (раньше пропадали бесследно). Отказ промиса только записываем;
// исключение — через Monitor: поведение Electron при падении не меняется, но причина остаётся в журнале
const errLine = (e: unknown) => (e instanceof Error ? `${e.name}: ${e.message}\n${e.stack ?? ''}` : String(e)).slice(0, 2000);
process.on('unhandledRejection', (reason) => liveLog('main: необработанный отказ промиса', errLine(reason)));
process.on('uncaughtExceptionMonitor', (err) => liveLog('main: необработанное исключение', errLine(err)));

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
  /** Когда GSI последний раз сообщил идущий матч (для ИИ: во время матча локальная модель отвечает коротко) */
  let gsiInMatchAt = 0;
  // Последняя стадия игры из GSI (выбор героев / матч) — для тяжёлой модели драфта (src/core/ai/draft-model.ts)
  let gsiStage: { stage: GameStage; at: number } | null = null;

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
    // Режим разработчика (DOTACOACH_DEV=1): набор кадров + GSI наблюдателя для проверки зрения
    const dataset = setupDevDataset(dataDir, () => settings.get());
    // Данные из игры (Valve GSI): приёмник на 127.0.0.1, тела — в движок
    const gsi = setupGsi({
      settings,
      dataDir,
      getUi: () => ui,
      isTrustedSender,
      forward: (body, wallMs) => {
        const map = body.map as { game_state?: unknown } | undefined;
        const gameState = typeof map?.game_state === 'string' ? map.game_state : null;
        if (gsiPhase(gameState) === 'in-progress') gsiInMatchAt = Date.now();
        if (gameState) gsiStage = { stage: gameStage(gameState), at: Date.now() };
        dataset.noteGsi(body, wallMs);
        engine?.sendGsi(body, wallMs);
      },
    });
    const kbCacheDir = join(dataDir, 'kb-cache');
    const kb = new KbStore({ cacheDir: kbCacheDir });
    let coach: CoachHandle | null = null;
    registerIpc({
      settings,
      kb,
      dataDir,
      distribution,
      isTrustedSender,
      onHudDemo: showHudDemo,
      onSettingsChanged: (next) => {
        onLiveSettingsChanged();
        coach?.onSettingsChanged();
        gsi.onSettingsChanged(next);
        engine?.setDatasetConfig(dataset.config(next));
      },
    });
    // Живой захват окна Dota 2 (только наблюдение) и проверка обновлений
    setupLive({ settings, preloadDir, pageUrl, harden });
    // DOTACOACH_NO_UPDATE_CHECK — для автотестов: не ходить в сеть
    setupUpdater({ getUi: () => ui, isTrustedSender, repo: process.env.DOTACOACH_NO_UPDATE_CHECK ? null : readUpdateRepo() });

    // ИИ-помощник: вопросы к локальной модели или облаку (с согласием), ключи — в safeStorage
    const ai = setupAi({
      settings,
      dataDir,
      getUi: () => ui,
      isTrustedSender,
      inMatch: () => liveSeesDota() || Date.now() - gsiInMatchAt < 10_000,
      stageInfo: () => ({ stage: gsiStage?.stage ?? null, at: gsiStage?.at ?? null, dotaOnScreen: liveSeesDota() }),
    });
    app.on('will-quit', () => ai.dispose());

    // Подсказки во время матча (этап 4): правила + ИИ → окно поверх игры, лента, «История советов»
    coach = setupCoach({ settings, kb, dataDir, aiProvider: () => ai.coachProvider(), getUi: () => ui, isTrustedSender });
    app.on('will-quit', () => coach?.dispose());

    // Данные STRATZ (как играют сильные игроки рейтинга): обновить кэш, если на ПК есть токен и кэш старше 3 дней.
    // Через 2 минуты после запуска и только вне матча; новые данные подхватятся при следующем запуске коуча
    if (!process.env.DOTACOACH_NO_UPDATE_CHECK) {
      const stratz = new StratzSync({
        cacheDir: kbCacheDir,
        patch: () => { const k = kb.get(); return 'error' in k ? null : k.meta.patch; },
        heroes: () => { const k = kb.get(); return 'error' in k ? [] : k.heroes.map((h) => ({ id: h.id, key: h.key })); },
        items: () => { const k = kb.get(); return 'error' in k ? [] : k.items.map((i) => ({ id: i.id, key: i.key })); },
        inMatch: () => liveSeesDota() || Date.now() - gsiInMatchAt < 60_000,
        log: (...a) => liveLog(...a),
      });
      setTimeout(() => void stratz.refreshIfStale().then((r) => liveLog('stratz', { result: r })), 120_000).unref();
    }

    // Мета патча на главной: OpenDota heroStats + описания патчей Valve; через 20 с после запуска и раз в 6 часов,
    // только вне матча. Без сети — кэш. DOTACOACH_NO_UPDATE_CHECK (автотесты) — в сеть не ходим, только кэш
    const meta = new MetaService({
      cacheDir: kbCacheDir,
      heroes: () => { const k = kb.get(); return 'error' in k ? [] : k.heroes; },
      ranked: () => kb.statsRanked(),
      inMatch: () => liveSeesDota() || Date.now() - gsiInMatchAt < 60_000,
      log: (...a) => liveLog(...a),
      onChange: () => { if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.metaChanged); },
    });
    const bracketArg = z.enum(['all', 'mid', 'high']);
    ipcMain.handle(IPC.metaGet, (e, arg: unknown) => {
      if (!isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      return meta.state(bracketArg.parse(arg));
    });
    ipcMain.handle(IPC.metaHero, (e, arg: unknown) => {
      if (!isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      const a = z.object({ hero: z.string().regex(/^[a-z0-9_]{2,40}$/), bracket: bracketArg }).parse(arg);
      return meta.heroChanges(a.hero, a.bracket);
    });
    ipcMain.handle(IPC.metaRefresh, (e) => {
      if (!isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      return process.env.DOTACOACH_NO_UPDATE_CHECK ? 'offline' : meta.refreshIfStale(true);
    });
    if (!process.env.DOTACOACH_NO_UPDATE_CHECK) {
      const tick = () => void meta.refreshIfStale().then((r) => r !== 'fresh' && liveLog('meta', { result: r }));
      setTimeout(tick, 20_000).unref();
      setInterval(tick, 30 * 60_000).unref();
    }

    engine = new EngineLink(ui);
    engine.setDatasetConfig(dataset.config(settings.get()));
    engine.start();

    ui.on('closed', () => {
      coach?.dispose();
      void gsi.dispose();
      ai.dispose();
      engine?.dispose();
      engine = null;
      ui = null;
      app.quit();
    });
  });

  app.on('window-all-closed', () => app.quit());
}
