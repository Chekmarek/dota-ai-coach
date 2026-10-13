import { contextBridge, ipcRenderer } from 'electron';
import { ENGINE_PORT_MESSAGE, IPC, type DotaCoachApi } from '@shared/ipc';

// Интерфейс получает только эти функции — ни Node.js, ни произвольного IPC.
const api: DotaCoachApi = {
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
};

contextBridge.exposeInMainWorld('dotacoach', api);

// Канал к движку (MessagePort) передаём в страницу через window.postMessage —
// это рекомендованный Electron способ при contextIsolation.
ipcRenderer.on('ui:engine-port', (event) => {
  window.postMessage(ENGINE_PORT_MESSAGE, '*', event.ports);
});
