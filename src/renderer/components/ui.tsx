import type { ReactNode } from 'react';
import type { CaptureState } from '@shared/types/capture';

export function Card({ title, children, actions }: { title?: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {(title || actions) && (
        <header className="card-head">
          {title && <h3>{title}</h3>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/** Честная пометка: функция ещё не реализована. Используется везде, где нет реальной работы. */
export function NotImplemented({ stage, children }: { stage: string; children: ReactNode }) {
  return (
    <div className="not-impl" role="note" data-testid="not-implemented">
      <span className="not-impl-badge">Не реализовано · {stage}</span>
      <p>{children}</p>
    </div>
  );
}

const STATE_LABEL: Record<CaptureState, string> = {
  idle: 'Ожидание',
  starting: 'Запуск…',
  running: 'Работает',
  paused: 'Пауза',
  ended: 'Запись закончилась',
  stopped: 'Остановлено',
  error: 'Ошибка',
};

export function StatePill({ state }: { state: CaptureState | null }) {
  const s = state ?? 'idle';
  return (
    <span className={`pill pill-${s}`} data-testid="capture-state" data-state={s}>
      {state ? STATE_LABEL[s] : 'Нет связи с движком'}
    </span>
  );
}

export function Stat({ label, value, hint, testId }: { label: string; value: ReactNode; hint?: string; testId?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-label">{label}</div>
      <div className="stat-value" data-testid={testId}>
        {value}
      </div>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <header className="page-head">
      <h1>{title}</h1>
      {subtitle && <p>{subtitle}</p>}
    </header>
  );
}
