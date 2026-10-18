// Позиция игрока 1–5 и настройка «Моя позиция» — отдельно от контекста игры, чтобы настройки и интерфейс не тянули
// за собой логику матча.
export type Position = 1 | 2 | 3 | 4 | 5;
export const POSITION_OVERRIDES = ['auto', '1', '2', '3', '4', '5'] as const;
export type PositionOverride = (typeof POSITION_OVERRIDES)[number];
export const POSITION_RU: Record<Position, string> = { 1: 'позиция 1 (керри)', 2: 'позиция 2 (центр)', 3: 'позиция 3 (оффлейн)', 4: 'позиция 4', 5: 'позиция 5' };
