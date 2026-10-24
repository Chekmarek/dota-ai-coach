// «Прогресс»: звание и опыт, серия фокусов, достижения, как меняются три частые ошибки, честная статистика
// доверия к советам. Читается за 10 секунд: крупно главное, мелко — пояснения. Данные — только из ваших матчей.
import { useEffect, useState } from 'react';
import type { ProgressView } from '@core/progress/index.ts';
import { Card, PageHeader } from '../components/ui';
import type { PageProps } from './types';

function useProgress(): ProgressView | null {
  const [v, setV] = useState<ProgressView | null>(null);
  useEffect(() => {
    const load = () => void window.dotacoach.getProgress().then(setV);
    load();
    // после матча прогресс меняется — перечитать
    return window.dotacoach.onProgressAward(() => load());
  }, []);
  return v;
}

/** Столбики «сколько раз за матч» по последним матчам: старые слева */
function Bars({ values }: { values: number[] }) {
  const max = Math.max(1, ...values);
  const w = 8;
  const gap = 3;
  const h = 32;
  return (
    <svg className="pg-bars" width={values.length * (w + gap)} height={h} role="img" aria-label={`по матчам: ${values.join(', ')}`}>
      {values.map((v, i) => {
        const bh = v === 0 ? 2 : Math.max(3, (v / max) * h);
        return <rect key={i} x={i * (w + gap)} y={h - bh} width={w} height={bh} rx={2} className={v === 0 ? 'pg-bar-zero' : 'pg-bar'} />;
      })}
    </svg>
  );
}

const fmt = (n: number) => String(n).replace('.', ',');

export function Progress(_: PageProps) {
  const p = useProgress();
  if (!p) return null;
  const lv = p.level;
  const pct = lv.need ? Math.round((100 * lv.into) / lv.need) : 100;
  const earned = p.achievements.filter((a) => a.earnedAt);
  return (
    <>
      <PageHeader title="Прогресс" subtitle="Опыт — только за то, что вы стали играть лучше: выполненный фокус, выполненные советы, ошибки, которые стали реже." />
      {p.matches === 0 && <p className="muted" data-testid="progress-empty">Сыграйте матч с коучем — здесь появятся звание, серия и статистика.</p>}
      <div className="pg-top">
        <Card title="Звание">
          <div className="pg-level" data-testid="progress-level">
            {lv.name}
          </div>
          <div className="pg-xpbar" aria-label={`опыт ${lv.into} из ${lv.need ?? lv.into}`}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="muted small">{lv.need ? `${lv.into} / ${lv.need} опыта до следующего · всего ${lv.total}` : `всего ${lv.total} опыта`}</div>
        </Card>
        <Card title="Серия фокусов">
          <div className="pg-streak" data-testid="progress-streak">
            {p.streak.current}
            <span className="small muted"> подряд · лучшая {p.streak.best}</span>
          </div>
          <div className="small">{p.streak.shieldReady ? '🛡 Щит готов: один промах серию не оборвёт' : `🛡 Щит восстановится через ${p.streak.shieldIn} ${p.streak.shieldIn === 1 ? 'матч' : 'матча'}`}</div>
        </Card>
      </div>

      <Card title={`Достижения · ${earned.length} из ${p.achievements.length}`}>
        <ul className="pg-ach" data-testid="progress-achievements">
          {p.achievements.map((a) => (
            <li key={a.id} className={a.earnedAt ? 'pg-ach-on' : 'pg-ach-off'} title={a.how}>
              <b>{a.earnedAt ? '★ ' : ''}{a.title}</b>
              <span className="small muted">{a.how}</span>
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Частые ошибки по матчам">
        {p.trends.length === 0 ? (
          <p className="muted small">Мало матчей — нужно хотя бы два законченных.</p>
        ) : (
          <ul className="pg-trends" data-testid="progress-trends">
            {p.trends.map((t) => (
              <li key={t.type}>
                <div>
                  <b>{t.title}</b>
                  <div className={`small pg-dir-${t.direction}`}>
                    {t.direction === 'down' ? '↓ реже' : t.direction === 'up' ? '↑ чаще' : '→ без изменений'}: {fmt(t.before)} → {fmt(t.after)} за матч
                  </div>
                </div>
                <Bars values={t.perMatch} />
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="Стоит ли слушать коуча">
        {p.trust.length === 0 ? (
          <p className="muted small">Пока нет советов, по которым можно проверить, выжили ли вы.</p>
        ) : (
          <ul className="pg-trust" data-testid="progress-trust">
            {p.trust.map((t) => (
              <li key={t.advice}>
                {t.enough ? (
                  <>
                    Когда вы следовали совету «{t.advice}», вы выживали в <b>{t.followedPct}%</b> случаев, когда нет — в <b>{t.ignoredPct}%</b>.
                    <span className="small muted"> ({t.followed.n} и {t.ignored.n} случаев)</span>
                  </>
                ) : (
                  <>
                    «{t.advice}»: мало данных — {t.followed.n} раз следовали, {t.ignored.n} нет; нужно хотя бы по {p.trustMin}.
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {p.recent.some((r) => r.total > 0) && (
        <Card title="Опыт за последние матчи">
          <ul className="pg-recent">
            {p.recent
              .filter((r) => r.total > 0)
              .map((r) => (
                <li key={r.key}>
                  <span className="muted small">{new Date(r.startedAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' })}</span> <b>+{r.total}</b>{' '}
                  <span className="small">{r.items.map((i) => i.label).join(' · ')}</span>
                </li>
              ))}
          </ul>
        </Card>
      )}
    </>
  );
}

/** После матча — опыт и за что: появляется в окне коуча, строки по очереди; «Пропустить» или само через 12 с */
export function AwardToast({ onOpen }: { onOpen: () => void }) {
  const [a, setA] = useState<Parameters<Parameters<typeof window.dotacoach.onProgressAward>[0]>[0] | null>(null);
  useEffect(() => window.dotacoach.onProgressAward(setA), []);
  useEffect(() => {
    if (!a) return;
    const t = setTimeout(() => setA(null), 12_000);
    return () => clearTimeout(t);
  }, [a]);
  if (!a) return null;
  const up = a.after.level > a.before.level;
  return (
    <div className="pg-toast" role="status" data-testid="award-toast" onClick={() => setA(null)}>
      <div className="pg-toast-total">{a.award.total ? `+${a.award.total} опыта` : 'Опыта за матч нет'}</div>
      {up && <div className="pg-toast-up">Новое звание: {a.after.name}</div>}
      <ul>
        {a.award.items.map((i, n) => (
          <li key={n} style={{ animationDelay: `${300 + n * 250}ms` }}>
            <span>{i.label}</span> <b>+{i.xp}</b>
          </li>
        ))}
      </ul>
      {!a.award.items.length && <p className="small muted">Опыт — только за выполненный фокус, советы и ошибки, которые стали реже.</p>}
      {a.achievements.map((x) => (
        <div key={x.id} className="pg-toast-ach">★ {x.title}</div>
      ))}
      <div className="row">
        <button onClick={() => setA(null)} data-testid="award-skip">
          Пропустить
        </button>
        <button className="primary" onClick={(e) => (e.stopPropagation(), setA(null), onOpen())}>
          Прогресс
        </button>
      </div>
    </div>
  );
}
