/**
 * Режимы работы приложения. В v1 разрешён только `replay`.
 * Остальные режимы включаются только после документированного решения (docs/POLICY.md, этап J).
 */
export type AppMode = 'replay' | 'live-observe' | 'live-coach-unranked' | 'live-coach-ranked';

export interface ModePolicy {
  mode: AppMode;
  allowed: boolean;
  reason: string;
}

export interface PolicyState {
  activeMode: AppMode;
  modes: ModePolicy[];
}
