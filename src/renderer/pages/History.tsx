// «История советов» (этап 4): матчи с подсказками, ошибками (со временем — для перехода к записи), разборами
// смертей и итоговым разбором. Хранится только на этом ПК: <папка данных>/history, последние 50 матчей.
import { useEffect, useState } from 'react';
import type { HistoryMatch, HistorySummary } from '@shared/types/history';
import { Card, PageHeader } from '../components/ui';
import { gameModeRu } from '@core/gsi/mode.ts';

const mmss = (sec: number | null) => (sec === null ? '—' : `${sec < 0 ? '-' : ''}${Math.floor(Math.abs(sec) / 60)}:${String(Math.abs(Math.round(sec)) % 60).padStart(2, '0')}`);
const RESULT_RU = { win: 'Победа', loss: 'Поражение' } as const;
const VERDICT_RU = { good: 'хорошо', ok: 'нормально', bad: 'ниже ориентира' } as const;

export function History() {
  const [list, setList] = useState<HistorySummary[] | null>(null);
  const [current, setCurrent] = useState<HistoryMatch | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  // Фильтр по режиму: Турбо, обычные (по данным игры или выбран вручную), остальные — неизвестен/другой/не записан
  const [modeFilter, setModeFilter] = useState<'all' | 'turbo' | 'normal' | 'other'>('all');
  const modeKind = (m: HistorySummary): 'turbo' | 'normal' | 'other' => (m.gameMode?.mode === 'turbo' ? 'turbo' : m.gameMode?.mode === 'all-pick' ? 'normal' : 'other');
  const shown = (list ?? []).filter((m) => modeFilter === 'all' || modeKind(m) === modeFilter);

  const [onlyMarked, setOnlyMarked] = useState(false);
  const [key, setKey] = useState<{ key: string; bound: boolean } | null>(null);
  const [rev, setRev] = useState(0);
  const listed = shown.filter((m) => !onlyMarked || (m.badAdvice ?? 0) > 0);

  useEffect(() => {
    void window.dotacoach.listHistory().then((l) => {
      setList(l);
      setSelected((cur) => cur ?? l[0]?.id ?? null);
    });
  }, [rev]);
  // Новая отметка «плохой совет» (горячая клавиша) — перечитать список и открытый матч
  useEffect(() => window.dotacoach.onHistoryChanged(() => setRev((r) => r + 1)), []);
  useEffect(() => {
    void window.dotacoach.badAdviceShortcutStatus().then(setKey);
  }, []);
  useEffect(() => {
    if (selected) void window.dotacoach.getHistory(selected).then(setCurrent);
  }, [selected, rev]);

  return (
    <>
      <PageHeader title="История советов" subtitle="Подсказки, ошибки и разборы прошлых матчей. Хранится только на этом ПК (последние 50 матчей)." />
      <p className="muted small" data-testid="bad-advice-shortcut">
        {key && key.key
          ? `Плохой совет в игре — нажмите ${key.key}: коуч сохранит подсказки на экране и последние 15 с матча для разбора.${key.bound ? '' : ' Сейчас клавиша не работает: её заняла другая программа — выберите другую в настройках подсказок.'}`
          : 'Клавиша «плохой совет» выключена (настройки подсказок).'}
      </p>
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
            <label className="small">
              Режим:{' '}
              <select value={modeFilter} onChange={(e) => setModeFilter(e.target.value as typeof modeFilter)} data-testid="history-mode-filter">
                <option value="all">все</option>
                <option value="turbo">Турбо</option>
                <option value="normal">обычные</option>
                <option value="other">другие и неизвестные</option>
              </select>
            </label>
            <label className="small">
              {' '}
              <input type="checkbox" checked={onlyMarked} onChange={(e) => setOnlyMarked(e.target.checked)} data-testid="history-only-marked" /> только с отметками «плохой совет»
            </label>
            {listed.length === 0 && <p className="muted small">{onlyMarked ? 'Отмеченных матчей нет.' : 'Матчей этого режима нет.'}</p>}
            <ul className="history-list" data-testid="history-list">
              {listed.map((m) => (
                <li key={m.id}>
                  <button className={m.id === selected ? 'active' : ''} onClick={() => setSelected(m.id)}>
                    {new Date(m.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })} · {m.heroName ?? 'герой ?'} · {m.gameMode ? gameModeRu(m.gameMode) : 'режим не записан'}
                    <br />
                    <span className="muted small">
                      {m.result ? RESULT_RU[m.result] : 'без итога'} · {mmss(m.durationSec)} · советов {m.hints} · ошибок {m.mistakes} · смертей {m.deaths}
                      {(m.badAdvice ?? 0) > 0 && <b data-testid="history-marked-count"> · плохих советов {m.badAdvice}</b>}
                      {m.focus && (
                        <>
                          <br />
                          Фокус: {m.focus.title} — {m.focus.achieved === true ? 'получилось' : m.focus.achieved === false ? 'пока нет' : 'не измерен'}
                        </>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </Card>
          {current && (
            <div data-testid="history-match">
              <p className="muted small" data-testid="history-game-mode">
                Режим игры: {current.gameMode ? gameModeRu(current.gameMode) : 'не записан (матч до 0.13.3)'}
              </p>
              {current.focus && (
                <Card title={`Фокус матча: ${current.focus.title}`}>
                  <p data-testid="history-focus">
                    <b>{current.focus.achieved === true ? 'Получилось' : current.focus.achieved === false ? 'Пока нет' : 'Не удалось измерить'}</b>
                    {current.focus.value !== null && (
                      <>
                        {' '}
                        · {current.focus.value}
                        {current.focus.unit} (цель {current.focus.better === 'lower' ? 'не больше' : 'не меньше'} {current.focus.target}
                        {current.focus.unit})
                      </>
                    )}
                    {current.focus.prevAvg !== null && (
                      <>
                        {' '}
                        · в среднем раньше {current.focus.prevAvg}
                        {current.focus.unit}
                      </>
                    )}
                  </p>
                  <p className="muted small">{current.focus.keep}</p>
                </Card>
              )}
              {(current.badAdvice?.length ?? 0) > 0 && (
                <Card title={`Отмечено как плохой совет (${current.badAdvice!.length})`}>
                  <ul className="history-entries" data-testid="history-bad-advice">
                    {current.badAdvice!.map((b) => (
                      <li key={b.id}>
                        <span className="clock">{mmss(b.clock)}</span> {b.titles.length ? b.titles.join(' · ') : <span className="muted">на экране подсказок не было</span>}
                      </li>
                    ))}
                  </ul>
                  <p className="muted small">Собрать все отметки сессии в один файл для разбора: npm run bad-advice (docs/BAD_ADVICE.md).</p>
                </Card>
              )}
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
