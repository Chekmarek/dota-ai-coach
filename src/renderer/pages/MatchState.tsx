// Страница «Состояние матча» (этап D): устойчивое состояние из модели движка.
// Каждое значение — с пометкой (видно сейчас / видели раньше / вывод / неизвестно), возрастом и уверенностью.
// Неизвестное показывается прочерком: ничего не додумываем. Советов здесь нет (это этап F).
import { useEffect, useState, type ReactNode } from 'react';
import { formatClock } from '@core/vision/hud-fields.ts';
import type { AbilityState, MatchEvent, MatchState as MatchSnapshot, Tracked, TrackedTag } from '@core/match-state/index.ts';
import { useEngine } from '../hooks/useEngine';
import { Card, PageHeader } from '../components/ui';

const TAG_LABEL: Record<TrackedTag, string> = {
  visible: 'видно сейчас',
  remembered: 'видели раньше',
  inferred: 'вывод',
  unknown: 'неизвестно',
};

const ABILITY_LABEL: Record<AbilityState, string> = { ready: 'готова', cooldown: 'перезарядка', 'no-mana': 'нет маны', unlearned: 'не изучена' };

/** Сколько последних событий показываем */
const EVENTS_SHOWN = 20;

/** Текущее время, обновляется раз в секунду — чтобы «3 с назад» шло само */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now;
}

function ago(now: number, at: number | null): string {
  if (at === null) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 1) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин назад` : `${Math.floor(m / 60)} ч назад`;
}

const clock = (sec: number) => formatClock(Math.trunc(sec));

export function TagChip({ tag }: { tag: TrackedTag }) {
  return (
    <span className={`tag-chip tag-${tag}`} data-tag={tag}>
      {TAG_LABEL[tag]}
    </span>
  );
}

/** Одно значение: подпись, значение (или «—»), метка, возраст, уверенность */
function Fact<T>({ label, t, format, now, testId, suffix }: { label: string; t: Tracked<T>; format: (v: T) => ReactNode; now: number; testId: string; suffix?: ReactNode }) {
  const known = t.value !== null && t.tag !== 'unknown';
  return (
    <div className={`fact fact-${t.tag}`} data-testid={testId}>
      <div className="fact-label">{label}</div>
      <div className="fact-value" data-testid={`${testId}-value`}>
        {known ? format(t.value as T) : '—'}
        {known && suffix}
      </div>
      <div className="fact-meta">
        <TagChip tag={known ? t.tag : 'unknown'} />
        {known && (
          <span className="muted">
            {ago(now, t.lastSeenWallMs)} · {Math.round(t.confidence * 100)}%
          </span>
        )}
      </div>
    </div>
  );
}

function eventText(e: MatchEvent): string {
  const d = e.data as Record<string, string | number | undefined>;
  switch (e.type) {
    case 'level-up':
      return `Уровень ${d.from} → ${d.to}`;
    case 'kill':
      return `Убийство (всего ${d.to})`;
    case 'death':
      return `Смерть (всего ${d.to})`;
    case 'assist':
      return `Помощь в убийстве (всего ${d.to})`;
    case 'item-gained':
      return `Появился предмет: ${d.name ?? d.key}`;
    case 'item-lost':
      return `Пропал предмет: ${d.name ?? d.key}`;
    case 'ability-learned':
      return `Способность ${Number(d.index) + 1}: уровень ${d.to}`;
    case 'day-night':
      return d.to === 'night' ? 'Наступила ночь' : 'Наступил день';
    case 'pause':
      return 'Пауза';
    case 'unpause':
      return 'Игра продолжилась';
    case 'match-reset':
      return d.reason === 'manual' ? 'Начато новое наблюдение' : 'Новый матч (время ушло назад)';
  }
}

export function MatchState() {
  const { status, match } = useEngine();
  const now = useNow();
  const running = status?.state === 'starting' || status?.state === 'running' || status?.state === 'paused';

  return (
    <>
      <PageHeader title="Состояние матча" subtitle="Что коуч знает о матче: видно сейчас, видели раньше, вывод или неизвестно. Только наблюдение, без советов." />
      {!running || !match ? (
        <Card>
          <p className="muted match-empty" data-testid="match-empty">
            Запустите живую игру или разбор записи
          </p>
        </Card>
      ) : (
        <MatchView s={match} now={now} />
      )}
    </>
  );
}

function MatchView({ s, now }: { s: MatchSnapshot; now: number }) {
  const m = s.match;
  const h = s.hero;
  const events = s.events.slice(-EVENTS_SHOWN).reverse();
  return (
    <div className="match-page">
      <Card title="Матч">
        <div className="facts">
          <Fact
            label="Время"
            t={m.clock}
            format={clock}
            now={now}
            testId="match-clock"
            suffix={m.paused ? <span className="paused-mark" title="Пауза" data-testid="match-paused"> ⏸</span> : null}
          />
          <Fact label="Счёт Сил Света" t={m.scoreRadiant} format={String} now={now} testId="match-score-radiant" />
          <Fact label="Счёт Сил Тьмы" t={m.scoreDire} format={String} now={now} testId="match-score-dire" />
          <Fact label="Время суток" t={m.dayNight} format={(v) => (v === 'day' ? 'день' : 'ночь')} now={now} testId="match-daynight" />
        </div>
      </Card>

      <Card title="Мой герой">
        {!h.locked && (
          <p className="muted match-hint" data-testid="hero-not-locked">
            Герой игрока ещё не определён: коуч ждёт, пока на нижней панели несколько секунд будет ваш герой.
          </p>
        )}
        <div className="facts">
          <Fact label="Герой" t={h.identity} format={(v) => v.name} now={now} testId="hero-identity" />
          <Fact label="Уровень" t={h.level} format={String} now={now} testId="hero-level" />
          <Fact label="Золото" t={h.gold} format={String} now={now} testId="hero-gold" />
          <Fact label="Здоровье" t={h.health} format={(v) => `${v.current} / ${v.max}`} now={now} testId="hero-health" />
          <Fact label="Мана" t={h.mana} format={(v) => `${v.current} / ${v.max}`} now={now} testId="hero-mana" />
          <Fact label="У / С / П" t={h.kda} format={(v) => `${v.kills} / ${v.deaths} / ${v.assists}`} now={now} testId="hero-kda" />
          <Fact label="ДК / НО" t={h.farm} format={(v) => `${v.lastHits} / ${v.denies}`} now={now} testId="hero-farm" />
        </div>
      </Card>

      <Card title="Способности">
        {h.abilities.length === 0 ? (
          <p className="muted">—</p>
        ) : (
          <div className="facts" data-testid="match-abilities">
            {h.abilities.map((a) => {
              const cd = a.cooldown.value !== null && a.cooldown.value > 0 && a.state.value === 'cooldown' ? a.cooldown : null;
              return (
                <div key={a.index} className="ability-fact">
                  <Fact
                    label={`Способность ${a.index + 1}`}
                    t={a.state}
                    format={(v) => ABILITY_LABEL[v]}
                    now={now}
                    testId={`ability-${a.index}`}
                    suffix={a.level.value !== null ? <span className="ability-level"> {'●'.repeat(a.level.value) || '○'}</span> : null}
                  />
                  {cd && (
                    <div className="fact-meta">
                      <span className="mono">ещё {Math.ceil(cd.value!)} с</span>
                      <TagChip tag={cd.tag} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card title="Инвентарь">
        <div className="match-items" data-testid="match-items">
          {h.items.map((it) => (
            <Fact
              key={it.slot}
              label={it.slot.startsWith('bp') ? `Рюкзак ${it.slot.slice(2)}` : `Ячейка ${it.slot.slice(3)}`}
              t={it}
              format={(v) => (v.item ? v.item.name : 'пусто')}
              now={now}
              testId={`item-${it.slot}`}
            />
          ))}
        </div>
      </Card>

      <Card title="События">
        {events.length === 0 ? (
          <p className="muted">Пока ничего не произошло.</p>
        ) : (
          <ol className="match-events" data-testid="match-events">
            {events.map((e, i) => (
              <li key={`${e.wallMs}-${i}`}>
                <span className="mono match-event-time">{e.clock === null ? '—' : clock(e.clock)}</span>
                <span>{eventText(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
