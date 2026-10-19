import { contextBridge, ipcRenderer } from 'electron';
import { ENGINE_PORT_MESSAGE, IPC, type DotaCoachApi } from '@shared/ipc';

// Интерфейс получает только эти функции — ни Node.js, ни произвольного IPC.
const api: DotaCoachApi = {
  showHudDemo: (scene) => ipcRenderer.invoke(IPC.hudDemo, scene),
  // Подсказки во время матча и «История советов» (этап 4)
  onCoachState: (fn) => {
    const listener = (_e: Electron.IpcRendererEvent, state: Parameters<typeof fn>[0]) => fn(state);
    ipcRenderer.on(IPC.coachState, listener);
    return () => ipcRenderer.removeListener(IPC.coachState, listener);
  },
  showMatchups: () => ipcRenderer.invoke(IPC.coachMatchups),
  draftSuggest: (req) => ipcRenderer.invoke(IPC.draftSuggest, req),
  draftLive: () => ipcRenderer.invoke(IPC.draftLive),
  listHistory: () => ipcRenderer.invoke(IPC.historyList),
  getHistory: (id) => ipcRenderer.invoke(IPC.historyGet, id),
  onHistoryChanged: (fn) => {
    const listener = () => fn();
    ipcRenderer.on(IPC.historyChanged, listener);
    return () => ipcRenderer.removeListener(IPC.historyChanged, listener);
  },
  badAdviceShortcutStatus: () => ipcRenderer.invoke(IPC.badAdviceShortcutStatus),
  getSettings: () => ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch) => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  getAppInfo: () => ipcRenderer.invoke(IPC.appInfo),
  pickReplayFolder: () => ipcRenderer.invoke(IPC.replayPickFolder),
  pickReplayVideo: () => ipcRenderer.invoke(IPC.replayPickVideo),
  getKnowledgeBase: () => ipcRenderer.invoke(IPC.kbGet),
  // Обновления из GitHub Releases
  getUpdateState: () => ipcRenderer.invoke(IPC.updateGet),
  checkForUpdates: () => ipcRenderer.invoke(IPC.updateCheck),
  installUpdate: () => ipcRenderer.invoke(IPC.updateInstall),
  onUpdateState: (fn) => {
    const listener = (_e: Electron.IpcRendererEvent, state: Parameters<typeof fn>[0]) => fn(state);
    ipcRenderer.on(IPC.updateState, listener);
    return () => ipcRenderer.removeListener(IPC.updateState, listener);
  },
  // Данные из игры (Valve GSI)
  getGsiState: () => ipcRenderer.invoke(IPC.gsiGet),
  connectGsi: () => ipcRenderer.invoke(IPC.gsiConnect),
  disconnectGsi: () => ipcRenderer.invoke(IPC.gsiDisconnect),
  pickDotaFolder: () => ipcRenderer.invoke(IPC.gsiPickDota),
  copyGsiLaunchOption: () => ipcRenderer.invoke(IPC.gsiCopyLaunchOption),
  onGsiState: (fn) => {
    const listener = (_e: Electron.IpcRendererEvent, state: Parameters<typeof fn>[0]) => fn(state);
    ipcRenderer.on(IPC.gsiState, listener);
    return () => ipcRenderer.removeListener(IPC.gsiState, listener);
  },
  // ИИ-помощник
  getAiState: () => ipcRenderer.invoke(IPC.aiGet),
  askAi: (payload) => ipcRenderer.invoke(IPC.aiAsk, payload),
  cancelAi: (requestId) => ipcRenderer.invoke(IPC.aiCancel, requestId),
  setAiKey: (key) => ipcRenderer.invoke(IPC.aiSetKey, { provider: 'openai-compatible', key }),
  clearAiKey: () => ipcRenderer.invoke(IPC.aiClearKey),
  sendAiFeedback: (f) => ipcRenderer.invoke(IPC.aiFeedback, f),
  downloadLocalAi: (model) => ipcRenderer.invoke(IPC.aiLocalDownload, model),
  cancelLocalAiDownload: () => ipcRenderer.invoke(IPC.aiLocalCancel),
  deleteLocalAi: () => ipcRenderer.invoke(IPC.aiLocalDelete),
  stopLocalAi: () => ipcRenderer.invoke(IPC.aiLocalStop),
  listGsiSessions: () => ipcRenderer.invoke(IPC.aiSessions),
  getGsiSessionMatch: (id) => ipcRenderer.invoke(IPC.aiSessionReadings, id),
  onAiChunk: (fn) => {
    const listener = (_e: Electron.IpcRendererEvent, msg: Parameters<typeof fn>[0]) => fn(msg);
    ipcRenderer.on(IPC.aiChunk, listener);
    return () => ipcRenderer.removeListener(IPC.aiChunk, listener);
  },
  onAiState: (fn) => {
    const listener = (_e: Electron.IpcRendererEvent, state: Parameters<typeof fn>[0]) => fn(state);
    ipcRenderer.on(IPC.aiState, listener);
    return () => ipcRenderer.removeListener(IPC.aiState, listener);
  },
};

contextBridge.exposeInMainWorld('dotacoach', api);

// Канал к движку (MessagePort) передаём в страницу через window.postMessage —
// это рекомендованный Electron способ при contextIsolation.
ipcRenderer.on('ui:engine-port', (event) => {
  window.postMessage(ENGINE_PORT_MESSAGE, '*', event.ports);
});
