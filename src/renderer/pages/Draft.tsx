import { useEffect, useMemo, useState } from 'react';
import type { DraftRequest, DraftResult, DraftReasonView } from '@shared/types/draft';
import type { KbHero } from '@shared/types/kb';
import { Card, PageHeader } from '../components/ui';
import { GameModeBadge, currentGameMode } from '../components/gsi';
import { useGsi } from '../hooks/useGsi';
import { useKnowledgeBase } from '../hooks/useKnowledgeBase';
import { Icon } from '../components/icons';

type Side = 'allies' | 'enemies' | 'bans';
const SIDE_LIMIT: Record<Side, number> = { allies: 4, enemies: 5, bans: 30 };
const SIDE_RU: Record<Side, string> = { allies: 'Союзники', enemies: 'Враги', bans: 'Баны' };
const POS_RU = ['керри', 'мид', 'оффлейн', 'частичная поддержка', 'полная поддержка'];
const ROLE_RU = { core: 'кор', support: 'саппорт', any: 'любой' } as const;

/** «+2,1%» */
const pct = (d: number) => {
  const v = Math.round(d * 1000) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('ru-RU')}%`;
};
/** «1 104 игры», «13 200 игр» */
const games = (n: number) => {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'игра' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'игры' : 'игр';
  return `${n.toLocaleString('ru-RU')} ${w}`;
};
/** «Bristleback +4,9% (13 200 игр)»: процент всегда с числом игр, по которым он посчитан */
const reason = (r: DraftReasonView) => `${r.name} ${pct(r.delta)} (${games(r.games)})`;
const reasons = (list: DraftReasonView[], sign: 1 | -1) =>
  list
    .filter((r) => r.delta * sign > 0.001)
    .slice(0, 3)
    .map(reason)
    .join(', ');

export function Draft() {
  const { kb, error: kbError } = useKnowledgeBase();
  const [req, setReq] = useState<DraftRequest>({ allies: [], enemies: [], bans: [], position: null, me: null });
  const [res, setRes] = useState<DraftResult | null>(null);
  const [liveNote, setLiveNote] = useState<string | null>(null);
  // Следить за экраном выбора героев: составы подставляются сами; ручная правка выключает слежение
  const [follow, setFollow] = useState(true);
  const [followNote, setFollowNote] = useState<string | null>(null);
  // Чья статистика: по режиму игры (Турбо — статистика Турбо) или выбранная вручную
  const [statsPick, setStatsPick] = useState<'auto' | 'normal' | 'turbo'>('auto');
  const gameTurbo = currentGameMode(useGsi(), Date.now()).mode === 'turbo';
  const statsMode: 'normal' | 'turbo' = statsPick === 'auto' ? (gameTurbo ? 'turbo' : 'normal') : statsPick;

  const heroes = useMemo(() => [...(kb?.heroes ?? [])].sort((a, b) => a.name.localeCompare(b.name)), [kb]);
  const byKey = useMemo(() => new Map(heroes.map((h) => [h.key, h])), [heroes]);
  const name = (k: string) => byKey.get(k)?.name ?? k;
  const taken = new Set([...req.allies, ...req.enemies, ...req.bans, ...(req.me ? [req.me] : [])]);

  useEffect(() => {
    let alive = true;
    const t = setTimeout(() => {
      void window.dotacoach.draftSuggest({ ...req, mode: statsMode }).then((r) => alive && setRes(r));
    }, 150);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [req, statsMode]);

  useEffect(() => {
    if (!follow) return;
    let alive = true;
    const poll = async () => {
      const l = await window.dotacoach.draftLive();
      if (!alive || !l.fromDraft) return;
      setFollowNote(`С экрана выбора героев: союзников ${l.allies.length + (l.me ? 1 : 0)}, врагов ${l.enemies.length}${l.enemies.length ? '' : ' (их пики откроются на стадии планирования)'}.`);
      setReq((r) => {
        const next = { ...r, me: l.me ?? r.me, allies: l.allies.filter((k) => k !== (l.me ?? r.me)).slice(0, 4), enemies: l.enemies.slice(0, 5) };
        return JSON.stringify(next) === JSON.stringify(r) ? r : next;
      });
    };
    void poll();
    const t = setInterval(() => void poll(), 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [follow]);

  const manual = () => {
    if (follow) setFollow(false);
  };
  const add = (side: Side, key: string) => {
    manual();
    setReq((r) => (r[side].length >= SIDE_LIMIT[side] || taken.has(key) ? r : { ...r, [side]: [...r[side], key] }));
  };
  const remove = (side: Side, key: string) => {
    manual();
    setReq((r) => ({ ...r, [side]: r[side].filter((k) => k !== key) }));
  };

  const fromMatch = async () => {
    const l = await window.dotacoach.draftLive();
    if (!l.me && !l.allies.length && !l.enemies.length) {
      setLiveNote(l.inGame ? 'Матч идёт, но героев пока не видно — откройте верхнюю панель.' : 'Матча сейчас нет: героев взять неоткуда.');
      return;
    }
    setLiveNote(null);
    setReq((r) => ({ ...r, me: l.me, allies: l.allies.slice(0, 4), enemies: l.enemies.slice(0, 5) }));
  };

  return (
    <>
      <PageHeader
        title="Драфт"
        subtitle="Кого взять против врагов и в пару к союзникам, чем опасны враги и что покупать против них. По статистике публичных матчей текущего патча."
      />
      <p className="game-mode-row muted small">
        Режим игры: <GameModeBadge testId="draft-game-mode" />
        <label className="draft-stats-mode">
          Статистика:{' '}
          <select value={statsPick} onChange={(e) => setStatsPick(e.target.value as typeof statsPick)} data-testid="draft-stats-mode">
            <option value="auto">по режиму игры ({gameTurbo ? 'Турбо' : 'обычные матчи'})</option>
            <option value="normal">обычные матчи (рейтинговый All Pick)</option>
            <option value="turbo">Турбо</option>
          </select>
        </label>
      </p>
      {(kbError || res?.error) && <p className="error">{kbError ?? res?.error}</p>}
      {res?.noStats && res.noStats.length > 0 && (
        <p className="muted small" data-testid="draft-no-stats">
          Нет статистики патча для: {res.noStats.join(', ')} — их влияние на подбор не учтено.
        </p>
      )}

      <Card
        title="Команды"
        actions={
          <>
            <button onClick={() => void fromMatch()} data-testid="draft-from-match" title="Герои из идущего матча (данные игры и верхняя панель)">
              Взять из матча
            </button>
            <button onClick={() => {
                manual();
                setReq({ allies: [], enemies: [], bans: [], position: null, me: null });
              }}
              data-testid="draft-clear">
              Очистить
            </button>
          </>
        }
      >
        <label className="row gap small" data-testid="draft-follow">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Следить за выбором героев в игре — союзники видны сразу, враги откроются на стадии планирования
        </label>
        {follow && followNote && <p className="muted small" data-testid="draft-follow-note">{followNote}</p>}
        {liveNote && <p className="muted small">{liveNote}</p>}
        <div className="draft-teams">
          {(['allies', 'enemies', 'bans'] as const).map((side) => (
            <div key={side} className={`draft-side draft-${side}`} data-testid={`draft-${side}`}>
              <div className="draft-side-head">
                {SIDE_RU[side]} <span className="muted small">{req[side].length}/{SIDE_LIMIT[side]}</span>
              </div>
              <div className="draft-chips">
                {req[side].map((k) => (
                  <button key={k} className="draft-chip" onClick={() => remove(side, k)} title="Убрать" aria-label={`Убрать ${name(k)}`}>
                    {name(k)}
                    <Icon name="close" size={12} />
                  </button>
                ))}
              </div>
              <HeroPicker heroes={heroes} taken={taken} disabled={req[side].length >= SIDE_LIMIT[side]} onPick={(k) => add(side, k)} testId={`draft-add-${side}`} />
            </div>
          ))}
        </div>
        <div className="row gap">
          <span className="muted">Мой герой:</span>
          {req.me ? (
            <button className="draft-chip draft-me" onClick={() => {
                manual();
                setReq((r) => ({ ...r, me: null }));
              }}
              data-testid="draft-me">
              {name(req.me)}
              <Icon name="close" size={12} />
            </button>
          ) : (
            <HeroPicker heroes={heroes} taken={taken} onPick={(k) => setReq((r) => ({ ...r, me: k }))} testId="draft-add-me" placeholder="ещё не выбран" />
          )}
        </div>
        {!req.me && (
          <div className="row gap" data-testid="draft-position">
            <span className="muted">Позиция:</span>
            {[null, 1, 2, 3, 4, 5].map((p) => (
              <button key={p ?? 0} className={req.position === p ? 'selected' : ''} aria-pressed={req.position === p} onClick={() => setReq((r) => ({ ...r, position: p }))} title={p ? POS_RU[p - 1] : 'любая'}>
                {p ?? 'любая'}
              </button>
            ))}
          </div>
        )}
      </Card>

      {res && !req.me && (
        <Card title="Кого взять">
          {!req.allies.length && !req.enemies.length && <p className="muted small">Добавьте врагов и союзников — пока список по общей силе героев в патче.</p>}
          {res.hasSynergy === false && req.allies.length > 0 && <p className="muted small">В статистике нет связок союзников — учитываются только враги.</p>}
          <ol className="draft-list" data-testid="draft-candidates">
            {res.candidates.map((c) => (
              <li key={c.hero} data-hero={c.hero} data-positions={c.positions.join(',')}>
                <div className="row gap">
                  <strong>{c.name}</strong>
                  <span className={`pill ${c.score >= 0 ? 'mech-verified' : 'mech-unverified'}`} title="Оценка изменения шанса победы по статистике патча">
                    {pct(c.score)}
                  </span>
                  {c.positions.length > 0 && <span className="muted small">поз. {c.positions.join(', ')}</span>}
                  <button className="draft-take" onClick={() => setReq((r) => ({ ...r, me: c.hero }))}>
                    Беру
                  </button>
                </div>
                <div className="muted small">
                  {[
                    reasons(c.vsEnemies, 1) && `сильнее против: ${reasons(c.vsEnemies, 1)}`,
                    reasons(c.withAllies, 1) && `в связке с: ${reasons(c.withAllies, 1)}`,
                    reasons(c.vsEnemies, -1) && `слабее против: ${reasons(c.vsEnemies, -1)}`,
                    Math.abs(c.meta) >= 0.005 && `сила в патче ${pct(c.meta)}`,
                  ]
                    .filter(Boolean)
                    .join(' · ') || 'без заметных плюсов и минусов'}
                </div>
              </li>
            ))}
          </ol>
        </Card>
      )}

      {res?.me && (
        <Card title={`${res.me.name}: матчапы`}>
          <div data-testid="draft-me-summary">
            <p>
              <span className="muted">Тяжелее всего против: </span>
              {res.me.worst.length ? res.me.worst.slice(0, 3).map(reason).join(', ') : 'нет заметно плохих матчапов'}
            </p>
            <p>
              <span className="muted">Плюсы: </span>
              {res.me.best.length ? res.me.best.slice(0, 3).map(reason).join(', ') : 'нет заметных'}
            </p>
            <p className="muted small">Предметы ниже — сначала для роли «{ROLE_RU[res.me.role]}».</p>
          </div>
        </Card>
      )}

      {res && res.threats.length > 0 && (
        <Card title="Угрозы врагов и что покупать">
          <ul className="draft-list" data-testid="draft-threats">
            {res.threats.map((t) => (
              <li key={t.id}>
                <div className="row gap">
                  <strong>{t.nameRu[0]!.toUpperCase() + t.nameRu.slice(1)}</strong>
                  <span className="muted small">
                    {t.heroes.join(', ')} — {t.whyRu}
                  </span>
                  {t.urgent && <span className="pill mech-unverified">срочно</span>}
                </div>
                <div className="small">
                  {t.items
                    .filter((i) => !res.me || i.role === 'any' || i.role === res.me.role)
                    .map((i) => `${i.name}${i.cost ? ` (${i.cost})` : ''} — ${ROLE_RU[i.role]}`)
                    .join(' · ')}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {res?.patch && (
        <p className="muted small" data-testid="draft-source">
          <b data-testid="draft-source-mode">{res.mode === 'turbo' ? 'Турбо' : 'Рейтинговый All Pick'}</b>, патч {res.patch}
          {typeof res.statsMatches === 'number' ? `, ${res.statsMatches.toLocaleString('ru-RU')} игр` : ''} — статистика OpenDota
          {res.statsAt ? ` от ${new Date(res.statsAt).toLocaleDateString('ru-RU')}` : ''}: проценты — оценка изменения шанса победы, это ориентир, а не
          обещание. Угрозы героев составлены вручную.
        </p>
      )}
    </>
  );
}

function HeroPicker({
  heroes,
  taken,
  onPick,
  disabled,
  testId,
  placeholder = 'Найти героя…',
}: {
  heroes: KbHero[];
  taken: ReadonlySet<string>;
  onPick: (key: string) => void;
  disabled?: boolean;
  testId: string;
  placeholder?: string;
}) {
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const matches = query ? heroes.filter((h) => !taken.has(h.key) && (h.name.toLowerCase().includes(query) || h.key.includes(query))).slice(0, 6) : [];
  const pick = (k: string) => {
    onPick(k);
    setQ('');
  };
  return (
    <div className="draft-picker">
      <input
        value={q}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && matches[0]) pick(matches[0].key);
        }}
        data-testid={testId}
      />
      {matches.length > 0 && (
        <div className="draft-matches">
          {matches.map((h) => (
            <button key={h.key} onClick={() => pick(h.key)}>
              {h.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
