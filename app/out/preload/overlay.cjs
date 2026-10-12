"use strict";
const electron = require("electron");
electron.contextBridge.exposeInMainWorld("dotacoachOverlay", {
  onState: (fn) => {
    electron.ipcRenderer.on("overlay:state", (_e, state) => fn(state));
  }
});
