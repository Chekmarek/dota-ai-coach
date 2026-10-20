// Прогноз драки: вероятность, что команда игрока выиграет драку, которая начинается рядом (docs/EXAM.md).
// Логистическая регрессия по снимку коуча (CoachView) — то, что видит коуч: союзники и враги рядом (мини-карта,
// полоски), здоровье и уровни видимых, стадия игры (уровень, предметы), счёт, риск смерти по модели опасности.
// Режим — отдельный признак. Обучение — tests/unit/fight-train.test.ts на матчах STRATZ; веса — src/data/fight-model.json.
import { z } from 'zod';
import type { CoachView } from './view.ts';
import { nearEnemyCount } from './memory.ts';
import { dist, mapSide, NEAR_UNITS } from './geo.ts';
import { MAP_POINTS } from './game-context.ts';

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
  // Лайнинг (DECISIONS.md п. 71): своя мана, перевес по здоровью над врагами рядом, близость своей и вражеской
  // башни (позиции — из файлов карты; стоит ли башня, GSI игрока не сообщает). Готовность ульты и крипов здесь нет:
  // в данных STRATZ нет ни перезарядок, ни крипов — в стенде признак был бы константой.
  'mana',
  'hpAdv',
  'ownTower',
  'enemyTower',
] as const;
export type FightFeature = (typeof FIGHT_FEATURES)[number];

export interface FightExtra {
  itemValue: number | null;
  turbo: boolean;
  /** Риск смерти за 15 с по модели опасности; null — модели нет */
  risk: number | null;
}

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const avg = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/**
 * Кто рядом — один подсчёт и для признаков модели, и для подписи шанса («2 на 2 (+1 рядом)»). allies, enemiesVis —
 * свежие (≤ 3 с) живые герои на мини-карте ≤ 2 500 ед.; enemies — все враги рядом (мини-карта и полоски на экране);
 * aClose, eClose — вплотную (≤ 1 200, обычно это те, кто на экране). null — своё место неизвестно.
 */
export function fightCrowd(v: CoachView) {
  const me = v.me.pos.value;
  if (!me) return null;
  const fresh = (p: CoachView['enemies'][number]) => p.alive.value !== false && p.pos.value !== null && p.pos.ageSec !== null && p.pos.ageSec <= FRESH_SEC;
  const allies = v.allies.filter((a) => fresh(a) && dist(a.pos.value!, me) <= NEAR_UNITS);
  const enemiesVis = v.enemies.filter((e) => fresh(e) && dist(e.pos.value!, me) <= NEAR_UNITS);
  const aClose = allies.filter((a) => dist(a.pos.value!, me) <= CLOSE_UNITS).length;
  const eClose = enemiesVis.filter((e) => dist(e.pos.value!, me) <= CLOSE_UNITS).length;
  return { me, allies, enemiesVis, enemies: nearEnemyCount(v), aClose, eClose };
}

/** Признаки (порядок — FIGHT_FEATURES); null — нет своего места или здоровья */
export function fightFeatures(v: CoachView, x: FightExtra): number[] | null {
  const hpPool = v.me.hp.value;
  const crowd = fightCrowd(v);
  if (!crowd || !hpPool || hpPool.max <= 0 || !v.team) return null;
  const { me, allies, enemiesVis, enemies, aClose, eClose } = crowd;
  // Здоровье союзников: с привязанных полосок, иначе — с зелёных полосок на экране рядом с героем (к союзникам полоски
  // не привязываются: без этого признак всегда был «неизвестен»)
  const allyLinked = allies.map((a) => a.hpPercent.value).filter((h): h is number => h !== null);
  const allyHp = avg(allyLinked.length ? allyLinked : v.screen.meOnScreen ? v.screen.allyBars.map((b) => b.hpPercent) : []);
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
  const mana = v.me.mana.value && v.me.mana.value.max > 0 ? clamp(v.me.mana.value.current / v.me.mana.value.max, 0, 1) : 0.5;
  const tower = (team: 'radiant' | 'dire') => {
    const d = Math.min(...MAP_POINTS.towers.filter((t) => t.team === team && t.tier <= 3).map((t) => dist(t, me)));
    return clamp(1 - d / TOWER_REACH, 0, 1);
  };
  const enemyTeam = v.team === 'radiant' ? 'dire' : 'radiant';
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
    mana,
    enemyHp === null ? 0 : clamp(hpPool.current / hpPool.max - enemyHp / 100, -1, 1),
    tower(v.team),
    tower(enemyTeam),
  ];
}
/** Башня «рядом»: признак 1 у самой башни, 0 — дальше 2 000 ед. (дальность атаки башни ~700, обзор ~1 900) */
const TOWER_REACH = 2000;

/**
 * Калибровка процентов (DECISIONS.md п. 72): изотоническая по части «val-calib» обучающих матчей — точки
 * [сырой шанс, выиграно на деле], между ними линейно. Нет — сырой шанс регрессии.
 */
const calibrationSchema = z.object({ points: z.array(z.tuple([z.number().min(0).max(1), z.number().min(0).max(1)])).min(2) });
const modeSchema = z.object({ weights: z.object({ bias: z.number(), w: z.array(z.number()) }), calibration: calibrationSchema.optional() });
export const fightModelSchema = z.object({
  schema: z.literal('dota-coach.fight-model'),
  version: z.literal(1),
  features: z.array(z.string()),
  trainedAt: z.string(),
  normal: modeSchema,
  turbo: modeSchema,
});
/** Модель и номера её признаков в FIGHT_FEATURES: старый файл (меньше признаков) читается и работает как раньше */
export type FightModel = z.infer<typeof fightModelSchema> & { idx: number[] };
export type FightModeModel = z.infer<typeof modeSchema>;

export function parseFightModel(raw: unknown): FightModel | null {
  const r = fightModelSchema.safeParse(raw);
  if (!r.success) return null;
  const idx = r.data.features.map((f) => (FIGHT_FEATURES as readonly string[]).indexOf(f));
  if (idx.some((i) => i < 0) || new Set(idx).size !== idx.length) return null;
  if (r.data.normal.weights.w.length !== idx.length || r.data.turbo.weights.w.length !== idx.length) return null;
  return { ...r.data, idx };
}

/** Признаки модели из полного набора (порядок — как в файле модели) */
export const modelFeatures = (m: Pick<FightModel, 'idx'>, f: readonly number[]): number[] => m.idx.map((i) => f[i]!);

export function fightProbability(w: { bias: number; w: readonly number[] }, f: readonly number[]): number {
  let z = w.bias;
  for (let i = 0; i < w.w.length; i++) z += w.w[i]! * f[i]!;
  return 1 / (1 + Math.exp(-z));
}

/** Сырой шанс → откалиброванный (линейно между точками, за краями — крайние точки) */
export function calibrate(points: readonly (readonly [number, number])[] | undefined, p: number): number {
  if (!points || points.length < 2) return p;
  if (p <= points[0]![0]) return points[0]![1];
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]!, [x0, y0] = points[i - 1]!;
    if (p <= x1) return x1 === x0 ? y1 : y0 + ((p - x0) / (x1 - x0)) * (y1 - y0);
  }
  return points.at(-1)![1];
}

/** Шанс выиграть драку по модели режима: признаки из полного набора fightFeatures, с калибровкой */
export function fightChance(m: FightModel, turbo: boolean, full: readonly number[]): number {
  const mode = turbo ? m.turbo : m.normal;
  return calibrate(mode.calibration?.points, fightProbability(mode.weights, modelFeatures(m, full)));
}

/**
 * Кто рядом — для подписи шанса: «вы 2 на 2 (+1 рядом на карте)». ours — вы и союзники рядом (мини-карта, ≤ 2 500),
 * close — враги вплотную (≤ 1 200, обычно это те, кто на экране), near — все враги рядом (мини-карта и полоски).
 */
export function fightCounts(v: CoachView): { ours: number; close: number; near: number } | null {
  const c = fightCrowd(v);
  return c ? { ours: c.allies.length + 1, close: c.eClose, near: Math.max(c.eClose, c.enemies) } : null;
}

/**
 * Заголовок шанса с гистерезисом ±3 п.п.: около 60% и 40% заголовок не дёргается каждую секунду между «Вступать»
 * и «Драка на равных» («Не вступать»). prev — прошлый заголовок этой драки (null — первый показ).
 */
export const ENGAGE_GO = 60;
export const ENGAGE_NO = 40;
export const ENGAGE_HYSTERESIS = 3;
export type EngageLabel = 'go' | 'even' | 'no';
export function engageLabel(value: number, prev: EngageLabel | null): EngageLabel {
  const h = ENGAGE_HYSTERESIS;
  if (prev === 'go' && value >= ENGAGE_GO - h) return 'go';
  if (prev === 'no' && value <= ENGAGE_NO + h) return 'no';
  if (prev === 'even' && value > ENGAGE_NO - h && value < ENGAGE_GO + h) return 'even';
  return value >= ENGAGE_GO ? 'go' : value <= ENGAGE_NO ? 'no' : 'even';
}

/** Вклад признаков в шанс, п.п. (по наклону сигмоиды в точке), самые сильные первыми */
export function fightFactors(m: FightModel, turbo: boolean, full: readonly number[]): { feature: FightFeature; effect: number }[] {
  const w = (turbo ? m.turbo : m.normal).weights;
  const f = modelFeatures(m, full);
  const p = fightProbability(w, f);
  return m.idx.map((k, i) => ({ feature: FIGHT_FEATURES[k]!, effect: w.w[i]! * f[i]! * p * (1 - p) * 100 }))
    .filter((x) => Math.abs(x.effect) >= 1)
    .sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
}
