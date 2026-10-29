// «Мета патча» на главной: сильные герои по позициям (OpenDota + позиции STRATZ) и изменения любого героя в патчах
// текущей версии (описания Valve). Данные скачивает main в фоне; здесь — только показ.
import { useEffect, useMemo, useState } from 'react';
import { META_BRACKETS, type MetaBracket, type MetaHeroChanges, type MetaState } from '@shared/types/meta';
import { Card } from './ui';
import { Icon } from './icons';
import { useKnowledgeBase } from '../hooks/useKnowledgeBase';

const POSITIONS = [
  { id: '0', label: 'Все' },
  { id: '1', label: 'Керри' },
  { id: '2', label: 'Мид' },
  { id: '3', label: 'Оффлейн' },
  { id: '4', label: 'Поз. 4' },
  { id: '5', label: 'Поз. 5' },
] as const;

const pct = (x: number) => `${(Math.round(x * 1000) / 10).toLocaleString('ru-RU')}%`;
const games = (n: number) => (n >= 1000 ? `${Math.round(n / 1000).toLocaleString('ru-RU')} тыс.` : String(n));
const dateRu = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }) : '');

export function MetaCard() {
  const [bracket, setBracket] = useState<MetaBracket>('high');
  const [pos, setPos] = useState<string>('0');
  const [state, setState] = useState<MetaState | null>(null);
  const [hero, setHero] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () => void window.dotacoach.metaGet(bracket).then((s) => alive && setState(s));
    load();
    const off = window.dotacoach.onMetaChanged(load);
    return () => {
      alive = false;
      off();
    };
  }, [bracket]);

  const rows = state?.positions[pos] ?? [];
  const latest = state?.patches[0] ?? null;
  // Герой справа: выбранный или первый в списке
  const shown = hero ?? rows[0]?.hero ?? null;

  return (
    <Card
      title={latest ? `Мета патча ${latest.version}` : 'Мета патча'}
      actions={
        <>
          <select value={bracket} onChange={(e) => setBracket(e.target.value as MetaBracket)} data-testid="meta-bracket" aria-label="Ранги">
            {(Object.keys(META_BRACKETS) as MetaBracket[]).map((b) => (
              <option key={b} value={b}>
                {META_BRACKETS[b].nameRu}
              </option>
            ))}
          </select>
          <button onClick={() => void window.dotacoach.metaRefresh()} disabled={state?.refreshing} title="Скачать свежую статистику" data-testid="meta-refresh">
            <Icon name="refresh" size={15} />
            {state?.refreshing ? 'Обновляю…' : 'Обновить'}
          </button>
        </>
      }
    >
      <div className="meta-tabs" role="tablist" data-testid="meta-positions">
        {POSITIONS.map((p) => (
          <button key={p.id} role="tab" aria-selected={pos === p.id} className={pos === p.id ? 'selected' : ''} onClick={() => setPos(p.id)}>
            {p.id !== '0' && <b>{p.id}</b>}
            {p.label}
          </button>
        ))}
      </div>
      {state?.note && <p className="muted small" data-testid="meta-note">{state.note}</p>}
      <div className="meta-split">
        <ol className="meta-list" data-testid="meta-list">
          {rows.map((r, i) => (
            <li key={r.hero}>
              <button className={`meta-row${shown === r.hero ? ' active' : ''}`} onClick={() => setHero(r.hero)}>
                <span className="meta-rank">{i + 1}</span>
                <span className="meta-name">
                  {r.name}
                  {r.changedInLatest && latest && <span className="meta-changed">изменён в {latest.version}</span>}
                </span>
                <span className="meta-wr">{pct(r.winrate)}</span>
                <span className={`meta-trend${r.trend === null ? '' : r.trend > 0 ? ' up' : ' down'}`} title={r.trend === null ? '' : `${r.trend > 0 ? '+' : ''}${r.trend.toLocaleString('ru-RU')} п.п. за последние дни`}>
                  {r.trend !== null && <Icon name={r.trend > 0 ? 'trend-up' : 'trend-down'} size={15} />}
                </span>
                <span className="meta-sub">
                  {games(r.picks)} игр · берут в {pct(r.pickRate)} матчей{r.positionShare !== null && pos !== '0' ? ` · на этой позиции ${pct(r.positionShare)} его игр` : ''}
                </span>
              </button>
            </li>
          ))}
          {state && !rows.length && !state.note && <li className="muted small">Нет героев с достаточным числом игр.</li>}
        </ol>
        <HeroChanges hero={shown} bracket={bracket} onPick={setHero} />
      </div>
      {state?.statsAt && (
        <p className="muted small meta-source" data-testid="meta-source">
          Доля побед — OpenDota, публичные матчи последних недель ({META_BRACKETS[bracket].nameRu.toLowerCase()}), обновлено {new Date(state.statsAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}.
          Позиции — {state.positionsFrom === 'stratz' ? 'где героя играют сильные игроки рейтинга (STRATZ)' : 'по ролям героя (статистики позиций нет)'}. Изменения — официальные описания патчей Valve.
        </p>
      )}
    </Card>
  );
}

function HeroChanges({ hero, bracket, onPick }: { hero: string | null; bracket: MetaBracket; onPick: (k: string) => void }) {
  const { kb } = useKnowledgeBase();
  const [data, setData] = useState<MetaHeroChanges | null>(null);
  const [q, setQ] = useState('');
  useEffect(() => {
    if (!hero) return setData(null);
    let alive = true;
    void window.dotacoach.metaHero(hero, bracket).then((d) => alive && setData(d));
    return () => {
      alive = false;
    };
  }, [hero, bracket]);
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? (kb?.heroes ?? []).filter((h) => h.name.toLowerCase().includes(s) || h.key.includes(s)).slice(0, 6) : [];
  }, [q, kb]);
  const withNotes = data?.patches.filter((p) => p.notes.length) ?? [];

  return (
    <section className="meta-hero" data-testid="meta-hero">
      <div className="draft-picker">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Изменения другого героя…" data-testid="meta-hero-search" onKeyDown={(e) => e.key === 'Enter' && matches[0] && (onPick(matches[0].key), setQ(''))} />
        {matches.length > 0 && (
          <div className="draft-matches">
            {matches.map((h) => (
              <button key={h.key} onClick={() => (onPick(h.key), setQ(''))}>
                {h.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {data && (
        <>
          <header className="meta-hero-head">
            <h4>{data.name}</h4>
            {data.winrate !== null && (
              <span className="muted small">
                {pct(data.winrate)} побед · {games(data.picks ?? 0)} игр
              </span>
            )}
          </header>
          {withNotes.length === 0 && <p className="muted small">В патчах {data.patches.map((p) => p.version).join(', ') || 'текущей версии'} героя не меняли.</p>}
          <div className="meta-notes">
            {withNotes.map((p) => (
              <div key={p.version} className="meta-patch">
                <div className="meta-patch-head">
                  <b>{p.version}</b>
                  <span className="muted small">{dateRu(p.date)}</span>
                </div>
                <ul>
                  {p.notes.map((n, i) => (
                    <li key={i} style={n.indent ? { marginLeft: n.indent * 14 } : undefined}>
                      {(i === 0 || p.notes[i - 1]!.title !== n.title) && <span className="meta-note-title">{n.title}</span>}
                      {n.text}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
