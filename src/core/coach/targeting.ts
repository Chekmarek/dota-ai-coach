// Тип цели способностей и предметов (src/data/targeting.json, scripts/import-targeting.mjs — Valve datafeed) и
// выводы из него для советов против Blink Dagger и Linken's Sphere (DECISIONS.md п. 80).
import { z } from 'zod';
import type { KbHero } from '../../shared/types/kb.ts';

const flags = z.object({ passive: z.boolean(), unitEnemy: z.boolean(), area: z.boolean(), point: z.boolean().catch(false), ult: z.boolean().optional() });
export const targetingSchema = z.object({
  schema: z.literal('dota-coach.targeting'),
  version: z.literal(1),
  abilities: z.record(z.string(), flags).catch({}),
  items: z.record(z.string(), flags).catch({}),
});
export type Targeting = z.infer<typeof targetingSchema>;

export function parseTargeting(raw: unknown): Targeting | null {
  const r = targetingSchema.safeParse(raw);
  return r.success ? r.data : null;
}

/** Контроль в описании способности (русский текст Valve): оглушает, притягивает, заставляет атаковать, останавливает время… */
const CONTROL_RU = /оглуш|притяг|затяг|заставля|насмех|обездвиж|подбрасыва|не могут двигаться|подавля|останавлива|замира|запира|сковыва/gi;
/** Контроль задевает нескольких: «врагов», «всех», «вокруг», «в радиусе», «неподалёку» (Kez парирует одну атаку — нет) */
const MANY_RU = /врагов|вражеских|всех|вокруг|в радиусе|неподал|противников|всё внутри/i;

/** В описании есть контроль без отрицания перед ним («лучи не оглушают» у Luna — не контроль) */
export function describesControl(text: string): boolean {
  for (const m of text.matchAll(CONTROL_RU)) if (!/(^|\s)не\s+$/i.test(text.slice(Math.max(0, m.index - 4), m.index))) return true;
  return false;
}

/**
 * Способности героя с массовым контролем: не на одну цель (без цели, по площади или по точке) и по описанию Valve —
 * контроль. Ravage, Black Hole, Reverse Polarity, Berserker's Call, Chronosphere… Пусто — герой прыгает на одну цель.
 */
export function massControl(hero: KbHero | undefined, t: Targeting | null): { key: string; name: string }[] {
  if (!hero || !t) return [];
  return hero.abilities.filter((a) => {
    const f = t.abilities[a.key];
    const d = a.descRu ?? '';
    return !a.innate && f && !f.passive && !f.unitEnemy && (f.area || f.point) && describesControl(d) && MANY_RU.test(d);
  }).map((a) => ({ key: a.key, name: a.name }));
}

export interface TargetedTool {
  key: string;
  name: string;
  kind: 'ability' | 'item';
  /** Перезарядка на текущем уровне (база знаний), с; null — не известна */
  cooldown: number | null;
  ult: boolean;
}
