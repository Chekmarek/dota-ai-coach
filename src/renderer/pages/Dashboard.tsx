import { useAge, useEngine } from '../hooks/useEngine';
import { useAppInfo } from '../hooks/useSettings';
import { Card, NotImplemented, PageHeader, StatePill, Stat } from '../components/ui';
import type { PageProps } from './types';
import { formatHudValue } from '../components/HudRecognition';
import { LivePill, isLive } from '../components/live';
import { UpdateBanner } from './Updates';

const HUD_LABEL = { gameClock: 'Время', gold: 'Золото', health: 'Здоровье', mana: 'Мана', level: 'Уровень' } as const;

export function Dashboard({ onNavigate }: PageProps) {
  const { status, connected, vision } = useEngine();
  const info = useAppInfo();
  const age = useAge(status?.lastFrameAt ?? null);
  const stale = status?.state === 'running' && !isLive(status) && age !== null && age > 3;

  return (
    <>
      <PageHeader title="Обзор" subtitle="Состояние всех модулей. Доступны разбор записей и живой захват окна Dota 2 (только наблюдение)." />
      <UpdateBanner onOpen={() => onNavigate('updates')} />

      <div className="grid-2">
        <Card title="Захват кадров" actions={<button onClick={() => onNavigate('replay')}>Открыть запись</button>}>
          <div className="row">
            {isLive(status) ? <LivePill live={status.live} /> : <StatePill state={status?.state ?? null} />}
            {!connected && <span className="warn">Движок не подключён</span>}
            {stale && <span className="warn">Кадры не поступают {age!.toFixed(0)} с</span>}
          </div>
          <div className="stats">
            <Stat label="Источник" value={status?.sourceLabel ?? '—'} />
            <Stat label="Кадров/с" value={status?.measuredFps ?? 0} testId="dash-fps" />
            <Stat label="Обработка, к/с" value={status?.processingFps ?? 0} />
            <Stat label="Отброшено" value={status?.framesDropped ?? 0} hint="Кадры сверх лимита обработки" />
          </div>
          {status?.lastError && (
            <p className={status.lastError.fatal ? 'error' : 'warn'}>Последняя ошибка: {status.lastError.message}</p>
          )}
        </Card>

        <Card title="Режим работы">
          {info ? (
            <ul className="policy">
              {info.policy.modes.map((m) => (
                <li key={m.mode} className={m.allowed ? 'ok' : 'off'}>
                  <b>{MODE_LABEL[m.mode]}</b> — {m.allowed ? 'включён' : 'выключен'}
                  <div className="muted small">{m.reason}</div>
                </li>
              ))}
            </ul>
          ) : (
            '…'
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Последняя рекомендация">
          <NotImplemented stage="этап F">
            Модуль рекомендаций ещё не создан. Здесь будет совет, его причина, использованные факты и уверенность.
          </NotImplemented>
        </Card>
        <Card title="Распознавание" actions={<button onClick={() => onNavigate(isLive(status) ? 'live' : 'replay')}>Подробнее</button>}>
          {vision ? (
            <div className="stats">
              {(['gameClock', 'gold', 'health', 'mana', 'level'] as const).map((id) => {
                const o = vision.reading.fields[id];
                return (
                  <Stat
                    key={id}
                    label={HUD_LABEL[id]}
                    value={<span className={o.value === null ? 'muted' : undefined}>{formatHudValue(id, o.value)}</span>}
                    hint={`уверенность ${o.confidence.toFixed(2)}`}
                  />
                );
              })}
            </div>
          ) : (
            <span className="muted">Нет данных — запустите запись.</span>
          )}
          <div className="muted small">Распознаются числа HUD. Герой, предметы, способности и карта — ещё нет.</div>
        </Card>
      </div>
    </>
  );
}

const MODE_LABEL = {
  replay: 'Разбор записей',
  'live-observe': 'Живой захват (только диагностика)',
  'live-coach-unranked': 'Подсказки в обычных матчах',
  'live-coach-ranked': 'Подсказки в рейтинговых матчах',
} as const;
