// Индикатор режима игры в окне коуча (0.13.3): уведомление сверху «Режим игры — Турбо» в начале матча, при смене
// режима и сразу после выбора режима в настройках — чтобы было видно, что коуч считает игру тем режимом.
import { useEffect, useRef, useState } from 'react';
import type { ModeBanner } from '@shared/types/hud';
import { MODE_BANNER_MS } from '@shared/types/hud';
import { modeSub } from '../../hud/components/mode';
import { Icon, type IconName } from './icons';

const subs = new Set<(b: ModeBanner) => void>();
let localSeq = 1_000_000;

/** Показать уведомление (из окна коуча: выбор режима в настройках) */
export function showModeToast(b: Omit<ModeBanner, 'seq'>): void {
  const banner = { ...b, seq: ++localSeq };
  for (const fn of subs) fn(banner);
}

const ICON: Record<ModeBanner['mode'], IconName> = { turbo: 'bolt', 'all-pick': 'draft', other: 'layers', unknown: 'help' };

export function ModeToast() {
  const [b, setB] = useState<ModeBanner | null>(null);
  const [leaving, setLeaving] = useState(false);
  const lastSeq = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    const show = (next: ModeBanner) => {
      if (next.seq === lastSeq.current) return;
      lastSeq.current = next.seq;
      for (const t of timers.current) clearTimeout(t);
      setLeaving(false);
      setB(next);
      timers.current = [setTimeout(() => setLeaving(true), MODE_BANNER_MS - 300), setTimeout(() => setB(null), MODE_BANNER_MS)];
    };
    subs.add(show);
    const off = window.dotacoach.onCoachState((s) => {
      if (s.mode) show(s.mode);
    });
    return () => {
      subs.delete(show);
      off();
      for (const t of timers.current) clearTimeout(t);
    };
  }, []);

  if (!b) return null;
  return (
    <div className={`mode-toast mode-toast-${b.mode}${leaving ? ' leaving' : ''}`} role="status" aria-live="polite" data-testid="mode-toast" data-mode={b.mode}>
      <div className="mode-toast-icon" aria-hidden>
        <Icon name={ICON[b.mode]} size={22} />
      </div>
      <div className="mode-toast-text">
        <strong className="mode-toast-title" data-testid="mode-toast-title">
          {b.title}
        </strong>
        <span className="muted small">{modeSub(b)}</span>
      </div>
      <i className="mode-toast-bar" style={{ animationDuration: `${MODE_BANNER_MS}ms` }} />
    </div>
  );
}
