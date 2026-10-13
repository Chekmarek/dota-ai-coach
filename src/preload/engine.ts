import { contextBridge, ipcRenderer } from 'electron';
import type { DotaCoachEngineApi } from '@shared/ipc';

// Строки заданы здесь напрямую: sandbox-preload не может подгружать общие чанки сборки.
// Типы гарантируют, что они совпадают с константами из @shared/ipc.
const ENGINE_PORT_MESSAGE: typeof import('@shared/ipc').ENGINE_PORT_MESSAGE = 'dotacoach:engine-port';
const FIND_DOTA: (typeof import('@shared/ipc').LIVE_IPC)['findDota'] = 'engine:find-dota';
const LIVE_STATUS: (typeof import('@shared/ipc').LIVE_IPC)['liveStatus'] = 'engine:live-status';
const GSI_BODY: (typeof import('@shared/ipc').LIVE_IPC)['gsiBody'] = 'engine:gsi';

ipcRenderer.on('engine:port', (event) => {
  window.postMessage(ENGINE_PORT_MESSAGE, '*', event.ports);
});

// Живой захват: поиск окна Dota 2 и отчёт о статусе для значка поверх игры
const api: DotaCoachEngineApi = {
  findDota: () => ipcRenderer.invoke(FIND_DOTA),
  reportLive: (status) => ipcRenderer.send(LIVE_STATUS, status),
  // Тела GSI присылает только main (приёмник на 127.0.0.1)
  onGsi: (fn) => {
    ipcRenderer.on(GSI_BODY, (_e, msg) => fn(msg));
  },
};
contextBridge.exposeInMainWorld('dotacoachEngine', api);
