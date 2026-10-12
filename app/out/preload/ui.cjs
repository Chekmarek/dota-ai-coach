"use strict";
const electron = require("electron");
const IPC = {
  settingsGet: "settings:get",
  settingsUpdate: "settings:update",
  appInfo: "app:info",
  replayPickFolder: "replay:pick-folder",
  replayPickVideo: "replay:pick-video"
};
const ENGINE_PORT_MESSAGE = "dotacoach:engine-port";
const api = {
  getSettings: () => electron.ipcRenderer.invoke(IPC.settingsGet),
  updateSettings: (patch) => electron.ipcRenderer.invoke(IPC.settingsUpdate, patch),
  getAppInfo: () => electron.ipcRenderer.invoke(IPC.appInfo),
  pickReplayFolder: () => electron.ipcRenderer.invoke(IPC.replayPickFolder),
  pickReplayVideo: () => electron.ipcRenderer.invoke(IPC.replayPickVideo),
  // Обновления из GitHub Releases
  getUpdateState: () => electron.ipcRenderer.invoke("update:get"),
  checkForUpdates: () => electron.ipcRenderer.invoke("update:check"),
  installUpdate: () => electron.ipcRenderer.invoke("update:install"),
  onUpdateState: (fn) => {
    const listener = (_e, state) => fn(state);
    electron.ipcRenderer.on("update:state", listener);
    return () => electron.ipcRenderer.removeListener("update:state", listener);
  }
};
electron.contextBridge.exposeInMainWorld("dotacoach", api);
electron.ipcRenderer.on("ui:engine-port", (event) => {
  window.postMessage(ENGINE_PORT_MESSAGE, "*", event.ports);
});
