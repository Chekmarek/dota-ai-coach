// Контекст игры для всех советов (этап 2 «понимания игры»): стадия, позиция 1–5, герой. Считается один раз за тик
// из снимка матча и памяти; каждое правило сначала смотрит сюда — «в лайнинге керри в лес не зовём», «в лейте Tango
// не причина смерти». Чистое ядро.
import type { CoachView } from './view.ts';
import type { CoachMemory } from './memory.ts';
import type { CoachLookup } from './data.ts';
import { mapZone } from '../match-state/map-zones.ts';

export type GameStage = 'laning' | 'mid' | 'late';
export type Position = 1 | 2 | 3 | 4 | 5;
export const POSITION_OVERRIDES = ['auto', '1', '2', '3', '4', '5'] as const;
export type PositionOverride = (typeof POSITION_OVERRIDES)[number];

export const STAGE_RU: Record<GameStage, string> = { laning: 'лайнинг', mid: 'мидгейм', late: 'лейт' };
export const POSITION_RU: Record<Position, string> = { 1: 'позиция 1 (керри)', 2: 'позиция 2 (центр)', 3: 'позиция 3 (оффлейн)', 4: 'позиция 4', 5: 'позиция 5' };

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
  };
}
