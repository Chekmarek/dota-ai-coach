import { useState } from 'react';
import type { ReplaySourceSpec } from '@shared/types/capture';
import { engine, useEngine } from '../hooks/useEngine';
import { useSettings } from '../hooks/useSettings';
import { Card, PageHeader, StatePill, Stat } from '../components/ui';
import { HudRecognition, RegionOverlay } from '../components/HudRecognition';
import { isLive } from '../components/live';
import { PreviewImage } from '../components/preview';
import { AskCoach, MatchSummary } from '../components/ask';
import { usePageFacts } from '../hooks/useFacts';
import { afterMatchFromState } from '@core/ai/after-match.ts';

// Выбранный источник живёт вне компонента, чтобы не теряться при переходе между страницами
let selected: ReplaySourceSpec | null = null;

export function ReplayMode() {
  const { status, preview, vision, match } = useEngine();
  const { settings } = useSettings();
  const getFacts = usePageFacts('replay');
  const [source, setSource] = useState<ReplaySourceSpec | null>(selected);
  const [error, setError] = useState<string | null>(null);

  const pick = async (kind: 'folder' | 'video') => {
    setError(null);
    try {
      const s = kind === 'folder' ? await window.dotacoach.pickReplayFolder() : await window.dotacoach.pickReplayVideo();
      if (s) {
        selected = s;
        setSource(s);
      }
    } catch (e) {
      setError(cleanIpcError(e));
    }
  };

  const start = async () => {
    if (!source) return;
    // Свежие настройки из main: их могли изменить в другом месте (например, перезапуском живого захвата)
    const current = await window.dotacoach.getSettings();
    const c = current.capture;
    engine.send({
      type: 'replay:start',
      options: {
        source,
        fps: c.targetFps,
        maxWidth: c.maxWidth,
        processingFpsCap: c.processingFpsCap,
        previewFps: c.previewFps,
        loop: current.replay.loop,
      },
    });
  };

  // Живой захват и запись используют один конвейер: пока работает живой захват, запись «простаивает»
  const liveOn = isLive(status);
  const state = liveOn ? 'idle' : (status?.state ?? 'idle');
  const active = state === 'running' || state === 'paused' || state === 'starting';
  const pos = status?.position;

  return (
    <>
      <PageHeader
        title="Разбор записи"
        subtitle="Тестовый режим: кадры берутся из папки с изображениями или из видеофайла. Игра и экран не используются."
      />
      <Card
        title="Источник"
        actions={
          <>
            <button onClick={() => void pick('folder')} disabled={active} data-testid="pick-folder">
              Папка с кадрами…
            </button>
            <button onClick={() => void pick('video')} disabled={active} data-testid="pick-video">
              Видеофайл…
            </button>
          </>
        }
      >
        <div className="row">
          <span className="muted">Выбрано:</span>
          <b data-testid="source-label">{source?.label ?? 'ничего'}</b>
        </div>
        {settings && (
          <div className="muted small">
            Частота {settings.capture.targetFps} к/с · ширина до {settings.capture.maxWidth} px · лимит обработки{' '}
            {settings.capture.processingFpsCap} к/с · повтор {settings.replay.loop ? 'вкл' : 'выкл'} (меняется в «Настройках»)
          </div>
        )}
        {error && <p className="error">{error}</p>}
        <div className="row gap">
          <button className="primary" onClick={() => void start()} disabled={!source || active} data-testid="replay-start">
            ▶ Запустить
          </button>
          {state === 'paused' ? (
            <button onClick={() => engine.send({ type: 'replay:resume' })}>Продолжить</button>
          ) : (
            <button onClick={() => engine.send({ type: 'replay:pause' })} disabled={state !== 'running'}>
              Пауза
            </button>
          )}
          <button onClick={() => engine.send({ type: 'replay:stop' })} disabled={!active} data-testid="replay-stop">
            ■ Стоп
          </button>
          <StatePill state={liveOn ? 'idle' : (status?.state ?? null)} />
        </div>
        {liveOn && <p className="muted small">Сейчас работает живой захват. Запуск записи его выключит.</p>}
      </Card>

      <div className="grid-preview">
        <Card title="Кадр">
          <div className="preview overlay-host">
            {preview && (active || state === 'ended') ? (
              <>
                <PreviewImage blob={preview.blob} label="Текущий кадр" testId="preview-img" />
                {settings?.ui.showRegions && vision && <RegionOverlay reading={vision.reading} />}
              </>
            ) : (
              <span className="muted">Нет кадра</span>
            )}
          </div>
          <div className="muted small">Превью уменьшено и обновляется не чаще {settings?.capture.previewFps ?? '—'} раз/с.</div>
        </Card>
        <Card title="Показатели">
          <div className="stats stats-col">
            <Stat label="Получено кадров" value={status?.framesReceived ?? 0} testId="frames-received" />
            <Stat label="Обработано" value={status?.framesProcessed ?? 0} />
            <Stat label="Отброшено лимитом" value={status?.framesDropped ?? 0} />
            <Stat label="Факт. частота" value={`${status?.measuredFps ?? 0} к/с`} testId="measured-fps" />
            <Stat
              label="Позиция"
              value={pos ? `${pos.index + 1}${pos.total ? ` / ${pos.total}` : ''}${pos.sourceTimeMs !== null ? ` · ${fmtTime(pos.sourceTimeMs)}` : ''}` : '—'}
            />
            <Stat label="Распознавание" value={status?.pipeline.visionMs != null ? `числа HUD · ${status.pipeline.visionMs} мс` : "числа HUD"} hint="Подробности — ниже, в «Распознанных значениях»" />
          </div>
          {status?.lastError && (
            <p className={status.lastError.fatal ? 'error' : 'warn'} data-testid="capture-error">
              {status.lastError.message}
            </p>
          )}
        </Card>
      </div>

      {/* Распознавание HUD (бывшая «Диагностика зрения»): для записей — здесь, для живой игры — в «Живой игре» */}
      {!liveOn && (active || state === 'ended') && <HudRecognition />}

      {!liveOn && (active || state === 'ended') && (
        <Card title="Спросить коуча о записи">
          <AskCoach page="replay" getFacts={getFacts} compact placeholder="Например: сколько золота было на 10:00? когда была смерть?" />
        </Card>
      )}
      {!liveOn && state === 'ended' && match && (
        <Card title="Разбор матча">
          <MatchSummary label="Факты из записи (то, что коуч увидел на кадрах)" lines={afterMatchFromState(match).lines} testId="replay-summary" />
        </Card>
      )}
    </>
  );
}

function fmtTime(ms: number): string {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Electron оборачивает ошибку из main в «Error invoking remote method…» — оставляем суть */
export function cleanIpcError(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e);
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}
