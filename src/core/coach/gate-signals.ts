// Сигналы для фильтра внимания (src/core/gate) из снимка коуча: GSI и зрение вместе, фильтр о них не знает.
// GSI: жив, здоровье, оглушён/заглушён, перезарядки способностей, позиция (база, путь к базе, руна), предметы.
// Зрение: враги рядом и вплотную, драка по памяти коуча. Чего нет — null. Чистое ядро.
import type { GsiReading } from '../gsi/map.ts';
import type { GateSignals } from '../gate/types.ts';
import type { CoachMemory } from './memory.ts';
import type { CoachView } from './view.ts';
import { CLOSE_UNITS, NEAR_UNITS, dist, isOwnBase } from './geo.ts';
import { MAP_POINTS } from './game-context.ts';

/** Фонтаны (координаты мира, приблизительно): для «идёт к базе» точность до сотен единиц не нужна */
const FOUNTAIN = { radiant: { x: -7100, y: -6650 }, dire: { x: 7000, y: 6450 } } as const;
/** Позиция врага старше — не считается «рядом» */
const ENEMY_POS_MAX_AGE_SEC = 3;

export function gateSignals(v: CoachView, mem: CoachMemory, gsi: GsiReading | null, nowMs: number): GateSignals {
  const me = v.me.pos.value;
  const hp = v.me.hp.value;
  const screen = v.sources.screen;
  const fresh = v.enemies.filter((e) => e.alive.value !== false && e.pos.value && (e.pos.ageSec ?? 99) <= ENEMY_POS_MAX_AGE_SEC);
  const enemiesNear = screen && me ? fresh.filter((e) => dist(e.pos.value!, me) <= NEAR_UNITS).length : null;
  const enemiesClose = screen && me ? Math.max(fresh.filter((e) => dist(e.pos.value!, me) <= CLOSE_UNITS).length, v.screen.meOnScreen ? v.screen.enemyBars.length : 0) : null;
  const extra = gsi?.extra;
  const disabled = extra ? extra.stunned === true || extra.silenced === true : null;
  const runes = [...MAP_POINTS.runes.power, ...MAP_POINTS.runes.bounty];
  return {
    nowMs,
    matchId: v.matchId,
    inGame: v.inGame,
    paused: v.paused,
    preGame: v.phase === 'pre-game' || (v.clock.value !== null && v.clock.value < 0),
    alive: v.me.alive.value,
    hpPct: hp && hp.max > 0 ? (hp.current / hp.max) * 100 : null,
    disabled,
    abilityCooldowns: gsi ? v.me.abilities.map((a) => a.cooldownSec) : null,
    enemiesNear,
    enemiesClose,
    visionFight: screen ? mem.inFight : null,
    atBase: v.team && v.me.zone ? isOwnBase(v.me.zone, v.team) : null,
    distToBase: v.team && me ? dist(me, FOUNTAIN[v.team]) : null,
    distToRune: me && runes.length ? Math.min(...runes.map((p) => dist(p, me))) : null,
    items: v.me.itemsKnown ? v.me.items.map((i) => i.key) : null,
  };
}
