// Контекст игры для всех советов (этап 2 «понимания игры»): стадия, позиция 1–5, герой. Считается один раз за тик
// из снимка матча и памяти; каждое правило сначала смотрит сюда — «в лайнинге керри в лес не зовём», «в лейте Tango
// не причина смерти». Чистое ядро.
import { poolPct, type CoachView } from './view.ts';
import { nearEnemyCount, type CoachMemory } from './memory.ts';
import type { CoachLookup } from './data.ts';
import { mapZone } from '../match-state/map-zones.ts';
import { NEAR_UNITS, dist, mapSide } from './geo.ts';
import mapPointsJson from '../../data/map-points.json';
import outpostsJson from '../../data/outposts.json';

/** Точки карты из файлов Dota 2 (scripts/extract-map-points.mjs): руны, Рошан, Мучитель, лотосы, башни */
export const MAP_POINTS = mapPointsJson as {
  runes: { power: { x: number; y: number }[]; bounty: { x: number; y: number }[] };
  roshan: { x: number; y: number }[];
  tormentor: { x: number; y: number }[];
  lotus: { x: number; y: number }[];
  wisdom: { x: number; y: number }[];
  towers: { team: 'radiant' | 'dire'; tier: number; lane: string | null; x: number; y: number }[];
};
const OUTPOSTS_ALL: readonly { x: number; y: number }[] = outpostsJson.outposts;

export type GameStage = 'laning' | 'mid' | 'late';
import type { Position, PositionOverride } from './position.ts';
export { POSITION_OVERRIDES, POSITION_RU, type Position, type PositionOverride } from './position.ts';

export const STAGE_RU: Record<GameStage, string> = { laning: 'лайнинг', mid: 'мидгейм', late: 'лейт' };

/**
 * Границы стадий в минутах обычной игры. В Турбо игра идёт примерно вдвое быстрее — минуты делятся на 2.
 * Время — только опора: стадию сдвигают уровень героя и потерянные здания своей команды.
 */
export const LANING_END_MIN = 10;
export const LATE_FROM_MIN = 30;
/** Уровень, с которого лайнинг точно закончился / начался лейт (уровни в Турбо и обычной игре сопоставимы по стадии) */
export const MID_FROM_LEVEL = 12;
export const LATE_FROM_LEVEL = 22;

export interface GameContext {
  stage: GameStage;
  /** Почему такая стадия — для подробного текста и отладки */
  stageWhy: string;
  /** Множитель времени: 1 — обычная игра, 0.5 — Турбо */
  scale: number;
  /** Игровое время в минутах обычной игры (clock / 60 / scale); null — часов нет */
  normMin: number | null;
  position: Position | null;
  positionSource: 'settings' | 'lane' | 'hero' | null;
  /** 0…1: насколько уверены в позиции */
  positionConfidence: number;
  /** Кор (1–3) или саппорт (4–5); null — позиция не известна */
  core: boolean | null;
  hero: {
    key: string | null;
    name: string | null;
    /** Ульта пассивная (Bristleback): «ищите убийство с ультой» и «ульта не нажата» к ней не относятся */
    ultPassive: boolean | null;
  };
  /** Своих зданий потеряно: башни по уровням, казармы */
  lost: { t1: number; t2: number; t3: number; rax: number } | null;
  /** Ситуация прямо сейчас — одно место для всех анализаторов (ночная задача, этап 2) */
  now: Situation;
}

/** Ситуация в матче прямо сейчас: всё, что нужно анализаторам, в одном объекте */
export interface Situation {
  clock: number | null;
  alive: boolean | null;
  level: number | null;
  hpPct: number | null;
  manaPct: number | null;
  gold: number | null;
  buyback: { cost: number | null; cooldownSec: number | null; affordable: boolean | null };
  /** Предметы в инвентаре: ключ и готов ли (перезарядка 0) */
  items: { key: string; ready: boolean | null }[];
  /** Способности: ключ, уровень, готова ли, ульта ли */
  abilities: { key: string | null; level: number | null; ready: boolean | null; ultimate: boolean }[];
  enemiesNear: number;
  alliesNear: number;
  /** Враги, пропавшие с мини-карты (ключи героев), и мёртвые */
  missing: string[];
  enemiesDead: number;
  alliesDead: number;
  /** Где герой: зона карты и сторона */
  zone: string | null;
  side: 'own' | 'river' | 'enemy' | null;
  /** Ближайшая точка руны и сколько секунд бега до неё (≈ 320 ед./с); null — позиция неизвестна */
  rune: { kind: 'power' | 'bounty'; dist: number; runSec: number } | null;
  /** Ближайший аванпост: расстояние и на чьей он половине */
  outpost: { dist: number; enemyHalf: boolean } | null;
  /** Логово Рошана: расстояние; Рошан убит в (игровое время), наш ли Аегис */
  roshan: { dist: number | null; killedAt: number | null; aegisOurs: boolean | null };
  inFight: boolean;
}

/** Скорость бега для «успею ли» — средняя скорость героя с ботинками (ед./с) */
export const RUN_SPEED = 320;

export function situation(v: CoachView, mem: CoachMemory): Situation {
  const me = v.me.pos.value;
  const near = (pts: readonly { x: number; y: number }[]) => (me && pts.length ? Math.min(...pts.map((p) => dist(p, me))) : null);
  const powerD = near(MAP_POINTS.runes.power);
  const bountyD = near(MAP_POINTS.runes.bounty);
  const rune = powerD === null || bountyD === null ? null : powerD <= bountyD ? { kind: 'power' as const, dist: Math.round(powerD), runSec: Math.round(powerD / RUN_SPEED) } : { kind: 'bounty' as const, dist: Math.round(bountyD), runSec: Math.round(bountyD / RUN_SPEED) };
  const op = me && v.team ? OUTPOSTS_ALL.map((o) => ({ dist: dist(o, me), enemyHalf: mapSide(o, v.team!) === 'enemy' })).sort((a, b) => a.dist - b.dist)[0] ?? null : null;
  const cost = v.me.buybackCost.value;
  const gold = v.me.gold.value;
  return {
    clock: v.clock.value,
    alive: v.me.alive.value,
    level: v.me.level.value,
    hpPct: poolPct(v.me.hp.value),
    manaPct: (v.me.mana.value?.max ?? 0) > 0 ? poolPct(v.me.mana.value) : null,
    gold,
    buyback: { cost, cooldownSec: v.me.buybackCooldown.value, affordable: cost === null || gold === null ? null : gold >= cost && (v.me.buybackCooldown.value ?? 0) === 0 },
    items: v.me.items.filter((i) => /^inv\d$|^neutral$|^tp$/.test(i.slot)).map((i) => ({ key: i.key, ready: i.cooldownSec === null ? null : i.cooldownSec === 0 })),
    abilities: v.me.abilities.map((a) => ({ key: a.key, level: a.level, ready: a.state === null ? null : a.state === 'ready', ultimate: a.ultimate })),
    enemiesNear: nearEnemyCount(v),
    alliesNear: me ? v.allies.filter((a) => a.alive.value !== false && a.pos.value && (a.pos.ageSec ?? 99) <= 3 && dist(a.pos.value, me) <= NEAR_UNITS).length : 0,
    missing: v.enemies.filter((e) => e.missing === true && e.hero.value).map((e) => e.hero.value!),
    enemiesDead: v.enemies.filter((e) => e.alive.value === false).length,
    alliesDead: v.allies.filter((e) => e.alive.value === false).length,
    zone: v.me.zone,
    side: me && v.team ? mapSide(me, v.team) : null,
    rune,
    outpost: op ? { dist: Math.round(op.dist), enemyHalf: op.enemyHalf } : null,
    roshan: { dist: near(MAP_POINTS.roshan) === null ? null : Math.round(near(MAP_POINTS.roshan)!), killedAt: mem.roshanKilledAt, aegisOurs: mem.aegisOurs },
    inFight: mem.inFight,
  };
}

/** Потерянные здания своей команды: GSI присылает только живые здания своей стороны */
export function lostBuildings(v: CoachView): GameContext['lost'] {
  const b = v.buildings;
  if (!b || !b.length) return null;
  const count = (re: RegExp) => b.filter((x) => re.test(x.key) && x.health > 0).length;
  return { t1: 3 - count(/tower1_/), t2: 3 - count(/tower2_/), t3: 3 - count(/tower3_/), rax: 6 - count(/rax_/) };
}

export function gameStage(v: CoachView, scale: number): { stage: GameStage; why: string } {
  const clock = v.clock.value;
  const lvl = v.me.level.value;
  const lost = lostBuildings(v);
  if (clock === null) return { stage: 'laning', why: 'часов нет' };
  const min = clock / 60 / scale;
  if (min >= LATE_FROM_MIN) return { stage: 'late', why: `время ${Math.round(clock / 60)} мин` };
  if (lvl !== null && lvl >= LATE_FROM_LEVEL) return { stage: 'late', why: `уровень ${lvl}` };
  if (lost && (lost.t3 > 0 || lost.rax > 0)) return { stage: 'late', why: 'потеряны башни 3-го уровня или казармы' };
  if (min >= LANING_END_MIN) return { stage: 'mid', why: `время ${Math.round(clock / 60)} мин` };
  if (lvl !== null && lvl >= MID_FROM_LEVEL) return { stage: 'mid', why: `уровень ${lvl}` };
  if (lost && (lost.t1 >= 2 || lost.t2 > 0)) return { stage: 'mid', why: 'потеряны две башни 1-го уровня' };
  return { stage: 'laning', why: `время ${Math.max(0, Math.floor(clock / 60))} мин` };
}

/** Доли позиций героя у профи (5 чисел); null — данных мало */
function heroPositionShares(look: CoachLookup, key: string): number[] | null {
  const pro = look.statsFor(null, key)?.pro;
  if (!pro?.positions || pro.positions.length !== 5 || (pro.games ?? 0) < 15) return null;
  return pro.positions;
}

/**
 * Линия в лайнинге по истории позиций (с 1:00): safe / mid / off / jungle; null — данных меньше минуты или неясно.
 * Как lane_role OpenDota, но с порогом по времени, чтобы позиция была известна уже ко 2-й минуте.
 */
const LANES = ['safe', 'mid', 'off', 'jungle'] as const;
type Lane = (typeof LANES)[number];

/** Линия запоминается на матч: история позиций в памяти короткая, к 20-й минуте лайнинга в ней уже нет */
export function laneOf(v: CoachView, mem: CoachMemory, scale: number): Lane | null {
  const fresh = laneFromSamples(v, mem, scale);
  if (fresh) mem.marks.set('lane', LANES.indexOf(fresh));
  const kept = mem.marks.get('lane');
  return fresh ?? (kept === undefined ? null : (LANES[kept] ?? null));
}

function laneFromSamples(v: CoachView, mem: CoachMemory, scale: number): Lane | null {
  if (!v.team) return null;
  const until = 8 * 60 * scale;
  const counts = new Map<string, number>();
  for (const s of mem.samples) {
    // с 1:00 и в Турбо: крипы выходят в 0:00 в обоих режимах, к минуте герои уже на своих линиях
    if (s.clock === null || s.clock < 60 || s.clock > until || !s.pos) continue;
    const z = mapZone(s.pos.x, s.pos.y);
    counts.set(z, (counts.get(z) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total < 45) return null;
  const [zone, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (n / total < 0.45) return null;
  const radiant = v.team === 'radiant';
  if (zone === 'mid-lane') return 'mid';
  if (zone === 'bot-lane') return radiant ? 'safe' : 'off';
  if (zone === 'top-lane') return radiant ? 'off' : 'safe';
  if (zone.endsWith('jungle')) return 'jungle';
  return null;
}

/** Позиция: настройка → линия + доли героя у профи → только доли героя (если одна позиция явно чаще) */
export function position(v: CoachView, mem: CoachMemory, look: CoachLookup, override: PositionOverride, scale: number): Pick<GameContext, 'position' | 'positionSource' | 'positionConfidence'> {
  if (override !== 'auto') return { position: Number(override) as Position, positionSource: 'settings', positionConfidence: 1 };
  const key = v.me.hero.value?.key ?? null;
  const shares = key ? heroPositionShares(look, key) : null;
  const share = (p: Position) => shares?.[p - 1] ?? 0;
  const lane = laneOf(v, mem, scale);
  if (lane) {
    // На линии двое: кор или саппорт — по долям героя у профи (без данных — по ролям базы знаний)
    const roles = key ? (look.heroByKey.get(key)?.roles ?? []) : [];
    const supportByKb = roles.includes('Support') && !roles.includes('Carry');
    if (lane === 'mid') return { position: 2, positionSource: 'lane', positionConfidence: 0.85 };
    if (lane === 'jungle') return { position: 4, positionSource: 'lane', positionConfidence: 0.5 };
    const [corePos, supPos]: [Position, Position] = lane === 'safe' ? [1, 5] : [3, 4];
    const support = shares ? share(supPos) > share(corePos) : supportByKb;
    const sure = shares ? Math.abs(share(supPos) - share(corePos)) >= 0.3 : false;
    return { position: support ? supPos : corePos, positionSource: 'lane', positionConfidence: sure ? 0.85 : 0.6 };
  }
  if (shares) {
    const best = shares.indexOf(Math.max(...shares));
    if (shares[best]! >= 0.6) return { position: (best + 1) as Position, positionSource: 'hero', positionConfidence: Math.min(0.8, shares[best]!) };
  }
  return { position: null, positionSource: null, positionConfidence: 0 };
}

export function buildGameContext(v: CoachView, mem: CoachMemory, look: CoachLookup, override: PositionOverride = 'auto'): GameContext {
  const scale = look.isTurbo ? 0.5 : 1;
  const st = gameStage(v, scale);
  const pos = position(v, mem, look, override, scale);
  const ult = v.me.abilities.find((a) => a.ultimate);
  const h = v.me.hero.value;
  return {
    stage: st.stage,
    stageWhy: st.why,
    scale,
    normMin: v.clock.value === null ? null : v.clock.value / 60 / scale,
    ...pos,
    core: pos.position === null ? null : pos.position <= 3,
    hero: { key: h?.key ?? null, name: h?.name ?? null, ultPassive: ult ? (ult.passive ?? null) : null },
    lost: lostBuildings(v),
    now: situation(v, mem),
  };
}
