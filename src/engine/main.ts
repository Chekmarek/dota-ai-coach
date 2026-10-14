import { ENGINE_PORT_MESSAGE } from '@shared/ipc';
import { uiToEngineSchema, type EngineToUi } from '@shared/events/engine-protocol';
import { LIVE_KIND } from '@shared/types/capture';
import { Pipeline } from './pipeline';

let port: MessagePort | null = null;

function send(msg: EngineToUi, transfer: Transferable[] = []): void {
  port?.postMessage(msg, transfer);
}

const pipeline = new Pipeline(send);
// Данные из игры (GSI): main присылает проверенные тела запросов
window.dotacoachEngine?.onGsi((msg) => pipeline.ingestGsi(msg));
// Набор кадров для проверки зрения (только режим разработчика, решает main)
window.dotacoachEngine?.onDatasetConfig((cfg) => pipeline.setDatasetEveryN(cfg.everyN));

window.addEventListener('message', (event) => {
  if (event.source !== window || event.data !== ENGINE_PORT_MESSAGE || !event.ports[0]) return;
  port?.close();
  port = event.ports[0];
  port.onmessage = (e) => void handle(e.data);
  port.start();
  pipeline.setSender(send);
});

async function handle(raw: unknown): Promise<void> {
  const parsed = uiToEngineSchema.safeParse(raw);
  if (!parsed.success) {
    console.warn('[engine] отклонено некорректное сообщение', parsed.error.issues);
    return;
  }
  const msg = parsed.data;
  switch (msg.type) {
    case 'replay:start':
      await pipeline.start(msg.options);
      break;
    case 'replay:pause':
      pipeline.pause();
      break;
    case 'replay:resume':
      pipeline.resume();
      break;
    case 'replay:stop':
      await pipeline.stop('stopped');
      break;
    case 'live:start':
      await pipeline.start({
        source: { kind: LIVE_KIND, id: 'live', label: 'Dota 2 — живой захват' },
        fps: msg.options.fps,
        maxWidth: msg.options.maxWidth,
        processingFpsCap: msg.options.processingFpsCap,
        previewFps: msg.options.previewFps,
        loop: false,
      });
      break;
    case 'live:stop':
      if (pipeline.isLive()) await pipeline.stop('stopped');
      break;
    case 'ui:visibility':
      pipeline.uiVisible = msg.visible;
      break;
    case 'status:request':
      pipeline.publishStatus();
      break;
  }
}

window.addEventListener('beforeunload', () => pipeline.dispose());
