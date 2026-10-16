import { contextBridge, ipcRenderer } from 'electron';

// Окно подсказок поверх игры получает только состояние подсказок. Строка канала — как в LIVE_IPC.hudState.
const HUD_STATE: (typeof import('@shared/ipc').LIVE_IPC)['hudState'] = 'hud:state';

contextBridge.exposeInMainWorld('dotacoachHud', {
  onState: (fn: (state: unknown) => void) => {
    ipcRenderer.on(HUD_STATE, (_e, state) => fn(state));
  },
});
