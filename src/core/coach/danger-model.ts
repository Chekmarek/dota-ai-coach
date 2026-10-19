// Модель опасности: вероятность, что свой герой умрёт в ближайшие DANGER_HORIZON_SEC секунд (docs/DANGER_MODEL.md).
// Логистическая регрессия по признакам из снимка коуча (CoachView) — тем же, что видят правила: туман войны, враги
// с мини-карты и полосок. Признаки описывают стадию игры (уровень, стоимость предметов, здоровье, счёт), а не минуты:
// так одна модель годится и для All Pick, и для Турбо, а режим — отдельный признак. Обучение —
// scripts/danger-train.mjs на матчах STRATZ; веса и включение по режимам — src/data/danger-model.json.
import { z } from 'zod';
import type { CoachView } from './view.ts';
import { nearEnemyCount } from './memory.ts';
import { dist, isEnemyJungle, mapSide, NEAR_UNITS } from './geo.ts';

/**
 * Правила о риске для своего героя, которые модель заменяет в режиме, где она включена (там она была лучше их).
 * Остальные предупреждения (смок, здания, Рошан, невидимки) работают всегда.
 */
export const RISK_RULES = ['danger.low-hp', 'danger.missing', 'danger.ganker', 'danger.deep'] as const;

/** Горизонт: смерть в ближайшие столько секунд */
export const DANGER_HORIZON_SEC = 15;
/** «Вплотную» — враг ближе (ед.) */
const CLOSE_UNITS = 1200;
/** Позиция считается свежей, если не старше (с) */
const FRESH_SEC = 3;

/**
 * Расходники не входят в стоимость предметов: их покупают и тратят (при обучении считаются покупки STRATZ, в игре —
 * то, что в инвентаре; без расходников оба способа дают одно и то же — стоимость собранных предметов).
 */
export const DANGER_CONSUMABLES = new Set(['tango', 'tango_single', 'flask', 'clarity', 'enchanted_mango', 'faerie_fire', 'tpscroll', 'ward_observer', 'ward_sentry', 'ward_dispenser', 'dust', 'smoke_of_deceit', 'blood_grenade', 'famango', 'great_famango', 'greater_famango', 'courier', 'cheese', 'aegis', 'refresher_shard']);

export const DANGER_FEATURES = [
  'hp',
  'lowHp',
  'mana',
  'level',
  'itemStage',
  'enemiesNear',
  'enemiesClose',
  'alliesNear',
  'outnumbered',
  'closestEnemy',
  'enemyHp',
  'enemyLevelAdv',
  'missing',
  'enemySide',
  'river',
  'enemyJungle',
  'night',
  'scoreLead',
  'turbo',
  'lowHpXnear',
  'closeXhurt',
] as const;
export type DangerFeature = (typeof DANGER_FEATURES)[number];

export interface DangerExtra {
  /** Стоимость собранных предметов своего героя (без расходников); null — не известна */
  itemValue: number | null;
  turbo: boolean;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Признаки из снимка коуча (порядок — DANGER_FEATURES); null — нечего оценивать (нет своего места или здоровья) */
export function dangerFeatures(v: CoachView, x: DangerExtra): number[] | null {
  const me = v.me.pos.value;
  const hpPool = v.me.hp.value;
  if (!me || !hpPool || hpPool.max <= 0 || !v.team) return null;
  const hp = clamp(hpPool.current / hpPool.max, 0, 1);
  const mana = v.me.mana.value && v.me.mana.value.max > 0 ? clamp(v.me.mana.value.current / v.me.mana.value.max, 0, 1) : 0.5;
  const lvl = v.me.level.value ?? 1;
  const fresh = (p: CoachView['enemies'][number]) => p.alive.value !== false && p.pos.value !== null && p.pos.ageSec !== null && p.pos.ageSec <= FRESH_SEC;
  const visible = v.enemies.filter(fresh).map((e) => ({ e, d: dist(e.pos.value!, me) }));
  const nearCount = nearEnemyCount(v);
  const close = visible.filter((q) => q.d <= CLOSE_UNITS).length;
  const allies = v.allies.filter((a) => fresh(a) && dist(a.pos.value!, me) <= NEAR_UNITS).length;
  const nearVis = visible.filter((q) => q.d <= NEAR_UNITS);
  const minD = visible.length ? Math.min(...visible.map((q) => q.d)) : Infinity;
  const ehp = nearVis.map((q) => q.e.hpPercent.value).filter((h): h is number => h !== null);
  const elv = nearVis.map((q) => q.e.barLevel).filter((l): l is number => l !== null);
  const missing = v.enemies.filter((e) => e.missing === true).length;
  const side = mapSide(me, v.team);
  const own = v.team === 'radiant' ? v.score.radiant.value : v.score.dire.value;
  const opp = v.team === 'radiant' ? v.score.dire.value : v.score.radiant.value;
  const lowHp = Math.max(0, 0.4 - hp) / 0.4;
  const near = Math.min(5, nearCount) / 5;
  return [
    hp,
    lowHp,
    mana,
    lvl / 30,
    x.itemValue === null ? 0.3 : Math.log1p(Math.max(0, x.itemValue) / 1000) / Math.log1p(30),
    near,
    Math.min(5, close) / 5,
    Math.min(4, allies) / 4,
    Math.tanh((nearCount - allies - 1) / 2),
    Number.isFinite(minD) ? 1 - Math.min(minD, 3000) / 3000 : 0,
    ehp.length ? ehp.reduce((a, b) => a + b, 0) / ehp.length / 100 : 0,
    elv.length ? clamp((elv.reduce((a, b) => a + b, 0) / elv.length - lvl) / 5, -1, 1) : 0,
    missing / 5,
    side === 'enemy' ? 1 : 0,
    side === 'river' ? 1 : 0,
    isEnemyJungle(v.me.zone, v.team) ? 1 : 0,
    v.dayNight.value === 'night' ? 1 : 0,
    own !== null && opp !== null ? Math.tanh((own - opp) / 10) : 0,
    x.turbo ? 1 : 0,
    lowHp * near,
    (Math.min(5, close) / 5) * (1 - hp),
  ];
}

const weightsSchema = z.object({ bias: z.number(), w: z.array(z.number()).length(DANGER_FEATURES.length) });
const modeSchema = z.object({
  /** Модель включена в этом режиме: на отложенных матчах она была лучше правил */
  enabled: z.boolean(),
  /** Предупреждать при вероятности не ниже */
  threshold: z.number().min(0).max(1),
  /**
   * Какие правила о риске модель заменяет в этом режиме: все четыре или только «мало здоровья» (гибрид — ранние
   * правила остаются: они предупреждают за 20–40 с, модель — о том, что уже рядом). В старом файле поля нет — все.
   */
  replaces: z.array(z.enum(RISK_RULES)).default([...RISK_RULES]),
  weights: weightsSchema,
});
export const dangerModelSchema = z.object({
  schema: z.literal('dota-coach.danger-model'),
  version: z.literal(1),
  features: z.array(z.string()),
  horizonSec: z.number(),
  /** Не чаще одного предупреждения модели за столько секунд */
  cooldownSec: z.number().min(0),
  trainedAt: z.string(),
  normal: modeSchema,
  turbo: modeSchema,
});
export type DangerModel = z.infer<typeof dangerModelSchema>;

/** Разбор файла модели; другие признаки или испорченный файл — null (тогда работают правила) */
export function parseDangerModel(raw: unknown): DangerModel | null {
  const r = dangerModelSchema.safeParse(raw);
  if (!r.success) return null;
  if (r.data.features.join(',') !== DANGER_FEATURES.join(',')) return null;
  return r.data;
}

export function dangerProbability(w: { bias: number; w: readonly number[] }, f: readonly number[]): number {
  let z = w.bias;
  for (let i = 0; i < f.length; i++) z += w.w[i]! * f[i]!;
  return 1 / (1 + Math.exp(-z));
}

/** Самые сильные вклады в риск (признак × вес) — для текста «почему» */
export function dangerReasons(w: { w: readonly number[] }, f: readonly number[], n = 3): { feature: DangerFeature; effect: number }[] {
  return f
    .map((v, i) => ({ feature: DANGER_FEATURES[i]!, effect: v * w.w[i]! }))
    .filter((r) => r.effect > 0 && r.feature !== 'turbo')
    .sort((a, b) => b.effect - a.effect)
    .slice(0, n);
}

/** Стоимость собранных предметов по ключам инвентаря (без расходников) */
export function itemValueOf(keys: readonly string[], cost: (key: string) => number | null): number {
  let s = 0;
  for (const k of keys) if (!DANGER_CONSUMABLES.has(k)) s += cost(k) ?? 0;
  return s;
}
