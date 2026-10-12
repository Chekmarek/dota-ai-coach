"use strict";
const electron = require("electron");
const ENGINE_PORT_MESSAGE = "dotacoach:engine-port";
electron.ipcRenderer.on("engine:port", (event) => {
  window.postMessage(ENGINE_PORT_MESSAGE, "*", event.ports);
});
// Живой захват: поиск окна Dota 2 и отчёт о статусе для значка поверх игры
electron.contextBridge.exposeInMainWorld("dotacoachEngine", {
  findDota: () => electron.ipcRenderer.invoke("engine:find-dota"),
  reportLive: (status) => electron.ipcRenderer.send("engine:live-status", status)
});
