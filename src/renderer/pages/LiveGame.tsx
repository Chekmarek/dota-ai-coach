// «Живая игра» — из обновления 0.5.0. Карточка-заглушка «Распознавание HUD (этап C)» заменена
// настоящим распознаванием владельца (бывшая «Диагностика зрения»), рамки — по переключателю ui.showRegions.
import { useEngine } from '../hooks/useEngine';
import { useSettings } from '../hooks/useSettings';
import { Card, PageHeader, Stat } from '../components/ui';
import { HudRecognition, RegionOverlay } from '../components/HudRecognition';
import { LIVE_HINT, LivePill, isLive, startLive } from '../components/live';
import { HintsToggles } from '../components/hints';
import { engine } from '../hooks/useEngine';
import type { PageProps } from './types';

export function LiveGame({ onNavigate }: PageProps) {
  const { status, preview, vision } = useEngine();
  const { settings, update } = useSettings();
  const on = isLive(status);
  const live = on ? status.live : null;
  const s = live?.state ?? 'off';
  const hint = live?.reason ? LIVE_HINT[live.reason] : null;
  const showFrame = on && preview && (s === 'seeing' || s === 'no-image');
  // Полноэкранный режим Доты: Windows рисует игру поверх всех окон, значок там не виден (0.6.0)
  const exclusive = !!settings?.live.overlay && live?.videoMode === 'exclusive';

  return (
    <>
      <PageHeader title="Живая игра" subtitle="Коуч смотрит на окно Dota 2 в реальном времени. Подсказки во время матча появятся на следующих этапах; включить их заранее можно ниже." />
      {exclusive && (
        <div className="live-warning" role="alert" data-testid="live-exclusive-warning">
          <strong>Дота в полноэкранном режиме — значок не может быть поверх игры.</strong>
          <span> В Доте: Настройки → Видео → «Окно без рамок».</span>
        </div>
      )}
      <Card
        title="Статус"
        actions={
          <>
            <button className="primary" onClick={() => startLive(settings)} disabled={on || !settings} data-testid="live-start">
              ▶ Включить
            </button>
            <button onClick={() => engine.send({ type: 'live:stop' })} disabled={!on} data-testid="live-stop">
              ■ Выключить
            </button>
            <button onClick={() => onNavigate('settings')} title="Настройки живой игры" data-testid="live-settings">
              ⚙
            </button>
          </>
        }
      >
        <div className="row">
          <LivePill live={live} big />
          {live?.windowName && <span className="muted">Окно: {live.windowName}</span>}
        </div>
        {hint && (
          <p className={s === 'no-image' ? 'error' : 'warn'} data-testid="live-hint">
            {hint}
          </p>
        )}
        {live?.errorMessage && (
          <p className="error mono" data-testid="live-error">
            Ошибка: {live.errorMessage}
          </p>
        )}
        {s === 'waiting-dota' && (live?.seenWindows.length ?? 0) > 0 && (
          <details className="live-windows" data-testid="live-windows">
            <summary className="muted small">Окна, которые видит коуч ({live!.seenWindows.length})</summary>
            <ul className="mono">
              {live!.seenWindows.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </details>
        )}
        {!on && (
          <p className="muted small live-tip">
            Перед игрой включите в Доте режим «Оконный без рамки» (Настройки → Видео): в полноэкранном режиме Windows может отдавать чёрную
            картинку, а значок коуча не будет виден поверх игры.
          </p>
        )}
      </Card>

      {settings && (
        <Card title="Live-подсказки">
          <div className="form">
            <HintsToggles settings={settings} update={update} testIdPrefix="live-hints" />
          </div>
        </Card>
      )}

      <div className="grid-preview">
        <Card title="Что видит коуч">
          <div className="preview overlay-host">
            {showFrame ? (
              <>
                <img src={preview.url} alt="Кадр из Доты" data-testid="live-preview" />
                {settings?.ui.showRegions && vision && <RegionOverlay reading={vision.reading} />}
              </>
            ) : (
              <span className="muted">{on ? 'Ждём окно Dota 2…' : 'Живой захват выключен'}</span>
            )}
          </div>
          <div className="muted small">Превью уменьшено. Значок коуча поверх игры в кадр не попадает.</div>
        </Card>
        <Card title="Показатели">
          <div className="stats stats-col">
            <Stat label="Кадров с окна, к/с" value={live?.captureFps ?? 0} testId="live-capture-fps" hint="Сколько кадров отдаёт Windows" />
            <Stat label="Обработка, к/с" value={on ? status.processingFps : 0} />
            <Stat label="Задержка кадра" value={live?.latencyMs != null ? `${live.latencyMs} мс` : '—'} hint="Время от получения кадра до передачи в обработку" />
            <Stat label="Размер кадра" value={live?.width ? `${live.width}×${live.height}` : '—'} />
            <Stat label="Отброшено лимитом" value={on ? status.framesDropped : 0} />
            <Stat label="Кадров разобрано" value={on ? status.framesProcessed : 0} />
          </div>
        </Card>
      </div>

      {on && <HudRecognition />}
    </>
  );
}
