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
  pickReplayVideo: () => electron.ipcRenderer.invoke(IPC.replayPickVideo)
};
electron.contextBridge.exposeInMainWorld("dotacoach", api);
electron.ipcRenderer.on("ui:engine-port", (event) => {
  window.postMessage(ENGINE_PORT_MESSAGE, "*", event.ports);
});
