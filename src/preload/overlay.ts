import { contextBridge, ipcRenderer } from 'electron';

// Значок поверх игры получает только состояние живого режима и угол экрана. Строка канала — как в LIVE_IPC.overlayState.
const OVERLAY_STATE: (typeof import('@shared/ipc').LIVE_IPC)['overlayState'] = 'overlay:state';

contextBridge.exposeInMainWorld('dotacoachOverlay', {
  onState: (fn: (state: { state: string; fps: number; corner?: string }) => void) => {
    ipcRenderer.on(OVERLAY_STATE, (_e, state) => fn(state));
  },
});
