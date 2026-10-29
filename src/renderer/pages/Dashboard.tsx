// «Обзор» — стартовый экран: готов ли коуч к матчу (три шага с причиной и следующим действием), что он говорит
// сейчас и что распознал. Только настоящие состояния — без выдуманных данных.
import type { ReactNode } from 'react';
import { useAge, useEngine } from '../hooks/useEngine';
import { useAppInfo, useSettings } from '../hooks/useSettings';
import { useGsi } from '../hooks/useGsi';
import { Card, PageHeader, StatePill, Stat } from '../components/ui';
import type { PageProps } from './types';
import { formatHudValue } from '../components/HudRecognition';
import { LIVE_HINT, LIVE_LABEL, LivePill, isLive, startLive } from '../components/live';
import { GameModeBadge, gsiStatus, useTick } from '../components/gsi';
import { HintsFeed } from '../components/hints';
import { Icon, type IconName } from '../components/icons';
import { UpdateBanner } from './Updates';
import { MetaCard } from '../components/meta';

const HUD_LABEL = { gameClock: 'Время', gold: 'Золото', health: 'Здоровье', mana: 'Мана', level: 'Уровень' } as const;

type StepTone = 'ok' | 'wait' | 'bad' | 'off';
const TONE_RU: Record<StepTone, string> = { ok: 'Готово', wait: 'Ждём', bad: 'Проблема', off: 'Выключено' };

function Step({ n, icon, title, tone, status, children, action }: { n: number; icon: IconName; title: string; tone: StepTone; status: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <section className={`step step-${tone}`} data-testid={`ready-step-${n}`} data-tone={tone}>
      <header className="step-head">
        <span className="step-icon" aria-hidden>
          <Icon name={icon} size={18} />
        </span>
        <h3>{title}</h3>
        <span className={`step-tone tone-${tone}`}>
          <i aria-hidden />
          {TONE_RU[tone]}
        </span>
      </header>
      <p className="step-status">{status}</p>
      {children && <div className="step-help muted small">{children}</div>}
      {action && <div className="step-action">{action}</div>}
    </section>
  );
}

export function Dashboard({ onNavigate }: PageProps) {
  const { status, connected, vision } = useEngine();
  const { settings, update } = useSettings();
  const info = useAppInfo();
  const gsi = useGsi();
  const now = useTick();
  const age = useAge(status?.lastFrameAt ?? null);
  const stale = status?.state === 'running' && !isLive(status) && age !== null && age > 3;

  // 1. Окно Доты (живой захват)
  const live = isLive(status) ? status.live : null;
  const liveState = live?.state ?? 'off';
  const liveTone: StepTone = liveState === 'seeing' ? 'ok' : liveState === 'waiting-dota' ? 'wait' : liveState === 'no-image' ? 'bad' : 'off';
  const liveHelp = !connected ? 'Движок коуча не подключён — перезапустите коуча.' : live?.reason ? LIVE_HINT[live.reason] : liveState === 'off' ? 'Коуч не смотрит на экран. Включите — и он сам найдёт окно Доты.' : null;

  // 2. Данные из игры (GSI)
  const g = gsiStatus(gsi, now);
  const gsiTone: StepTone = g.key === 'flowing' ? 'ok' : g.key === 'waiting' ? 'wait' : g.key === 'off' ? 'off' : 'bad';
  const gsiHelp =
    g.key === 'waiting'
      ? 'В меню Dota молчит — данные пойдут, когда загрузится матч или Hero Demo.'
      : g.key === 'off'
        ? 'Подключите один раз: коуч запишет файл в папку Доты, и она сама будет присылать время, золото, предметы.'
        : g.key === 'flowing'
          ? null
          : 'Приёмник данных не запустился — подробности и решение на странице «Живая игра».';

  // 3. Подсказки поверх игры
  const hintsOn = !!settings?.hints.enabled && !!settings?.hud.enabled;
  const exclusive = live?.videoMode === 'exclusive';
  const hidden = settings?.hud.hiddenZones.length ?? 0;
  const hudTone: StepTone = !hintsOn ? 'off' : exclusive ? 'bad' : 'ok';
  const hudStatus = !hintsOn ? 'Выключены' : exclusive ? 'Дота в эксклюзивном полноэкранном режиме' : hidden ? `Включены, скрыто зон: ${hidden} из 4` : 'Включены — коуч заговорит, когда есть что сказать';

  const ready = liveTone === 'ok' || gsiTone === 'ok';

  return (
    <>
      <PageHeader
        title="Готовность к матчу"
        subtitle={ready ? 'Коуч на связи с игрой. Подсказки появятся поверх Доты, когда будет что сказать.' : 'Запустите Доту — коуч подключится сам. Ниже видно, чего ещё не хватает и что сделать.'}
      />
      <UpdateBanner onOpen={() => onNavigate('updates')} />
      <div className="row game-mode-row">
        <span className="muted small">Режим игры:</span>
        <GameModeBadge testId="dash-game-mode" />
      </div>

      <div className="steps">
        <Step
          n={1}
          icon="live"
          title="Окно Доты"
          tone={liveTone}
          status={LIVE_LABEL[liveState]}
          action={
            liveState === 'off' ? (
              <button className="primary" onClick={() => startLive(settings)} disabled={!settings || !connected} data-testid="dash-live-start">
                <Icon name="play" size={14} />
                Включить
              </button>
            ) : (
              <button onClick={() => onNavigate('live')}>Подробнее</button>
            )
          }
        >
          {liveHelp}
        </Step>
        <Step
          n={2}
          icon="plug"
          title="Данные из игры"
          tone={gsiTone}
          status={g.text.charAt(0).toUpperCase() + g.text.slice(1)}
          action={<button onClick={() => onNavigate('live')}>{g.key === 'off' ? 'Подключить' : 'Подробнее'}</button>}
        >
          {gsiHelp}
        </Step>
        <Step
          n={3}
          icon="layers"
          title="Подсказки поверх игры"
          tone={hudTone}
          status={hudStatus}
          action={
            hintsOn ? (
              <button onClick={() => onNavigate('hud')}>Настроить вид</button>
            ) : (
              <button className="primary" onClick={() => void update({ hints: { enabled: true }, hud: { enabled: true } })} disabled={!settings} data-testid="dash-hints-on">
                Включить
              </button>
            )
          }
        >
          {exclusive ? 'Windows не даёт рисовать поверх такого окна: в Доте выберите «Полноэкранный в окне» (Настройки → Видео).' : null}
        </Step>
      </div>

      <MetaCard />

      <div className="grid-2">
        <Card title="Подсказки сейчас">
          <HintsFeed />
        </Card>
        <Card title="Что видит коуч" actions={<button onClick={() => onNavigate('match')}>Состояние матча</button>}>
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
            <p className="muted empty-note">Картинки пока нет. Когда коуч увидит игру, здесь появятся время, золото, здоровье, мана и уровень с экрана.</p>
          )}
          <div className="row small">
            {isLive(status) ? <LivePill live={status.live} /> : <StatePill state={status?.state ?? null} />}
            <span className="muted" data-testid="dash-fps">
              {status?.measuredFps ?? 0} к/с · обработка {status?.processingFps ?? 0} к/с
            </span>
            {stale && <span className="warn">Кадры не поступают {age!.toFixed(0)} с</span>}
          </div>
          {status?.lastError && <p className={status.lastError.fatal ? 'error' : 'warn'}>Последняя ошибка: {status.lastError.message}</p>}
        </Card>
      </div>

      <Card title="Что разрешено коучу">
        {info ? (
          <ul className="policy">
            {info.policy.modes.map((m) => (
              <li key={m.mode} className={m.allowed ? 'ok' : 'off'}>
                <span className="policy-dot" aria-hidden />
                <div>
                  <b>{MODE_LABEL[m.mode]}</b> — {m.allowed ? 'включено' : 'выключено'}
                  <div className="muted small">{m.reason}</div>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Загрузка…</p>
        )}
      </Card>
    </>
  );
}

const MODE_LABEL = {
  replay: 'Разбор записей',
  'live-observe': 'Живой захват (только наблюдение)',
  'live-coach-unranked': 'Подсказки в обычных матчах',
  'live-coach-ranked': 'Подсказки в рейтинговых матчах',
} as const;
