// «История советов» (этап 4): матчи с подсказками, ошибками (со временем — для перехода к записи), разборами
// смертей и итоговым разбором. Хранится только на этом ПК: <папка данных>/history, последние 50 матчей.
import { useEffect, useState } from 'react';
import type { HistoryMatch, HistorySummary } from '@shared/types/history';
import { Card, PageHeader } from '../components/ui';

const mmss = (sec: number | null) => (sec === null ? '—' : `${sec < 0 ? '-' : ''}${Math.floor(Math.abs(sec) / 60)}:${String(Math.abs(Math.round(sec)) % 60).padStart(2, '0')}`);
const RESULT_RU = { win: 'Победа', loss: 'Поражение' } as const;
const VERDICT_RU = { good: 'хорошо', ok: 'нормально', bad: 'ниже ориентира' } as const;

export function History() {
  const [list, setList] = useState<HistorySummary[] | null>(null);
  const [current, setCurrent] = useState<HistoryMatch | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    void window.dotacoach.listHistory().then((l) => {
      setList(l);
      if (l[0]) setSelected(l[0].id);
    });
  }, []);
  useEffect(() => {
    if (selected) void window.dotacoach.getHistory(selected).then(setCurrent);
  }, [selected]);

  return (
    <>
      <PageHeader title="История советов" subtitle="Подсказки, ошибки и разборы прошлых матчей. Хранится только на этом ПК (последние 50 матчей)." />
      {list && list.length === 0 && (
        <Card>
          <p className="muted" data-testid="history-empty">
            Пока пусто: история появится после первого матча с включёнными подсказками.
          </p>
        </Card>
      )}
      {list && list.length > 0 && (
        <div className="history-layout">
          <Card title="Матчи">
            <ul className="history-list" data-testid="history-list">
              {list.map((m) => (
                <li key={m.id}>
                  <button className={m.id === selected ? 'active' : ''} onClick={() => setSelected(m.id)}>
                    {new Date(m.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })} · {m.heroName ?? 'герой ?'}
                    <br />
                    <span className="muted small">
                      {m.result ? RESULT_RU[m.result] : 'без итога'} · {mmss(m.durationSec)} · советов {m.hints} · ошибок {m.mistakes} · смертей {m.deaths}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {current && (
            <div data-testid="history-match">
              {current.matchReview && (
                <Card title={`Разбор матча: ${current.matchReview.result ? RESULT_RU[current.matchReview.result] : 'итог неизвестен'}`}>
                  {current.matchReview.aiText && <p>{current.matchReview.aiText}</p>}
                  <ul>
                    {current.matchReview.why.map((w) => (
                      <li key={w}>{w}</li>
                    ))}
                  </ul>
                  {current.matchReview.goodPlays.length > 0 && (
                    <>
                      <h4>Удачно</h4>
                      <ul>
                        {current.matchReview.goodPlays.map((g) => (
                          <li key={g}>{g}</li>
                        ))}
                      </ul>
                    </>
                  )}
                  <table className="kb-table">
                    <tbody>
                      {current.matchReview.stats.map((s) => (
                        <tr key={s.label}>
                          <td>{s.label}</td>
                          <td>{s.value ?? '—'}</td>
                          <td className="muted">{s.ref !== null ? `ориентир ${s.ref} (${s.refLabel})` : ''}</td>
                          <td>{s.verdict ? VERDICT_RU[s.verdict] : ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <h4>Цели на следующую игру</h4>
                  <ol>
                    {current.matchReview.goals.map((g) => (
                      <li key={g}>{g}</li>
                    ))}
                  </ol>
                </Card>
              )}
              <Card title={`Ошибки (${current.mistakes.length})`}>
                {current.mistakes.length === 0 ? (
                  <p className="muted small">Ошибок не замечено.</p>
                ) : (
                  <ul className="history-entries">
                    {current.mistakes.map((m, i) => (
                      <li key={i}>
                        <span className="clock">{mmss(m.clock)}</span> <b>{m.titleRu}:</b> {m.text}. <span className="muted">{m.aiText ?? m.instead}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </Card>
              {current.deathReviews.length > 0 && (
                <Card title={`Смерти (${current.deathReviews.length})`}>
                  <ul className="history-entries">
                    {current.deathReviews.map((d, i) => (
                      <li key={i}>
                        <span className="clock">{mmss(d.clock)}</span> {d.why.join('; ')}. <span className="muted">{d.aiText ?? d.tips.join(' ')}</span>
                      </li>
                    ))}
                  </ul>
                </Card>
              )}
              <Card title={`Подсказки (${current.entries.filter((e) => e.kind === 'hint').length})`}>
                <ul className="history-entries" data-testid="history-entries">
                  {current.entries
                    .filter((e) => e.kind === 'hint')
                    .map((e, i) => (
                      <li key={i}>
                        <span className="clock">{mmss(e.clock)}</span> {e.text}
                        {e.source === 'ai' ? <span className="muted"> · ИИ</span> : null}
                      </li>
                    ))}
                </ul>
              </Card>
            </div>
          )}
        </div>
      )}
    </>
  );
}
