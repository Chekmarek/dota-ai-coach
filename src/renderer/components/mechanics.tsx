// Механика карты в интерфейсе: вкладка «Механика» базы знаний и карточка «Ближайшие события» для «Состояния матча».
// Только данные с источниками; советов здесь нет (это этап F).
import { useMemo, useState } from 'react';
import type { MechanicsEntry, MechanicsValue } from '@shared/types/mechanics';
import { MECHANICS_CATEGORIES } from '@shared/types/mechanics';
import { formatKbNumber } from '@core/knowledge-base/format.ts';
import { upcomingEvents, type TimerEvent } from '@core/knowledge-base/timers.ts';
import { formatClock } from '@core/vision/hud-fields.ts';
import { Card } from './ui';

const UNIT: Record<string, string> = {
  gold: ' золота',
  xp: ' опыта',
  mana: ' маны',
  '%': '%',
  'gold/min': ' в минуту',
  'hp/s': ' в секунду',
};

/** Значение с единицами: секунды ≥ 60 — ещё и как время «м:сс»; null — «нет данных» */
export function formatMechanicsValue(v: MechanicsValue): string {
  if (v.value === null) return 'нет данных';
  if (typeof v.value === 'string') return v.value;
  const n = formatKbNumber(v.value);
  if (v.unit === 's') return Math.abs(v.value) >= 60 && Number.isInteger(v.value) ? `${formatClock(v.value)} (${n} с)` : `${n} с`;
  return n + (UNIT[v.unit ?? ''] ?? '');
}

function VerificationBadge({ e }: { e: MechanicsEntry }) {
  if (e.verification === 'verified') return <span className="pill mech-verified" data-testid="mech-verified">проверено по Valve</span>;
  if (e.verification === 'missing') return <span className="pill mech-missing">нет данных</span>;
  return (
    <span className="pill mech-unverified" data-testid="mech-unverified">
      не проверено
    </span>
  );
}

export function MechanicsTab({ entries, warnings }: { entries: MechanicsEntry[]; warnings: string[] }) {
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const match = (e: MechanicsEntry) =>
      !q || [e.nameRu, e.notesRu, ...e.values.map((v) => `${v.labelRu} ${v.value ?? ''}`)].some((s) => s.toLowerCase().includes(q));
    const known = new Set(MECHANICS_CATEGORIES.map((c) => c.id));
    const cats = [...MECHANICS_CATEGORIES, ...[...new Set(entries.map((e) => e.category))].filter((c) => !known.has(c)).map((id) => ({ id, nameRu: id }))];
    return cats.map((c) => ({ ...c, entries: entries.filter((e) => e.category === c.id && match(e)) })).filter((g) => g.entries.length > 0);
  }, [entries, q]);

  const counts = entries.reduce<Record<string, number>>((m, e) => ((m[e.verification] = (m[e.verification] ?? 0) + 1), m), {});
  return (
    <div data-testid="kb-mechanics">
      <div className="row gap">
        <input placeholder="Поиск по механике…" value={query} onChange={(e) => setQuery(e.target.value)} data-testid="mech-search" style={{ minWidth: 240 }} />
        <span className="muted small">
          Записей: {entries.length} · проверено по Valve: {counts.verified ?? 0} · не проверено: {counts['imported-unverified'] ?? 0} · нет данных:{' '}
          {counts.missing ?? 0}
        </span>
      </div>
      {warnings.length > 0 && (
        <p className="warn small" data-testid="mech-warnings">
          {warnings.join(' ')}
        </p>
      )}
      {entries.length === 0 && <p className="muted">Механики нет в этой копии базы знаний.</p>}
      {groups.map((g) => (
        <Card key={g.id} title={g.nameRu}>
          <div className="mech-list">
            {g.entries.map((e) => (
              <div key={e.id} className="mech-entry" data-testid={`mech-${e.id}`}>
                <div className="row gap">
                  <b>{e.nameRu}</b>
                  <VerificationBadge e={e} />
                </div>
                <table className="mech-values">
                  <tbody>
                    {e.values.map((v) => (
                      <tr key={v.key} className={v.value === null ? 'muted' : undefined}>
                        <td>{v.labelRu}</td>
                        <td className="mono">{formatMechanicsValue(v)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {e.notesRu && <p className="kb-desc">{e.notesRu}</p>}
                <div className="muted small">
                  Источник:{' '}
                  <a href={e.source.url} target="_blank" rel="noreferrer">
                    {e.source.name}
                  </a>
                  {e.source.license ? ` (${e.source.license})` : ''} · патч: {e.patch ?? 'не указан'} · получено {e.retrievedAt.slice(0, 10)}
                </div>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </div>
  );
}

function eventWhen(e: TimerEvent): string {
  switch (e.status) {
    case 'missing':
      return 'нет данных';
    case 'ended':
      return 'больше не будет';
    case 'removed':
      return e.detailRu ?? 'нет в игре';
    case 'unknown':
      return 'нужно время смерти';
    case 'available':
      return e.detailRu ?? 'уже доступен';
    case 'ok': {
      const at = e.at as number;
      const range = e.until !== null ? `${formatClock(at)}–${formatClock(e.until)}` : formatClock(at);
      const inText = e.inSec === 0 ? 'сейчас' : `через ${formatClock(e.inSec ?? 0)}`;
      return `${range} · ${inText}${e.detailRu ? ` · ${e.detailRu}` : ''}`;
    }
  }
}

/** «Ближайшие события» по игровым часам; показывается только когда часы известны */
export function UpcomingEventsCard({ clockSec, entries }: { clockSec: number; entries: MechanicsEntry[] }) {
  const events = upcomingEvents(entries, Math.trunc(clockSec));
  // Ближайшие сверху; события без времени — в конце
  const sorted = [...events].sort((a, b) => (a.inSec ?? Infinity) - (b.inSec ?? Infinity));
  return (
    <Card title="Ближайшие события">
      <table className="table mech-upcoming" data-testid="upcoming-events">
        <tbody>
          {sorted.map((e) => (
            <tr key={e.id} data-testid={`upcoming-${e.id}`} data-status={e.status}>
              <td>{e.nameRu}</td>
              <td className="mono">{eventWhen(e)}</td>
              <td className="small">{e.verification && e.verification !== 'verified' && e.status !== 'missing' ? <span className="pill mech-unverified">не проверено</span> : null}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted small">По базе знаний текущего патча. Окно возрождения Рошана и Мучителя считается от времени их смерти — коуч его пока не узнаёт.</p>
    </Card>
  );
}
