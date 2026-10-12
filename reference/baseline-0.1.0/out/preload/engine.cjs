"use strict";
const electron = require("electron");
const ENGINE_PORT_MESSAGE = "dotacoach:engine-port";
electron.ipcRenderer.on("engine:port", (event) => {
  window.postMessage(ENGINE_PORT_MESSAGE, "*", event.ports);
});
