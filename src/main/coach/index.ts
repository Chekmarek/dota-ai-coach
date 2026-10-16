// Подсказки во время матча (этап 4): IPC движка подсказок и «Истории советов».
// Снимки матча принимаются только от окна движка, вызовы интерфейса — только от окна интерфейса; всё проверяется zod.
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, LIVE_IPC, type CoachStateMessage } from '@shared/ipc';
import { parseCoachInput } from '@shared/types/coach-input';
import type { HudHint } from '@shared/types/hud';
import type { AiProvider } from '@core/ai/provider.ts';
import type { SettingsStore } from '../settings/store';
import type { KbStore } from '../knowledge/kb-store';
import { isLiveEngine, liveLog, setHudHints } from '../live/live';
import { CoachService } from './service';
import { HistoryStore } from './history';
import { DraftService } from './draft';
import { draftRequestSchema } from '@shared/types/draft';

/** Снимок больше этого (символов JSON) — отбрасываем: защита от мусора */
const MAX_INPUT_CHARS = 1_000_000;

export interface CoachHandle {
  onSettingsChanged(): void;
  dispose(): void;
}

export function setupCoach(deps: {
  settings: SettingsStore;
  kb: KbStore;
  dataDir: string;
  aiProvider: () => AiProvider | null;
  getUi: () => BrowserWindow | null;
  isTrustedSender: (e: IpcMainInvokeEvent) => boolean;
}): CoachHandle {
  const history = new HistoryStore(deps.dataDir);
  let lastUi: CoachStateMessage = { hints: [], inMatch: false };
  const service = new CoachService({
    settings: deps.settings,
    kb: deps.kb,
    aiProvider: deps.aiProvider,
    history,
    log: liveLog,
    onHints: (hints: HudHint[], inMatch: boolean) => {
      setHudHints(hints, inMatch);
      const s = deps.settings.get();
      const msg: CoachStateMessage = { hints: s.hints.inApp ? hints : [], inMatch };
      if (JSON.stringify(msg) === JSON.stringify(lastUi)) return;
      lastUi = msg;
      const ui = deps.getUi();
      if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.coachState, msg);
    },
  });

  ipcMain.on(LIVE_IPC.coachInput, (e, arg: unknown) => {
    if (!isLiveEngine(e.sender)) return;
    try {
      if (JSON.stringify(arg).length > MAX_INPUT_CHARS) return;
      const input = parseCoachInput(arg);
      if (input) service.ingest(input);
    } catch (err) {
      liveLog('coach error', String((err as Error)?.stack ?? err).slice(0, 600));
    }
  });

  const handle = <T>(channel: string, fn: (arg: unknown) => T) =>
    ipcMain.handle(channel, (e, arg: unknown) => {
      if (!deps.isTrustedSender(e)) throw new Error('Untrusted IPC sender');
      return fn(arg);
    });
  handle(IPC.coachMatchups, () => service.showMatchups());
  const draftService = new DraftService(deps.kb);
  handle(IPC.draftSuggest, (arg) => draftService.suggest(draftRequestSchema.parse(arg)));
  handle(IPC.draftLive, () => service.liveHeroes());
  handle(IPC.historyList, () => history.list());
  handle(IPC.historyGet, (arg) => history.get(z.string().max(80).parse(arg)));

  return {
    onSettingsChanged: () => service.onSettingsChanged(),
    dispose: () => service.flush(),
  };
}

