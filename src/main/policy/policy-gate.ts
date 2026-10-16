import type { AppMode, PolicyState } from '@shared/types/policy';

/**
 * Единственное место, где решается, какие режимы разрешены.
 * Живой захват окна Dota 2 — только наблюдение (включён решением владельца 2026-10-12, обновление 0.5.0).
 * Подсказки во время матчей разрешены решением владельца 2026-10-13 (docs/POLICY.md): включает и выключает
 * их сам пользователь в «Настройки → Live-подсказки» (settings.hints.enabled и settings.hints.ranked).
 * Правила Valve не проверены (этап J) — рядом с переключателем предупреждение о риске для аккаунта.
 */
const POLICY: Record<AppMode, { allowed: boolean; reason: string }> = {
  replay: { allowed: true, reason: 'Анализ заранее записанных кадров и видео.' },
  'live-observe': {
    allowed: true,
    reason: 'Живой захват окна Dota 2: только наблюдение, без подсказок во время матча.',
  },
  'live-coach-unranked': {
    allowed: true,
    reason: 'Подсказки в обычных матчах: поверх окна игры (не перекрывая HUD), по переключателю в настройках.',
  },
  'live-coach-ranked': {
    allowed: true,
    reason: 'Подсказки в рейтинговых матчах: по отдельному переключателю в настройках (риск для аккаунта — решает пользователь).',
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
