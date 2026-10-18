// ===== Обновления (из обновления 0.5.0) =====
// «Установить» скачивает app.asar из релиза и ставит его (см. src/main/live/updater.ts).
import { useEffect, useState } from 'react';
import { useUpdate } from '../hooks/useUpdate';
import { Card, PageHeader } from '../components/ui';
import { Icon } from '../components/icons';

function fmtDate(iso: string | null): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch {
    return '';
  }
}

function fmtAgo(ms: number | null): string {
  if (!ms) return 'ещё не проверялось';
  const s = Math.max(0, Math.round((Date.now() - ms) / 1e3));
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.round(s / 60)} мин назад`;
  if (s < 86400) return `${Math.round(s / 3600)} ч назад`;
  return fmtDate(new Date(ms).toISOString());
}

/** Заметки релиза: строки «- …» превращаются в список, остальное — абзацы */
function ReleaseNotes({ text }: { text: string }) {
  if (!text) return null;
  const blocks: ({ list: string[] } | { p: string })[] = [];
  let list: string[] | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      list = null;
      continue;
    }
    const m = /^[-*•]\s+(.*)$/.exec(line);
    if (m) {
      if (!list) {
        list = [];
        blocks.push({ list });
      }
      list.push(m[1]!);
    } else {
      list = null;
      blocks.push({ p: line.replace(/^#+\s*/, '') });
    }
  }
  return (
    <div className="release-notes">
      {blocks.map((b, i) =>
        'list' in b ? (
          <ul key={i}>
            {b.list.map((x, j) => (
              <li key={j}>{x}</li>
            ))}
          </ul>
        ) : (
          <p key={i}>{b.p}</p>
        ),
      )}
    </div>
  );
}

export function UpdatesPage() {
  const u = useUpdate();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((x) => x + 1), 3e4);
    return () => clearInterval(t);
  }, []);
  if (!u) return <PageHeader title="Обновления" />;
  const working = u.status === 'downloading' || u.status === 'installing';
  const busy = u.status === 'checking' || working;
  const available = u.status === 'available' || working;
  const older = u.history.filter((h) => h.version !== u.latest?.version || !available);
  return (
    <>
      <PageHeader title="Обновления" subtitle="Новые версии коуча публикуются на GitHub. Коуч проверяет их сам при запуске и раз в 6 часов." />
      <section className={`card update-hero ${available ? 'is-new' : u.status === 'error' ? 'is-error' : 'is-ok'}`} data-testid="update-hero">
        <div className="update-hero-main">
          <div className="update-hero-icon" aria-hidden>
            <Icon name={available ? 'download' : u.status === 'error' ? 'alert' : u.status === 'checking' ? 'hourglass' : 'check'} size={22} />
          </div>
          <div className="update-hero-text">
            <div className="update-hero-title" data-testid="update-status">
              {available
                ? `Доступна версия ${u.latest?.version ?? ''}`
                : u.status === 'checking'
                  ? 'Проверяю обновления…'
                  : u.status === 'error'
                    ? 'Не удалось проверить обновления'
                    : u.status === 'idle'
                      ? 'Проверка ещё не выполнялась'
                      : 'Установлена последняя версия'}
            </div>
            <div className="muted">
              У вас <b>v{u.current}</b>
              {available && u.latest?.publishedAt ? ` · новая вышла ${fmtDate(u.latest.publishedAt)}` : ''} · проверено {fmtAgo(u.checkedAt)}
            </div>
          </div>
          <div className="update-hero-actions">
            {available && (
              <button className="primary" onClick={() => void window.dotacoach.installUpdate()} disabled={working} data-testid="update-install">
                Установить {u.latest?.version}
              </button>
            )}
            <button onClick={() => void window.dotacoach.checkForUpdates()} disabled={busy} data-testid="update-check">
              Проверить сейчас
            </button>
          </div>
        </div>
        {working && (
          <div className="update-progress" data-testid="update-progress">
            <div className="update-bar">
              <span style={{ width: `${u.status === 'installing' ? 100 : (u.progress ?? 0)}%` }} />
            </div>
            <span className="muted small">
              {u.status === 'installing' ? 'Устанавливаю — коуч закроется и откроется уже новой версией…' : `Скачиваю… ${u.progress ?? 0}%`}
            </span>
          </div>
        )}
        {u.error && (
          <p className="error" data-testid="update-error">
            {u.error}
          </p>
        )}
        {available && u.latest?.notes && (
          <div className="update-hero-notes">
            <div className="update-section-title">Что нового</div>
            <ReleaseNotes text={u.latest.notes} />
          </div>
        )}
      </section>
      {older.length > 0 && (
        <Card title="История версий">
          <ol className="release-list">
            {older.map((h) => (
              <li key={h.version} className={h.version === u.current ? 'current' : ''}>
                <div className="release-head">
                  <b>v{h.version}</b>
                  {h.version === u.current && <span className="pill pill-running">установлена</span>}
                  <span className="muted small">{fmtDate(h.publishedAt)}</span>
                </div>
                <ReleaseNotes text={h.notes} />
              </li>
            ))}
          </ol>
        </Card>
      )}
      <p className="muted small">
        «Установить» скачивает новую версию, сверяет контрольную сумму SHA-256 и перезапускает коуча. Если коуч стоит в Program Files,
        Windows попросит подтвердить права администратора.
        {u.repo ? ` Источник: github.com/${u.repo}` : ''}
      </p>
    </>
  );
}

/** Баннер на «Обзоре» */
export function UpdateBanner({ onOpen }: { onOpen: () => void }) {
  const u = useUpdate();
  if (!u || u.status !== 'available') return null;
  return (
    <button className="update-banner" onClick={onOpen} data-testid="update-banner">
      <span className="update-banner-dot" aria-hidden />
      <span>
        <b>Вышла версия {u.latest?.version}</b> — посмотрите, что нового
      </span>
      <span className="update-banner-go">Открыть →</span>
    </button>
  );
}

/** Всплывающее уведомление — один раз на каждую новую версию */
const TOAST_KEY = 'dc.update.toast.seen';
export function UpdateToast({ onOpen }: { onOpen: () => void }) {
  const u = useUpdate();
  const [seen, setSeen] = useState<string | null>(() => {
    try {
      return localStorage.getItem(TOAST_KEY);
    } catch {
      return null;
    }
  });
  const version = u?.status === 'available' ? (u.latest?.version ?? null) : null;
  const [leaving, setLeaving] = useState(false);
  if (!version || seen === version) return null;
  const close = (open: boolean) => {
    setLeaving(true);
    try {
      localStorage.setItem(TOAST_KEY, version);
    } catch {
      /* хранилище недоступно — покажем ещё раз */
    }
    setTimeout(() => setSeen(version), 220);
    if (open) onOpen();
  };
  return (
    <div className={`update-toast${leaving ? ' leaving' : ''}`} role="status" data-testid="update-toast">
      <div className="update-toast-icon" aria-hidden>
        <Icon name="download" size={18} />
      </div>
      <div className="update-toast-text">
        <b>Доступно обновление</b>
        <span className="muted small">Dota AI Coach {version}</span>
      </div>
      <button className="primary" onClick={() => close(true)} data-testid="update-toast-open">
        Посмотреть
      </button>
      <button className="update-toast-close" onClick={() => close(false)} aria-label="Закрыть">
        <Icon name="close" size={16} />
      </button>
    </div>
  );
}

export function UpdateNotice({ onOpen }: { onOpen: () => void }) {
  const u = useUpdate();
  if (!u || u.status !== 'available') return null;
  return (
    <button className="update-notice" onClick={onOpen} data-testid="update-notice">
      <Icon name="download" size={14} />
      Обновление {u.latest?.version}
    </button>
  );
}
