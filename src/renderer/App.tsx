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
import { ModeToast } from './components/mode-toast';
import type { PageId, PageProps } from './pages/types';
import { VoiceSettings } from './pages/VoiceSettings';
import { AppSettings } from './pages/AppSettings';
import { ReplayMode } from './pages/ReplayMode';
import { AiAssistant } from './pages/AiAssistant';
import { HudPreview } from './pages/HudPreview';
import { Draft } from './pages/Draft';
import { BrandMark, Icon, type IconName } from './components/icons';

// Вкладка «Диагностика зрения» убрана в обновлении 0.5.0 (решение команды): распознавание HUD теперь
// показывается в «Живой игре» и в «Разборе записи».
// Меню — группами: игра сейчас, разбор после, справка, система.
const PAGES: readonly { id: PageId; label: string; icon: IconName; group: string; Component: ComponentType<PageProps> }[] = [
  { id: 'dashboard', label: 'Обзор', icon: 'dashboard', group: 'Игра', Component: Dashboard },
  { id: 'live', label: 'Живая игра', icon: 'live', group: 'Игра', Component: LiveGame },
  { id: 'match', label: 'Состояние матча', icon: 'match', group: 'Игра', Component: MatchState },
  { id: 'draft', label: 'Драфт', icon: 'draft', group: 'Игра', Component: Draft },
  { id: 'hud', label: 'Подсказки в игре', icon: 'layers', group: 'Игра', Component: HudPreview },
  { id: 'replay', label: 'Разбор записи', icon: 'replay', group: 'Разбор', Component: ReplayMode },
  { id: 'history', label: 'История советов', icon: 'history', group: 'Разбор', Component: History },
  { id: 'ai', label: 'ИИ-помощник', icon: 'sparkles', group: 'Разбор', Component: AiAssistant },
  { id: 'kb', label: 'База знаний', icon: 'book', group: 'Разбор', Component: KnowledgeBase },
  { id: 'voice', label: 'Голос', icon: 'mic', group: 'Система', Component: VoiceSettings },
  { id: 'updates', label: 'Обновления', icon: 'download', group: 'Система', Component: UpdatesPage },
  { id: 'settings', label: 'Настройки', icon: 'settings', group: 'Система', Component: AppSettings },
];
const GROUPS = [...new Set(PAGES.map((p) => p.group))];

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
          <BrandMark />
          <div>
            <div className="brand-name">Dota AI Coach</div>
            <div className="brand-sub">{liveOn ? 'живой режим' : 'режим записей'}</div>
          </div>
        </div>
        <nav>
          {GROUPS.map((g) => (
            <div className="nav-group" key={g}>
              <div className="nav-group-label">{g}</div>
              {PAGES.filter((p) => p.group === g).map((p) => (
                <button
                  key={p.id}
                  className={`nav-item${p.id === page ? ' active' : ''}`}
                  onClick={() => setPage(p.id)}
                  aria-current={p.id === page ? 'page' : undefined}
                  data-testid={`nav-${p.id}`}
                >
                  <Icon name={p.icon} className="nav-icon" />
                  {p.label}
                  {p.id === 'updates' && updateAvailable && <span className="nav-dot" data-testid="nav-update-dot" title="Доступно обновление" />}
                </button>
              ))}
            </div>
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
      <ModeToast />
    </div>
  );
}
