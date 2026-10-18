// Страница «Состояние матча» (этап D): устойчивое состояние из модели движка.
// Каждое значение — с пометкой (видно сейчас / видели раньше / вывод / неизвестно), возрастом и уверенностью.
// Неизвестное показывается прочерком: ничего не додумываем. Советов здесь нет (это этап F).
// С этапа GSI у каждого значения — источник: «из игры» (Valve GSI) или «с экрана» (зрение), и карточка «Точность зрения».
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { formatClock } from '@core/vision/hud-fields.ts';
import type { AbilityState, MatchEvent, MatchState as MatchSnapshot, Tracked, TrackedSource, TrackedTag } from '@core/match-state/index.ts';
import type { AgreementField, AgreementReport } from '@core/gsi/agreement.ts';
import type { VisionAgreementField } from '@core/gsi/vision-agreement.ts';
import { useEngine } from '../hooks/useEngine';
import { Card, PageHeader } from '../components/ui';
import { GameModeBadge } from '../components/gsi';
import { UpcomingEventsCard } from '../components/mechanics';
import { useKnowledgeBase } from '../hooks/useKnowledgeBase';
import { PlayersCard } from '../components/players';
import { AskCoach } from '../components/ask';
import { usePageFacts } from '../hooks/useFacts';

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

const SOURCE_LABEL: Record<Exclude<TrackedSource, null>, string> = { gsi: 'из игры', screen: 'с экрана' };

export function SourceChip({ source }: { source: TrackedSource }) {
  if (!source) return null;
  return (
    <span className={`src-chip src-${source}`} data-source={source} data-testid="source-chip">
      {SOURCE_LABEL[source]}
    </span>
  );
}

/** Одно значение: подпись, значение (или «—»), метка, источник, возраст, уверенность */
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
        {known && <SourceChip source={t.source} />}
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
      return d.reason === 'manual'
        ? 'Начато новое наблюдение'
        : d.reason === 'gsi-hero'
          ? 'Другой герой — новая игра (по данным игры)'
          : d.reason === 'gsi-match-id' || d.reason === 'gsi-pre-game'
            ? 'Новый матч (по данным игры)'
            : 'Новый матч (время ушло назад)';
  }
}

export function MatchState() {
  const { status, match, agreement } = useEngine();
  const now = useNow();
  const running = status?.state === 'starting' || status?.state === 'running' || status?.state === 'paused';
  // Данные из игры (GSI) заполняют страницу и без захвата экрана
  const gsi = !!match?.sources.gsi;
  const getFacts = usePageFacts('match');

  return (
    <>
      <PageHeader title="Состояние матча" subtitle="Что коуч знает о матче: видно сейчас, видели раньше, вывод или неизвестно; из игры или с экрана. Только наблюдение, без советов." />
      <p className="game-mode-row muted small">
        Режим игры: <GameModeBadge testId="match-game-mode" />
      </p>
      {(!running && !gsi) || !match ? (
        <Card>
          <p className="muted match-empty" data-testid="match-empty">
            Запустите живую игру или разбор записи
          </p>
        </Card>
      ) : (
        <>
          <MatchView s={match} now={now} />
          <Card title="Спросить коуча">
            <AskCoach page="match" getFacts={getFacts} compact placeholder="Например: кто из врагов пропал? когда возродится Lina?" />
          </Card>
          <AgreementCard report={agreement} />
        </>
      )}
    </>
  );
}

function MatchView({ s, now }: { s: MatchSnapshot; now: number }) {
  const m = s.match;
  const { kb } = useKnowledgeBase();
  // «Ближайшие события» — только когда игровые часы известны
  const clockKnown = m.clock.value !== null && m.clock.tag !== 'unknown';
  const h = s.hero;
  const events = s.events.slice(-EVENTS_SHOWN).reverse();
  // Ячейки только из GSI: телепорт и нейтральные — всегда, тайник — только занятые ячейки (шесть пустых — шум)
  const heroNames = useMemo(() => new Map((kb?.heroes ?? []).map((x) => [x.key, x.name])), [kb]);
  const extraAll = h.extraItems ?? [];
  const isStash = (slot: string) => slot.startsWith('stash');
  const extra = extraAll.filter((it) => !isStash(it.slot) || (it.tag !== 'unknown' && it.value?.item));
  const stashEmpty = extraAll.some((it) => isStash(it.slot)) && !extra.some((it) => isStash(it.slot));
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
        <p className="muted small" data-testid="match-sources">
          Источники: {s.sources.gsi ? 'данные из игры' : 'данных из игры нет'} · {s.sources.screen ? 'экран' : 'экран не используется'}
        </p>
      </Card>

      {clockKnown && kb && kb.mechanics.length > 0 && <UpcomingEventsCard clockSec={m.clock.value as number} entries={kb.mechanics} />}

      <Card title="Мой герой">
        {!h.locked && (
          <p className="muted match-hint" data-testid="hero-not-locked">
            Герой игрока ещё не определён: коуч ждёт данных из игры или пока на нижней панели несколько секунд будет ваш герой.
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

      <PlayersCard s={s} now={now} names={heroNames} />

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
            <Fact key={it.slot} label={slotLabel(it.slot)} t={it} format={itemText} now={now} testId={`item-${it.slot}`} />
          ))}
        </div>
        {extra.length > 0 && (
          <>
            <p className="muted small">Только из игры (GSI): телепорт, нейтральный предмет и тайник</p>
            <div className="match-items" data-testid="match-items-extra">
              {extra.map((it) => (
                <Fact key={it.slot} label={slotLabel(it.slot)} t={it} format={itemText} now={now} testId={`item-${it.slot}`} />
              ))}
            </div>
            {stashEmpty && (
              <p className="muted small" data-testid="item-stash-empty">
                Тайник: пусто
              </p>
            )}
          </>
        )}
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

/** Подпись ячейки предмета */
function slotLabel(slot: string): string {
  if (slot.startsWith('inv')) return `Ячейка ${slot.slice(3)}`;
  if (slot.startsWith('bp')) return `Рюкзак ${slot.slice(2)}`;
  if (slot.startsWith('stash')) return `Тайник ${slot.slice(5)}`;
  if (slot === 'tp') return 'Телепорт';
  if (slot === 'neutral') return 'Нейтральный предмет';
  if (slot === 'neutral2') return 'Зачарование';
  return slot;
}

const itemText = (v: { item: { name: string } | null }) => (v.item ? v.item.name : 'пусто');

const AGREE_LABEL: Record<AgreementField | VisionAgreementField, string> = {
  clock: 'Время',
  scoreRadiant: 'Счёт Сил Света',
  scoreDire: 'Счёт Сил Тьмы',
  dayNight: 'Время суток',
  kda: 'У / С / П',
  farm: 'ДК / НО',
  heroName: 'Имя героя',
  level: 'Уровень',
  gold: 'Золото',
  health: 'Здоровье',
  mana: 'Мана',
  abilityState: 'Состояние способностей',
  abilityLevel: 'Уровни способностей',
  items: 'Предметы',
  topBarHero: 'Верхняя панель: герой',
  topBarAlive: 'Верхняя панель: жив / мёртв',
  minimapPosition: 'Мини-карта: место (≤ 400 ед.)',
  healthBarHp: 'Полоски: здоровье (± 5 п.п.)',
};

const show = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'object') return Object.values(v as Record<string, unknown>).join('/');
  return String(v);
};

/** Точность зрения: насколько чтения с экрана совпадают с данными из игры (одни и те же моменты, окно 1.5 с) */
function AgreementCard({ report }: { report: AgreementReport }) {
  const rows = (Object.keys(AGREE_LABEL) as (AgreementField | VisionAgreementField)[]).filter((f) => report[f] && report[f]!.samples > 0);
  return (
    <Card title="Точность зрения">
      {rows.length === 0 ? (
        <p className="muted" data-testid="agreement-empty">
          Появится, когда одновременно идут данные из игры и живой захват экрана: коуч сравнивает, что прочитал с экрана, с тем, что прислала
          Dota. Строки о союзниках и врагах (верхняя панель, мини-карта, полоски) — только при просмотре записи или трансляции: тогда Dota
          присылает данные обо всех десяти героях.
        </p>
      ) : (
        <table className="table" data-testid="agreement-table">
          <thead>
            <tr>
              <th>Поле</th>
              <th>Сравнений</th>
              <th>Совпало</th>
              <th>Последнее расхождение (игра / экран)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((f) => {
              const a = report[f]!;
              const pct = a.agreePct ?? 0;
              return (
                <tr key={f} data-testid={`agreement-${f}`}>
                  <td>{AGREE_LABEL[f]}</td>
                  <td className="mono">{a.samples}</td>
                  <td className={`mono agree-pct ${pct >= 95 ? 'hi' : pct >= 80 ? 'mid' : 'lo'}`}>{a.agreePct === null ? '—' : `${a.agreePct}%`}</td>
                  <td className="mono">{a.lastMismatch ? `${show(a.lastMismatch.gsi)} / ${show(a.lastMismatch.screen)}` : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
