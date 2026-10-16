import { useState, type ComponentType } from 'react';
import { useEngine } from './hooks/useEngine';
import { useSettings } from './hooks/useSettings';
import { useUpdate } from './hooks/useUpdate';
import { StatePill } from './components/ui';
import { LivePill, isLive, useLiveAutoStart } from './components/live';
import { GsiSidebarPill } from './components/gsi';
import { Dashboard } from './pages/Dashboard';
import { LiveGame } from './pages/LiveGame';
import { History } from './pages/History';
import { MatchState } from './pages/MatchState';
import { KnowledgeBase } from './pages/KnowledgeBase';
import { UpdateNotice, UpdatesPage, UpdateToast } from './pages/Updates';
import type { PageId, PageProps } from './pages/types';
import { VoiceSettings } from './pages/VoiceSettings';
import { AppSettings } from './pages/AppSettings';
import { ReplayMode } from './pages/ReplayMode';
import { AiAssistant } from './pages/AiAssistant';
import { HudPreview } from './pages/HudPreview';

// Вкладка «Диагностика зрения» убрана в обновлении 0.5.0 (решение команды): распознавание HUD теперь
// показывается в «Живой игре» и в «Разборе записи».
const PAGES: readonly { id: PageId; label: string; icon: string; Component: ComponentType<PageProps> }[] = [
  { id: 'dashboard', label: 'Обзор', icon: '◈', Component: Dashboard },
  { id: 'live', label: 'Живая игра', icon: '●', Component: LiveGame },
  { id: 'hud', label: 'Предпросмотр подсказок', icon: '◇', Component: HudPreview },
  { id: 'replay', label: 'Разбор записи', icon: '▶', Component: ReplayMode },
  { id: 'match', label: 'Состояние матча', icon: '▦', Component: MatchState },
  { id: 'ai', label: 'ИИ-помощник', icon: '✦', Component: AiAssistant },
  { id: 'history', label: 'История советов', icon: '☰', Component: History },
  { id: 'kb', label: 'База знаний', icon: '◆', Component: KnowledgeBase },
  { id: 'voice', label: 'Голос', icon: '♪', Component: VoiceSettings },
  { id: 'updates', label: 'Обновления', icon: '⬆', Component: UpdatesPage },
  { id: 'settings', label: 'Настройки', icon: '⚙', Component: AppSettings },
];

export function App() {
  const [page, setPage] = useState<PageId>('dashboard');
  const { status, connected } = useEngine();
  const { settings } = useSettings();
  useLiveAutoStart(status, connected, settings);
  const upd = useUpdate();
  const updateAvailable = upd?.status === 'available';
  const liveOn = isLive(status);
  const Current = PAGES.find((p) => p.id === page)!.Component;

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">D</span>
          <div>
            <div className="brand-name">Dota AI Coach</div>
            <div className="brand-sub">{liveOn ? 'живой режим' : 'режим записей'}</div>
          </div>
        </div>
        <nav>
          {PAGES.map((p) => (
            <button key={p.id} className={`nav-item${p.id === page ? ' active' : ''}`} onClick={() => setPage(p.id)} data-testid={`nav-${p.id}`}>
              <span className="nav-icon" aria-hidden>
                {p.icon}
              </span>
              {p.label}
              {p.id === 'updates' && updateAvailable && <span className="nav-dot" data-testid="nav-update-dot" title="Доступно обновление" />}
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <UpdateNotice onOpen={() => setPage('updates')} />
          {liveOn ? <LivePill live={status.live} /> : <StatePill state={status?.state ?? null} />}
          <GsiSidebarPill />
          {status && status.state === 'running' && (
            <div className="muted small">
              {status.measuredFps} к/с · обработка {status.processingFps} к/с
            </div>
          )}
        </div>
      </aside>
      <main className="content" data-testid={`page-${page}`}>
        <Current onNavigate={setPage} />
      </main>
      {page !== 'updates' && <UpdateToast onOpen={() => setPage('updates')} />}
    </div>
  );
}
