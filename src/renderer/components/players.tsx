// Карточка «Союзники и враги» (этап 4 зрения): что коуч знает о каждом из 10 героев — герой, жив ли и когда
// возродится, где его видели и как давно, здоровье с полоски. У каждого значения — пометка и источник «с экрана».
// Мини-карта — последние известные места. Только наблюдение, советов нет.
import type { ReactNode } from 'react';
import { formatClock } from '@core/vision/hud-fields.ts';
import type { MatchState, Tracked, TrackedPlayer } from '@core/match-state/index.ts';
import { MAP_HALF_SIZE, MAP_ZONE_RU, mapZone } from '@core/match-state/index.ts';
import type { PortraitTemplates } from '@core/vision/top-bar.ts';
import { PORTRAIT_GRID_H, PORTRAIT_GRID_W, PORTRAIT_SCALE } from '@core/vision/top-bar.ts';
import portraitsJson from '../../data/hero-portraits.json';
import layoutJson from '../../data/hud-layouts/dota2-default-16x9.json';
import { Card } from './ui';
import { SourceChip, TagChip } from '../pages/MatchState';

const portraits = portraitsJson as unknown as PortraitTemplates;
/** Цвета игроков на мини-карте (как в игре): по ячейке 0–9 */
const PLAYER_COLORS = (layoutJson as { minimap?: { colors: number[][] } }).minimap?.colors ?? [];

function ago(now: number, at: number | null): string {
  if (at === null) return '';
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 1) return 'только что';
  if (s < 60) return `${s} с назад`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} мин назад` : `${Math.floor(m / 60)} ч назад`;
}

const rgb = (slot: number) => {
  const c = PLAYER_COLORS[slot];
  return c ? `rgb(${c[0]},${c[1]},${c[2]})` : 'var(--muted)';
};

/**
 * Мозаика портрета 14×5 — та самая сетка, по которой верхняя панель узнаёт героя (картинок героев в программе нет).
 * Цвета нормированы (среднее и разброс), поэтому мозаика узнаваема по пятнам, но не по точным цветам.
 */
function PortraitMosaic({ heroKey }: { heroKey: string | null }) {
  const t = heroKey ? (portraits.heroes.find((h) => h.key === heroKey && !h.variant) ?? portraits.heroes.find((h) => h.key === heroKey)) : undefined;
  const cell = 3;
  if (!t) return <span className="portrait-mosaic portrait-none" aria-hidden />;
  const rects: ReactNode[] = [];
  for (let gy = 0; gy < PORTRAIT_GRID_H; gy++)
    for (let gx = 0; gx < PORTRAIT_GRID_W; gx++) {
      const k = (gy * PORTRAIT_GRID_W + gx) * 3;
      const ch = (i: number) => Math.max(0, Math.min(255, Math.round(128 + (t.t[k + i]! / PORTRAIT_SCALE) * 50)));
      rects.push(<rect key={k} x={gx * cell} y={gy * cell} width={cell} height={cell} fill={`rgb(${ch(0)},${ch(1)},${ch(2)})`} />);
    }
  return (
    <svg className="portrait-mosaic" width={PORTRAIT_GRID_W * cell} height={PORTRAIT_GRID_H * cell} aria-hidden>
      {rects}
    </svg>
  );
}

/** Значение с пометкой, источником и возрастом (короткая форма для строки игрока) */
function Cell<T>({ t, format, now, testId, extra }: { t: Tracked<T>; format: (v: T) => ReactNode; now: number; testId: string; extra?: ReactNode }) {
  const known = t.value !== null && t.tag !== 'unknown';
  return (
    <div className={`pl-cell fact-${known ? t.tag : 'unknown'}`} data-testid={testId}>
      <div className="pl-value">
        {known ? format(t.value as T) : '—'}
        {extra}
      </div>
      <div className="fact-meta">
        <TagChip tag={known ? t.tag : 'unknown'} />
        {known && <SourceChip source={t.source} />}
        {known && <span className="muted">{ago(now, t.lastSeenWallMs)}</span>}
      </div>
    </div>
  );
}

function PlayerRow({ p, now, names }: { p: TrackedPlayer; now: number; names: Map<string, string> }) {
  const key = p.hero.value;
  const name = key ? (names.get(key) ?? key) : 'герой не узнан';
  const dead = p.alive.value === false;
  return (
    <tr data-testid={`player-${p.slot}`} className={dead ? 'pl-dead' : undefined}>
      <td>
        <div className="pl-hero">
          <span className="pl-dot" style={{ background: rgb(p.slot) }} />
          <PortraitMosaic heroKey={key} />
          <div>
            <div className={key ? undefined : 'muted'} data-testid={`player-${p.slot}-hero`}>
              {name}
            </div>
            <div className="fact-meta">
              <TagChip tag={key ? p.hero.tag : 'unknown'} />
              {key && <SourceChip source={p.hero.source} />}
            </div>
          </div>
        </div>
      </td>
      <td>
        <Cell
          t={p.alive}
          format={(v) => (v ? 'жив' : 'мёртв')}
          now={now}
          testId={`player-${p.slot}-alive`}
          extra={dead && p.respawnAt.value !== null ? <span className="muted"> · возродится в {formatClock(Math.trunc(p.respawnAt.value))}</span> : null}
        />
      </td>
      <td>
        <Cell
          t={p.position}
          format={(v) => MAP_ZONE_RU[mapZone(v.x, v.y)]}
          now={now}
          testId={`player-${p.slot}-position`}
          extra={
            p.missing ? (
              <span className="pill pl-missing" data-testid={`player-${p.slot}-missing`}>
                пропал {p.missingSinceWallMs !== null ? ago(now, p.missingSinceWallMs).replace(' назад', '') : ''}
              </span>
            ) : null
          }
        />
      </td>
      <td>
        <Cell t={p.hpPercent} format={(v) => `${v}%`} now={now} testId={`player-${p.slot}-hp`} />
      </td>
    </tr>
  );
}

/** Мини-карта: последние известные места героев (яркие — видно сейчас, бледные — видели раньше) */
function MiniMapDrawing({ players }: { players: TrackedPlayer[] }) {
  const size = 168;
  const toPx = (x: number, y: number) => [((x + MAP_HALF_SIZE) / (2 * MAP_HALF_SIZE)) * size, ((MAP_HALF_SIZE - y) / (2 * MAP_HALF_SIZE)) * size] as const;
  // Мёртвых не рисуем: их последнее место — уже не место героя
  const known = players.filter((p) => p.position.value !== null && p.position.tag !== 'unknown' && p.alive.value !== false);
  return (
    <svg className="pl-minimap" width={size} height={size} viewBox={`0 0 ${size} ${size}`} data-testid="players-minimap" role="img" aria-label="Последние известные места героев">
      <rect x={0} y={0} width={size} height={size} rx={6} className="pl-map-bg" />
      {/* Река — диагональ из левого верхнего угла в правый нижний; базы — углы */}
      <line x1={0} y1={0} x2={size} y2={size} className="pl-map-river" />
      <rect x={4} y={size - 34} width={30} height={30} rx={4} className="pl-map-base-radiant" />
      <rect x={size - 34} y={4} width={30} height={30} rx={4} className="pl-map-base-dire" />
      {known.map((p) => {
        const [cx, cy] = toPx(p.position.value!.x, p.position.value!.y);
        const fresh = p.position.tag === 'visible';
        return (
          <circle key={p.slot} cx={cx} cy={cy} r={fresh ? 5 : 4} fill={rgb(p.slot)} opacity={fresh ? 1 : 0.4} stroke="#000" strokeWidth={1} data-testid={`players-minimap-${p.slot}`}>
            <title>{`Игрок ${p.slot + 1}: ${fresh ? 'видно сейчас' : 'видели раньше'}`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

export function PlayersCard({ s, now, names }: { s: MatchState; now: number; names: Map<string, string> }) {
  if (s.players.length === 0)
    return (
      <Card title="Союзники и враги">
        <p className="muted" data-testid="players-empty">
          Появится, когда коуч увидит верхнюю панель с портретами героев (живая игра или разбор записи, 16:9, стандартный интерфейс).
        </p>
      </Card>
    );
  const groups =
    s.ourTeam === null
      ? [
          { title: 'Силы Света', list: s.players.filter((p) => p.team === 'radiant') },
          { title: 'Силы Тьмы', list: s.players.filter((p) => p.team === 'dire') },
        ]
      : [
          { title: 'Союзники', list: s.allies },
          { title: 'Враги', list: s.enemies },
        ];
  const bars = s.healthBars;
  return (
    <Card title="Союзники и враги">
      <div className="pl-layout" data-testid="players-card">
        <div className="pl-tables">
          {groups.map((g) => (
            <table key={g.title} className="table pl-table">
              <thead>
                <tr>
                  <th>{g.title}</th>
                  <th>Жив</th>
                  <th>Где видели</th>
                  <th>Здоровье</th>
                </tr>
              </thead>
              <tbody>
                {g.list.map((p) => (
                  <PlayerRow key={p.slot} p={p} now={now} names={names} />
                ))}
              </tbody>
            </table>
          ))}
        </div>
        <div className="pl-side">
          <MiniMapDrawing players={s.players} />
          <p className="muted small">
            {s.ourTeam === null ? 'Своя команда неизвестна — показаны Силы Света и Силы Тьмы.' : null} Места — с мини-карты; «где видели» — приблизительная
            область карты.
          </p>
          <p className="muted small" data-testid="players-bars">
            Полоски здоровья на экране: {bars.length === 0 ? 'не видно' : bars.map((b) => `${b.side === 'ally' ? 'союзник' : b.side === 'enemy' ? 'враг' : b.team === 'radiant' ? 'Свет' : 'Тьма'} ${b.hpPercent}%`).join(', ')}
          </p>
        </div>
      </div>
    </Card>
  );
}
