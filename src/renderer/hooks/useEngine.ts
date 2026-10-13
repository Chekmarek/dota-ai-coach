import { useEffect, useState, useSyncExternalStore } from 'react';
import { ENGINE_PORT_MESSAGE } from '@shared/ipc';
import type { EngineToUi, UiToEngine, VisionMessage } from '@shared/events/engine-protocol';
import type { CaptureStatus } from '@shared/types/capture';
import type { MatchState } from '@core/match-state/index.ts';
import type { AgreementReport } from '@core/gsi/agreement.ts';

export interface PreviewFrame {
  url: string;
  width: number;
  height: number;
  frameIndex: number;
  sourceTimeMs: number | null;
}

/**
 * Одно соединение с движком на всё приложение (вне React — переживает смену страниц).
 * Если движок перезапустился, main присылает новый порт — просто подменяем его.
 */
class EngineClient {
  port: MessagePort | null = null;
  /** Порт, от которого пришёл последний статус (автозапуск живого режима — один раз на подключение) */
  statusPort: MessagePort | null = null;
  private listeners = new Set<() => void>();
  status: CaptureStatus | null = null;
  preview: PreviewFrame | null = null;
  vision: VisionMessage | null = null;
  /** Когда пришёл последний результат распознавания (Date.now) */
  visionAt: number | null = null;
  /** Последнее состояние матча от движка (этап D) */
  match: MatchState | null = null;
  /** Сверка зрения с GSI */
  agreement: AgreementReport = {};
  connected = false;

  constructor() {
    window.addEventListener('message', (e) => {
      if (e.source !== window || e.data !== ENGINE_PORT_MESSAGE || !e.ports[0]) return;
      this.port?.close();
      this.port = e.ports[0];
      this.port.onmessage = (m) => this.onMessage(m.data as EngineToUi);
      this.port.start();
      this.connected = true;
      this.send({ type: 'status:request' });
      this.sendVisibility();
      this.emit();
    });
    // Окно свёрнуто/скрыто — движок не кодирует превью (обработка кадров продолжается)
    document.addEventListener('visibilitychange', () => this.sendVisibility());
  }

  sendVisibility(): void {
    this.send({ type: 'ui:visibility', visible: document.visibilityState !== 'hidden' });
  }

  send(msg: UiToEngine): void {
    this.port?.postMessage(msg);
  }

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private onMessage(msg: EngineToUi): void {
    if (msg.type === 'status') {
      this.status = msg.status;
      this.statusPort = this.port;
      // Новый запуск — старое превью больше не относится к источнику
      if (msg.status.state === 'starting' && this.preview) {
        URL.revokeObjectURL(this.preview.url);
        this.preview = null;
      }
      if (msg.status.state === 'starting') this.vision = null;
    } else if (msg.type === 'vision') {
      this.vision = msg;
      this.visionAt = Date.now();
    } else if (msg.type === 'match') {
      this.match = msg.state;
      this.agreement = msg.agreement;
    } else if (msg.type === 'preview') {
      const url = URL.createObjectURL(new Blob([msg.jpeg], { type: 'image/jpeg' }));
      if (this.preview) URL.revokeObjectURL(this.preview.url);
      this.preview = { url, width: msg.width, height: msg.height, frameIndex: msg.frameIndex, sourceTimeMs: msg.sourceTimeMs };
    }
    this.emit();
  }

  private version = 0;
  getVersion = (): number => this.version;

  private emit(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

export const engine = new EngineClient();

export function useEngine(): {
  status: CaptureStatus | null;
  preview: PreviewFrame | null;
  vision: VisionMessage | null;
  visionAt: number | null;
  match: MatchState | null;
  agreement: AgreementReport;
  connected: boolean;
} {
  useSyncExternalStore(engine.subscribe, engine.getVersion);
  return {
    status: engine.status,
    preview: engine.preview,
    vision: engine.vision,
    visionAt: engine.visionAt,
    match: engine.match,
    agreement: engine.agreement,
    connected: engine.connected,
  };
}

/** Секунды с момента события — для пометки устаревших данных */
export function useAge(timestamp: number | null): number | null {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return timestamp === null ? null : Math.max(0, (now - timestamp) / 1000);
}