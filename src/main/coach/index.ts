// Подсказки во время матча (этап 4): IPC движка подсказок и «Истории советов».
// Снимки матча принимаются только от окна движка, вызовы интерфейса — только от окна интерфейса; всё проверяется zod.
import { app, globalShortcut, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, LIVE_IPC, type CoachStateMessage } from '@shared/ipc';
import { parseCoachInput } from '@shared/types/coach-input';
import { MODE_BANNER_MS, type HudHint, type ModeBanner } from '@shared/types/hud';
import type { AiProvider } from '@core/ai/provider.ts';
import type { SettingsStore } from '../settings/store';
import type { KbStore } from '../knowledge/kb-store';
import { isLiveEngine, liveLog, setHudHints, setHudModeBanner } from '../live/live';
import { CoachService } from './service';
import { HistoryStore } from './history';
import { DraftService } from './draft';
import { draftRequestSchema } from '@shared/types/draft';
import { BadAdviceStore, sessionIdOf } from './bad-advice-store';

/** Сколько на экране подтверждение «Отмечено: плохой совет» */
const BAD_ADVICE_ACK_MS = 2500;

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
  let lastUi: CoachStateMessage = { hints: [], inMatch: false, mode: null };
  let lastHints: { hints: HudHint[]; inMatch: boolean } = { hints: [], inMatch: false };
  let banner: { b: ModeBanner; at: number } | null = null;
  /** В интерфейс — подсказки и, пока он «свежий», индикатор режима */
  const sendUi = () => {
    const s = deps.settings.get();
    const mode = banner && Date.now() - banner.at < MODE_BANNER_MS ? banner.b : null;
    const msg: CoachStateMessage = { hints: s.hints.inApp ? lastHints.hints : [], inMatch: lastHints.inMatch, mode };
    if (JSON.stringify(msg) === JSON.stringify(lastUi)) return;
    lastUi = msg;
    const ui = deps.getUi();
    if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.coachState, msg);
  };
  const badAdvice = new BadAdviceStore(deps.dataDir, sessionIdOf(Date.now()));
  let ack: { until: number; seq: number; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** Номера карточек-подтверждений — вне номеров подсказок движка (окно поверх игры различает карточки по seq) */
  let ackSeq = 1e12;
  /** Окно поверх игры: подсказки движка и, пока свежее, подтверждение отметки */
  const pushHud = () => {
    const extra: HudHint[] =
      ack && Date.now() < ack.until
        ? [{ seq: ack.seq, zone: 'review', priority: 'info', category: 'review', title: 'Отмечено: плохой совет', text: 'Сохранено для разбора («История советов»)', percent: null, icon: null, source: 'template', ttlMs: BAD_ADVICE_ACK_MS, review: null }]
        : [];
    setHudHints([...lastHints.hints, ...extra], lastHints.inMatch);
  };
  const service = new CoachService({
    settings: deps.settings,
    kb: deps.kb,
    aiProvider: deps.aiProvider,
    history,
    badAdvice,
    appVersion: app.getVersion(),
    log: liveLog,
    onHints: (hints: HudHint[], inMatch: boolean) => {
      lastHints = { hints, inMatch };
      pushHud();
      sendUi();
    },
    onModeBanner: (b: ModeBanner) => {
      banner = { b, at: Date.now() };
      setHudModeBanner(b);
      sendUi();
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

  // Горячая клавиша «плохой совет»: глобальная (Electron), в игру ничего не вводится; вне матча ничего не пишет
  let boundKey = '';
  const onBadAdvice = () => {
    const r = service.markBadAdvice();
    if (!r) return;
    if (ack?.timer) clearTimeout(ack.timer);
    ack = { until: Date.now() + BAD_ADVICE_ACK_MS, seq: ++ackSeq, timer: setTimeout(() => ((ack = null), pushHud()), BAD_ADVICE_ACK_MS) };
    pushHud();
    const ui = deps.getUi();
    if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.historyChanged);
  };
  const bindKey = () => {
    const key = deps.settings.get().hints.badAdviceShortcut;
    if (key === boundKey) return;
    if (boundKey) globalShortcut.unregister(boundKey);
    boundKey = '';
    if (!key) return;
    try {
      if (globalShortcut.register(key, onBadAdvice)) boundKey = key;
      else liveLog('coach плохой совет: клавиша занята другой программой', key);
    } catch (err) {
      liveLog('coach плохой совет: клавиша не принята', key, String(err));
    }
  };
  bindKey();
  handle(IPC.badAdviceShortcutStatus, () => ({ key: deps.settings.get().hints.badAdviceShortcut, bound: boundKey !== '' && boundKey === deps.settings.get().hints.badAdviceShortcut }));

  return {
    onSettingsChanged: () => {
      service.onSettingsChanged();
      bindKey();
    },
    dispose: () => {
      if (boundKey) globalShortcut.unregister(boundKey);
      boundKey = '';
      service.flush();
    },
  };
}

