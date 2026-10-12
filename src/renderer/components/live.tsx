// ===== Живой захват (из обновления 0.5.0) =====
import { useEffect } from 'react';
import type { Settings } from '@shared/schemas/settings';
import { LIVE_KIND, type CaptureStatus, type LiveInfo, type LiveReason, type LiveState } from '@shared/types/capture';
import { engine } from '../hooks/useEngine';

export const LIVE_LABEL: Record<LiveState, string> = {
  off: 'Коуч выключен',
  'waiting-dota': 'Ждёт Доту',
  'no-image': 'Нет картинки',
  seeing: 'Видит игру',
};

export const LIVE_HINT: Record<LiveReason, string> = {
  'not-found': 'Окно «Dota 2» не найдено: игра не запущена или свёрнута. Коуч подключится сам, как только окно появится.',
  'open-failed': 'Не удалось подключиться к окну Доты. Повторяю попытку каждые 3 секунды.',
  'no-frames': 'Кадры не приходят: не сворачивайте Доту.',
  dark: 'Картинка чёрная: включите в Доте режим «Оконный без рамки» (Настройки → Видео).',
  frozen: 'Картинка не меняется: Дота свёрнута или на паузе.',
};

export function isLive(status: CaptureStatus | null | undefined): status is CaptureStatus & { sourceKind: typeof LIVE_KIND } {
  return status?.sourceKind === LIVE_KIND;
}

export function LivePill({ live, big }: { live: LiveInfo | null | undefined; big?: boolean }) {
  const s = live?.state ?? 'off';
  return (
    <span className={`pill live-pill live-${s}${big ? ' big' : ''}`} data-testid="live-state" data-state={s}>
      {LIVE_LABEL[s]}
    </span>
  );
}

export function startLive(settings: Settings | null): void {
  if (!settings) return;
  const c = settings.capture;
  const l = settings.live;
  engine.send({
    type: 'live:start',
    options: { fps: l.fps, maxWidth: c.maxWidth, processingFpsCap: c.processingFpsCap, previewFps: Math.min(10, l.fps) },
  });
}

let autoStartedPort: MessagePort | null = null;
/** Автозапуск один раз на каждое подключение к движку (после ручного «Выключить» сам не включается) */
export function useLiveAutoStart(status: CaptureStatus | null, connected: boolean, settings: Settings | null): void {
  useEffect(() => {
    if (!connected || !status || !settings || !settings.live.autoStart) return;
    if (engine.statusPort !== engine.port || autoStartedPort === engine.port) return;
    autoStartedPort = engine.port;
    if (!status.sourceKind) startLive(settings);
  }, [status, connected, settings]);
}
