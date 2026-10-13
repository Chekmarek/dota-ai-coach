import { MessageChannelMain, type BrowserWindow } from 'electron';
import { LIVE_IPC, type GsiBodyMessage } from '@shared/ipc';
import { createEngineWindow } from '../application/windows';
import { onLiveEngineGone, setLiveEngine } from '../live/live';

/**
 * Управляет скрытым окном движка и прямым каналом «интерфейс ↔ движок».
 * Если движок падает — пересоздаём его и выдаём интерфейсу новый канал.
 */
export class EngineLink {
  private engine: BrowserWindow | null = null;
  private engineReady = false;
  private uiReady = false;
  private restarts = 0;
  private disposed = false;

  constructor(private readonly ui: BrowserWindow) {
    ui.webContents.on('did-finish-load', () => {
      this.uiReady = true;
      this.connect();
    });
    ui.webContents.on('did-start-loading', () => {
      this.uiReady = false;
    });
  }

  start(): void {
    this.spawn();
  }

  /** Тело GSI — в движок (если движок готов; иначе пропускаем: следующее придёт через 0.1–30 с) */
  sendGsi(body: Record<string, unknown>, wallMs: number): void {
    if (!this.engineReady || !this.engine || this.engine.isDestroyed()) return;
    const msg: GsiBodyMessage = { body, wallMs };
    this.engine.webContents.send(LIVE_IPC.gsiBody, msg);
  }

  dispose(): void {
    this.disposed = true;
    if (this.engine && !this.engine.isDestroyed()) this.engine.destroy();
    this.engine = null;
  }

  private spawn(): void {
    const win = createEngineWindow();
    this.engine = win;
    this.engineReady = false;
    // Только этому окну разрешён захват окна Доты и IPC живого режима
    setLiveEngine(win.webContents);
    win.webContents.on('did-finish-load', () => {
      this.engineReady = true;
      this.connect();
    });
    win.webContents.on('render-process-gone', (_e, details) => {
      console.error('[engine] процесс движка завершился:', details.reason);
      onLiveEngineGone();
      if (this.disposed) return;
      if (!win.isDestroyed()) win.destroy();
      if (this.restarts++ < 5) setTimeout(() => this.spawn(), 500);
    });
  }

  private connect(): void {
    if (!this.engineReady || !this.uiReady || !this.engine || this.engine.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.engine.webContents.postMessage('engine:port', null, [port2]);
    this.ui.webContents.postMessage('ui:engine-port', null, [port1]);
  }
}
