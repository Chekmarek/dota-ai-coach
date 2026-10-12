export type PageId = 'dashboard' | 'live' | 'replay' | 'match' | 'history' | 'kb' | 'voice' | 'updates' | 'settings';

export interface PageProps {
  onNavigate: (page: PageId) => void;
}
