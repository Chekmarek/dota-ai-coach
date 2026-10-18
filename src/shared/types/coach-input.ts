// Вход движка подсказок: снимок состояния матча из окна движка и последнее чтение GSI (engine → main, ≤ 2 раз в с).
// Проверка формы — zod (терпимо к внутренностям: правила сами не доверяют полям и проверяют null).
import { z } from 'zod';
import type { MatchState } from '../../core/match-state/index.ts';
import type { GsiReading } from '../../core/gsi/map.ts';

const tracked = z.looseObject({ value: z.unknown(), confidence: z.number(), tag: z.string(), lastSeenWallMs: z.number().nullable(), source: z.string().nullable() });

export const coachInputSchema = z.object({
  state: z.looseObject({
    wallMs: z.number(),
    sources: z.object({ gsi: z.boolean(), screen: z.boolean() }),
    match: z.looseObject({ clock: tracked, paused: z.boolean(), dayNight: tracked }),
    hero: z.looseObject({ level: tracked, gold: tracked, health: tracked, mana: tracked, items: z.array(z.unknown()).max(20), abilities: z.array(z.unknown()).max(30) }),
    events: z.array(z.unknown()).max(500),
    ourTeam: z.enum(['radiant', 'dire']).nullable(),
    players: z.array(z.unknown()).max(10),
    allies: z.array(z.unknown()).max(10),
    enemies: z.array(z.unknown()).max(10),
    healthBars: z.array(z.unknown()).max(60),
  }),
  gsi: z.looseObject({ hero: z.looseObject({ key: z.string() }), abilities: z.array(z.unknown()).max(40) }).nullable(),
  gsiWallMs: z.number().nullable(),
  /** GSI идёт без своего героя (наблюдение за чужим матчем): подсказок нет */
  notOwnMatch: z.boolean().optional(),
});

export interface CoachInput {
  state: MatchState;
  gsi: GsiReading | null;
  gsiWallMs: number | null;
  notOwnMatch?: boolean;
}

/** Разбор входа; null — не та форма или слишком большой */
export function parseCoachInput(raw: unknown): CoachInput | null {
  const r = coachInputSchema.safeParse(raw);
  return r.success ? (r.data as unknown as CoachInput) : null;
}
