// Прогноз драки: вероятность, что команда игрока выиграет драку, которая начинается рядом (docs/EXAM.md).
// Логистическая регрессия по снимку коуча (CoachView) — то, что видит коуч: союзники и враги рядом (мини-карта,
// полоски), здоровье и уровни видимых, стадия игры (уровень, предметы), счёт, риск смерти по модели опасности.
// Режим — отдельный признак. Обучение — tests/unit/fight-train.test.ts на матчах STRATZ; веса — src/data/fight-model.json.
import { z } from 'zod';
import type { CoachView } from './view.ts';
import { nearEnemyCount } from './memory.ts';
import { dist, mapSide, NEAR_UNITS } from './geo.ts';

const CLOSE_UNITS = 1200;
const FRESH_SEC = 3;

export const FIGHT_FEATURES = [
  'allies',
  'enemies',
  'countLead',
  'alliesClose',
  'enemiesClose',
  'hp',
  'allyHp',
  'allyHpKnown',
  'enemyHp',
  'enemyHpKnown',
  'enemyLevelAdv',
  'level',
  'itemStage',
  'scoreLead',
  'missing',
  'enemySide',
  'ownSide',
  'night',
  'risk',
  'turbo',
] as const;

export interface FightExtra {
  itemValue: number | null;
  turbo: boolean;
  /** Риск смерти за 15 с по модели опасности; null — модели нет */
  risk: number | null;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/** Признаки (порядок — FIGHT_FEATURES); null — нет своего места или здоровья */
export function fightFeatures(v: CoachView, x: FightExtra): number[] | null {
  const me = v.me.pos.value;
  const hpPool = v.me.hp.value;
  if (!me || !hpPool || hpPool.max <= 0 || !v.team) return null;
  const fresh = (p: CoachView['enemies'][number]) => p.alive.value !== false && p.pos.value !== null && p.pos.ageSec !== null && p.pos.ageSec <= FRESH_SEC;
  const allies = v.allies.filter((a) => fresh(a) && dist(a.pos.value!, me) <= NEAR_UNITS);
  const enemiesVis = v.enemies.filter((e) => fresh(e) && dist(e.pos.value!, me) <= NEAR_UNITS);
  const enemies = nearEnemyCount(v);
  const aClose = allies.filter((a) => dist(a.pos.value!, me) <= CLOSE_UNITS).length;
  const eClose = enemiesVis.filter((e) => dist(e.pos.value!, me) <= CLOSE_UNITS).length;
  const allyHp = avg(allies.map((a) => a.hpPercent.value).filter((h): h is number => h !== null));
  // Здоровье врагов: с привязанных к героям полосок, иначе — со всех вражеских полосок на экране рядом с героем
  const linked = enemiesVis.map((e) => e.hpPercent.value).filter((h): h is number => h !== null);
  const enemyHp = avg(linked.length ? linked : v.screen.meOnScreen ? v.screen.enemyBars.map((b) => b.hpPercent) : []);
  const lvl = v.me.level.value ?? 1;
  // Уровни врагов: полоски врагов к героям не привязываются (привязка — только своей, по уровню из GSI), поэтому —
  // с привязанных, иначе со всех вражеских полосок на экране рядом с героем (как в оценке «Вступать»)
  const linkedLvl = enemiesVis.map((e) => e.barLevel).filter((l): l is number => l !== null);
  const elv = avg(linkedLvl.length ? linkedLvl : v.screen.meOnScreen ? v.screen.enemyBars.map((b) => b.level).filter((l): l is number => l !== null) : []);
  const own = v.team === 'radiant' ? v.score.radiant.value : v.score.dire.value;
  const opp = v.team === 'radiant' ? v.score.dire.value : v.score.radiant.value;
  const side = mapSide(me, v.team);
  return [
    Math.min(4, allies.length) / 4,
    Math.min(5, enemies) / 5,
    Math.tanh((allies.length + 1 - enemies) / 2),
    Math.min(4, aClose) / 4,
    Math.min(5, eClose) / 5,
    clamp(hpPool.current / hpPool.max, 0, 1),
    allyHp === null ? 0 : allyHp / 100,
    allyHp === null ? 0 : 1,
    enemyHp === null ? 0 : enemyHp / 100,
    enemyHp === null ? 0 : 1,
    elv === null ? 0 : clamp((elv - lvl) / 5, -1, 1),
    lvl / 30,
    x.itemValue === null ? 0.3 : Math.log1p(Math.max(0, x.itemValue) / 1000) / Math.log1p(30),
    own !== null && opp !== null ? Math.tanh((own - opp) / 10) : 0,
    v.enemies.filter((e) => e.missing === true).length / 5,
    side === 'enemy' ? 1 : 0,
    side === 'own' ? 1 : 0,
    v.dayNight.value === 'night' ? 1 : 0,
    x.risk ?? 0,
    x.turbo ? 1 : 0,
  ];
}

const weightsSchema = z.object({ bias: z.number(), w: z.array(z.number()).length(FIGHT_FEATURES.length) });
export const fightModelSchema = z.object({
  schema: z.literal('dota-coach.fight-model'),
  version: z.literal(1),
  features: z.array(z.string()),
  trainedAt: z.string(),
  normal: z.object({ weights: weightsSchema }),
  turbo: z.object({ weights: weightsSchema }),
});
export type FightModel = z.infer<typeof fightModelSchema>;

export function parseFightModel(raw: unknown): FightModel | null {
  const r = fightModelSchema.safeParse(raw);
  if (!r.success || r.data.features.join(',') !== FIGHT_FEATURES.join(',')) return null;
  return r.data;
}

export function fightProbability(w: { bias: number; w: readonly number[] }, f: readonly number[]): number {
  let z = w.bias;
  for (let i = 0; i < f.length; i++) z += w.w[i]! * f[i]!;
  return 1 / (1 + Math.exp(-z));
}
