// Подсказки во время матча (этап 4): IPC движка подсказок и «Истории советов».
// Снимки матча принимаются только от окна движка, вызовы интерфейса — только от окна интерфейса; всё проверяется zod.
import { app, globalShortcut, ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { IPC, LIVE_IPC, type CoachStateMessage, type SoundPlayMessage } from '@shared/ipc';
import type { SoundToneId } from '@core/sound/cues.ts';
import { forUi } from '../ipc/register';
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
import { GateStore } from './gate-store';

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
  let ack: { until: number; seq: number; title: string; text: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** Короткое подтверждение поверх игры (отметка «плохой совет», «не нужно») */
  const showAck = (title: string, text: string) => {
    if (ack?.timer) clearTimeout(ack.timer);
    ack = { until: Date.now() + BAD_ADVICE_ACK_MS, seq: ++ackSeq, title, text, timer: setTimeout(() => ((ack = null), pushHud()), BAD_ADVICE_ACK_MS) };
    pushHud();
  };
  /** Номера карточек-подтверждений — вне номеров подсказок движка (окно поверх игры различает карточки по seq) */
  let ackSeq = 1e12;
  /** Окно поверх игры: подсказки движка и, пока свежее, подтверждение отметки */
  const pushHud = () => {
    const extra: HudHint[] =
      ack && Date.now() < ack.until
        ? [{ seq: ack.seq, zone: 'review', priority: 'info', category: 'review', title: ack.title, text: ack.text, percent: null, icon: null, source: 'template', ttlMs: BAD_ADVICE_ACK_MS, review: null }]
        : [];
    setHudHints([...lastHints.hints, ...extra], lastHints.inMatch);
  };
  /** Звук играет окно коуча (Web Audio); нет окна — тишина, остальное работает */
  const playTone = (tone: SoundToneId, atMs: number) => {
    const ui = deps.getUi();
    if (!ui || ui.isDestroyed()) return;
    const msg: SoundPlayMessage = { tone, volume: deps.settings.get().sound.volume, atMs };
    ui.webContents.send(IPC.soundPlay, msg);
  };
  const service = new CoachService({
    settings: deps.settings,
    kb: deps.kb,
    aiProvider: deps.aiProvider,
    history,
    badAdvice,
    gateStore: new GateStore(deps.dataDir),
    appVersion: app.getVersion(),
    log: liveLog,
    onHints: (hints: HudHint[], inMatch: boolean) => {
      lastHints = { hints, inMatch };
      pushHud();
      sendUi();
    },
    onSound: (cue, atMs) => playTone(cue, atMs),
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

  // Горячие клавиши — глобальные (Electron), в игру ничего не вводится; занятое сочетание — запись в журнал
  const bindShortcut = (bound: string, key: string, fn: () => void, what: string): string => {
    if (key === bound) return bound;
    if (bound) globalShortcut.unregister(bound);
    if (!key) return '';
    try {
      if (globalShortcut.register(key, fn)) return key;
      liveLog(`coach ${what}: клавиша занята другой программой`, key);
    } catch (err) {
      liveLog(`coach ${what}: клавиша не принята`, key, String(err));
    }
    return '';
  };

  // «Звук вкл/выкл»: переключить, подтвердить коротким звуком (и при выключении), сообщить интерфейсу
  let soundKey = '';
  const onSoundToggle = () => {
    const on = !deps.settings.get().sound.enabled;
    const next = deps.settings.update({ sound: { enabled: on } });
    liveLog('coach звук', { enabled: on, by: 'клавиша' });
    playTone(on ? 'toggle-on' : 'toggle-off', Date.now());
    const ui = deps.getUi();
    if (ui && !ui.isDestroyed()) ui.webContents.send(IPC.settingsChanged, forUi(next));
  };
  // Клавиша «плохой совет» занимается первой: при совпадении сочетаний звук не переключается
  const bindSoundKey = () => {
    const key = deps.settings.get().sound.shortcut;
    if (key && key === boundKey) {
      if (soundKey && soundKey !== boundKey) globalShortcut.unregister(soundKey);
      soundKey = '';
      return liveLog('coach звук вкл/выкл: то же сочетание, что у «плохой совет», — не занято', key);
    }
    soundKey = bindShortcut(soundKey, key, onSoundToggle, 'звук вкл/выкл');
  };
  handle(IPC.soundShortcutStatus, () => ({ key: deps.settings.get().sound.shortcut, bound: soundKey !== '' && soundKey === deps.settings.get().sound.shortcut }));

  // Горячая клавиша «плохой совет»: вне матча ничего не пишет
  let boundKey = '';
  const onBadAdvice = () => {
    const r = service.markBadAdvice();
    if (!r) return;
    showAck('Отмечено: плохой совет', 'Сохранено для разбора («История советов»)');
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
  // «Не нужно» (фильтр внимания): тип последней подсказки молчит до конца матча; сочетание, занятое другой клавишей
  // коуча, не занимается
  let muteKey = '';
  const onMute = () => {
    const r = service.muteLast();
    if (r) showAck(`Не нужно: ${r.short}`, r.demoted ? 'Больше не срочно — отключали в 3 матчах' : 'До конца матча не покажу');
  };
  const bindMuteKey = () => {
    const key = deps.settings.get().gate.muteShortcut;
    if (key && (key === boundKey || key === soundKey)) {
      if (muteKey) globalShortcut.unregister(muteKey);
      muteKey = '';
      return liveLog('coach не нужно: сочетание уже занято другой клавишей коуча — не занято', key);
    }
    muteKey = bindShortcut(muteKey, key, onMute, 'не нужно');
  };
  bindKey();
  bindSoundKey();
  bindMuteKey();
  handle(IPC.gateDebug, () => ({ debug: service.gateDebug(), shortcut: { key: deps.settings.get().gate.muteShortcut, bound: muteKey !== '' && muteKey === deps.settings.get().gate.muteShortcut } }));
  handle(IPC.badAdviceShortcutStatus, () => ({ key: deps.settings.get().hints.badAdviceShortcut, bound: boundKey !== '' && boundKey === deps.settings.get().hints.badAdviceShortcut }));

  return {
    onSettingsChanged: () => {
      service.onSettingsChanged();
      bindKey();
      bindSoundKey();
      bindMuteKey();
    },
    dispose: () => {
      if (muteKey) globalShortcut.unregister(muteKey);
      muteKey = '';
      if (boundKey) globalShortcut.unregister(boundKey);
      boundKey = '';
      if (soundKey) globalShortcut.unregister(soundKey);
      soundKey = '';
      service.flush();
    },
  };
}

