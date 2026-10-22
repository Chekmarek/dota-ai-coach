export type PageId = 'dashboard' | 'live' | 'hud' | 'replay' | 'match' | 'draft' | 'ai' | 'history' | 'kb' | 'sound' | 'voice' | 'updates' | 'settings';

export interface PageProps {
  onNavigate: (page: PageId) => void;
}
