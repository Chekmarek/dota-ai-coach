// Фильтр внимания на странице «Живая игра»: настройки (бюджет, порог уверенности, клавиша «не нужно») и панель
// отладки — сколько подсказок пришло от генераторов, сколько показано и почему остальные скрыты.
import { useEffect, useState } from 'react';
import { GATE_MUTE_SHORTCUT_DEFAULT, acceleratorOf, isSafeBadAdviceShortcut, type Settings, type SettingsPatch } from '@shared/schemas/settings';
import { CALM_RU, SUPPRESS_REASONS, SUPPRESS_RU, type GateDebug } from '@core/gate/types.ts';

const OUTCOME_RU = { shown: 'показана', ...SUPPRESS_RU } as const;
const PRIORITY_RU = { critical: 'срочно', useful: 'полезно', info: 'инфо' } as const;

export function GateSettings({ settings, update }: { settings: Settings; update: (p: SettingsPatch) => Promise<void> }) {
  const g = settings.gate;
  const [hint, setHint] = useState<string | null>(null);
  return (
    <>
      <label className="check">
        <input type="checkbox" checked={g.enabled} onChange={(e) => void update({ gate: { enabled: e.target.checked } })} data-testid="gate-enabled" />
        Фильтр внимания: меньше подсказок и вовремя
      </label>
      <p className="muted small">
        В драке — только срочное. Остальное ждёт спокойного момента (смерть, база, путь на базу, затишье), коротко: 1–3 слова и одна причина с
        числом. Подробности — когда вы мертвы или на базе.
      </p>
      <label>
        Не чаще одной несрочной подсказки в: {g.budgetSec} с
        <input type="range" min={20} max={180} step={5} value={g.budgetSec} disabled={!g.enabled} onChange={(e) => void update({ gate: { budgetSec: Number(e.target.value) } })} data-testid="gate-budget" />
      </label>
      <label>
        Показывать в игре при уверенности от: {Math.round(g.minConfidence * 100)}%
        <input type="range" min={0.3} max={0.95} step={0.05} value={g.minConfidence} disabled={!g.enabled} onChange={(e) => void update({ gate: { minConfidence: Number(e.target.value) } })} data-testid="gate-confidence" />
      </label>
      <p className="muted small">Менее уверенные советы не мешают в игре — они попадают в разбор матча.</p>
      <label>
        Клавиша «не нужно»
        <input
          readOnly
          value={g.muteShortcut || 'выключена'}
          disabled={!g.enabled}
          data-testid="gate-mute-shortcut"
          onKeyDown={(e) => {
            if (e.key === 'Tab') return;
            e.preventDefault();
            const acc = acceleratorOf(e);
            if (!acc) return setHint('Нажмите сочетание: Ctrl/Alt + F1…F12, или два модификатора + буква/цифра.');
            if (!isSafeBadAdviceShortcut(acc)) return setHint(`${acc} не подходит: нужен Ctrl или Alt, а с буквой или цифрой — два модификатора.`);
            if (acc === settings.hints.badAdviceShortcut) return setHint(`${acc} уже занято клавишей «плохой совет».`);
            if (acc === settings.sound.shortcut) return setHint(`${acc} уже занято клавишей «звук вкл/выкл».`);
            setHint(null);
            void update({ gate: { muteShortcut: acc } });
          }}
        />
      </label>
      <p className="muted small">
        Подсказка не нужна — нажмите в игре: этот тип молчит до конца матча. Отключали в трёх матчах — он больше не срочный.{' '}
        <button className="link" onClick={() => void update({ gate: { muteShortcut: GATE_MUTE_SHORTCUT_DEFAULT } })}>
          По умолчанию ({GATE_MUTE_SHORTCUT_DEFAULT})
        </button>{' '}
        <button className="link" onClick={() => void update({ gate: { muteShortcut: '' } })}>
          Выключить
        </button>
      </p>
      {hint && <p className="warn small">{hint}</p>}
    </>
  );
}

/** Панель отладки: обновляется раз в секунду, пока открыта */
export function GateDebugPanel() {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<{ debug: GateDebug | null; shortcut: { key: string; bound: boolean } } | null>(null);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    const load = () => void window.dotacoach.gateDebug().then((d) => alive && setData(d));
    load();
    const t = setInterval(load, 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [open]);
  const d = data?.debug ?? null;
  const suppressedTotal = d ? Object.values(d.suppressed).reduce((a, b) => a + (b ?? 0), 0) : 0;
  return (
    <details className="gate-debug" onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)} data-testid="gate-debug">
      <summary>Отладка фильтра: что пришло, что показано, что скрыто</summary>
      {!d ? (
        <p className="muted small">Фильтр начнёт считать, когда придут данные матча.</p>
      ) : (
        <>
          <p className="small">
            {!d.enabled && <b className="warn">Фильтр выключен — подсказки идут как раньше. </b>}
            Сейчас: <b>{d.moment.fight ? `драка (${d.moment.why.join(', ')})` : d.moment.calm ? `спокойно — ${CALM_RU[d.moment.calm]}` : 'занят'}</b>
            {' · '}несрочная — {d.budgetInSec ? `через ${d.budgetInSec} с` : 'можно'}
            {' · '}ждут: {d.waiting}
          </p>
          <div className="stats">
            <span>
              Пришло: <b data-testid="gate-received">{d.received}</b>
            </span>{' '}
            <span>
              Показано: <b data-testid="gate-shown">{d.shown}</b>
            </span>{' '}
            <span>
              Скрыто: <b>{suppressedTotal}</b>
            </span>
          </div>
          <ul className="small">
            {SUPPRESS_REASONS.filter((r) => d.suppressed[r]).map((r) => (
              <li key={r}>
                {SUPPRESS_RU[r]}: {d.suppressed[r]}
              </li>
            ))}
          </ul>
          {(d.muted.length > 0 || d.demoted.length > 0) && (
            <p className="small muted">
              {d.muted.length > 0 && <>«Не нужно» в этом матче: {d.muted.join(', ')}. </>}
              {d.demoted.length > 0 && <>Понижены до «инфо»: {d.demoted.join(', ')}.</>}
            </p>
          )}
          {d.deferred.length > 0 && <p className="small muted">В разбор матча (низкая уверенность): {d.deferred.map((x) => `${x.short} ×${x.count}`).join(', ')}</p>}
          <table className="small gate-recent">
            <tbody>
              {d.recent.map((r, i) => (
                <tr key={i} className={r.outcome === 'shown' ? '' : 'muted'}>
                  <td>{new Date(r.atMs).toLocaleTimeString()}</td>
                  <td>{PRIORITY_RU[r.priority]}</td>
                  <td>{r.short}</td>
                  <td>{OUTCOME_RU[r.outcome]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      {data && data.shortcut.key && !data.shortcut.bound && <p className="warn small">Клавиша «не нужно» ({data.shortcut.key}) не занята — её перехватила другая программа или она совпала с другой клавишей коуча.</p>}
    </details>
  );
}
