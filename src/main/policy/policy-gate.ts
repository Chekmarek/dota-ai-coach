import type { AppMode, PolicyState } from '@shared/types/policy';

/**
 * Единственное место, где решается, какие режимы разрешены.
 * Живой захват окна Dota 2 — только наблюдение (включён решением владельца 2026-10-12, обновление 0.5.0).
 * Подсказки во время матчей по-прежнему жёстко выключены до этапа J (docs/POLICY.md):
 * допустимость по правилам Valve не установлена. Переключателя в UI нет намеренно.
 */
const POLICY: Record<AppMode, { allowed: boolean; reason: string }> = {
  replay: { allowed: true, reason: 'Анализ заранее записанных кадров и видео.' },
  'live-observe': {
    allowed: true,
    reason: 'Живой захват окна Dota 2: только наблюдение, без подсказок во время матча.',
  },
  'live-coach-unranked': {
    allowed: false,
    reason: 'Подсказки во время матча выключены до проверки правил Valve (этап J).',
  },
  'live-coach-ranked': {
    allowed: false,
    reason: 'Подсказки в рейтинговых матчах выключены до подтверждения допустимости (этап J).',
  },
};

export function isModeAllowed(mode: AppMode): boolean {
  return POLICY[mode].allowed;
}

export function getPolicyState(): PolicyState {
  return {
    activeMode: 'replay',
    modes: (Object.keys(POLICY) as AppMode[]).map((mode) => ({ mode, ...POLICY[mode] })),
  };
}
