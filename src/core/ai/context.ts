// Контекст для будущего ИИ-тренера (этап 4 зрения): компактный снимок того, что коуч знает о матче, —
// не зависит от модели и не вызывает её. Схема стабильна и описана в docs/AI_CONTEXT.md.
// Правило: неизвестное — явно (value: null + причина), ничего не додумываем. У известного — уверенность,
// возраст, пометка («видно сейчас» / «видели раньше» / «вывод») и источник (игра или экран).
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { MatchState, Tracked } from '../match-state/types.ts';
import type { TrackedPlayer } from '../match-state/players.ts';
import { mapZone, type MapZone } from '../match-state/map-zones.ts';
import { upcomingEvents } from '../knowledge-base/timers.ts';
import type { MechanicsEntry, MechanicsVerification } from '../../shared/types/mechanics.ts';

export const AI_CONTEXT_SCHEMA = 'dota-coach.ai-context';
/** Меняется только при несовместимом изменении схемы (docs/AI_CONTEXT.md) */
export const AI_CONTEXT_VERSION = 1;
/** Сколько ближайших событий карты класть в контекст */
export const AI_CONTEXT_TIMERS = 6;

/**
 * Почему значения нет:
 * - never-observed — ни разу не видели (ни из игры, ни с экрана);
 * - expired — видели, но давно: срок памяти значения истёк;
 * - not-applicable — к этому случаю не относится (время возрождения у живого, «пропал» у союзника);
 * - hero-not-identified — свой герой ещё не определён;
 * - not-linked — полоска здоровья на экране есть, но чья — не известно наверняка (или полоски не видно);
 * - team-unknown — своя команда неизвестна (нет данных из игры): союзников и врагов не различить;
 * - clock-unknown — игровое время неизвестно; no-knowledge-base — нет механики карты в базе знаний;
 * - not-in-knowledge-base — значения нет в базе знаний для этого патча.
 */
export type UnknownReason =
  | 'never-observed'
  | 'expired'
  | 'not-applicable'
  | 'hero-not-identified'
  | 'not-linked'
  | 'team-unknown'
  | 'clock-unknown'
  | 'no-knowledge-base'
  | 'not-in-knowledge-base';

export interface KnownFact<T> {
  value: T;
  /** 0–1 */
  confidence: number;
  /** Секунд с последнего подтверждения */
  ageSec: number;
  tag: 'visible' | 'remembered' | 'inferred';
  source: 'gsi' | 'screen' | null;
}

export interface UnknownFact {
  value: null;
  reason: UnknownReason;
}

export type Fact<T> = KnownFact<T> | UnknownFact;

export interface AiPlayer {
  /** Ячейка верхней панели = номер игрока GSI: 0–4 Силы Света, 5–9 Силы Тьмы */
  slot: number;
  team: 'radiant' | 'dire';
  side: 'ally' | 'enemy' | null;
  /** Ключ героя, например «nevermore» */
  hero: Fact<string>;
  alive: Fact<boolean>;
  /** Игровое время возрождения, секунды */
  respawnAtSec: Fact<number>;
  /** Место на карте: координаты мира и приблизительная область */
  position: Fact<{ x: number; y: number; zone: MapZone }>;
  /** Враг пропал с мини-карты; null — не определить (союзник, ещё не видели, мини-карта не читается) */
  missing: boolean | null;
  /** Сколько секунд пропал; null — не пропал */
  missingForSec: number | null;
  hpPercent: Fact<number>;
}

export interface AiTimer {
  id: string;
  nameRu: string;
  /** Игровое время начала события, секунды; null — в базе знаний нет значения */
  atSec: number | null;
  inSec: number | null;
  verification: MechanicsVerification | null;
}

export interface AiContext {
  schema: typeof AI_CONTEXT_SCHEMA;
  version: typeof AI_CONTEXT_VERSION;
  /** Момент снимка, мс (часы движка) */
  wallMs: number;
  sources: { gsi: boolean; screen: boolean };
  match: {
    clockSec: Fact<number>;
    paused: boolean;
    dayNight: Fact<'day' | 'night'>;
    scoreRadiant: Fact<number>;
    scoreDire: Fact<number>;
  };
  myHero: {
    hero: Fact<{ id: number; name: string }>;
    level: Fact<number>;
    health: Fact<{ current: number; max: number }>;
    mana: Fact<{ current: number; max: number }>;
    gold: Fact<number>;
    kda: Fact<{ kills: number; deaths: number; assists: number }>;
  };
  /** Своя команда (только из данных игры); неизвестна — reason team-unknown */
  myTeam: { value: 'radiant' | 'dire'; source: 'gsi' } | UnknownFact;
  /** Все 10 игроков по ячейкам (пусто — верхняя панель ещё не читалась) */
  players: AiPlayer[];
  /** Ближайшие события карты из базы знаний */
  timers: { upcoming: AiTimer[] } | UnknownFact;
}

/** Tracked → Fact. never — причина, если значение ни разу не видели (по умолчанию never-observed) */
export function fact<T, U = T>(t: Tracked<T>, wallMs: number, map?: (v: T) => U, never: UnknownReason = 'never-observed'): Fact<U> {
  if (t.value === null || t.tag === 'unknown') return { value: null, reason: t.lastSeenWallMs === null ? never : 'expired' };
  return {
    value: map ? map(t.value) : (t.value as unknown as U),
    confidence: Math.round(t.confidence * 100) / 100,
    ageSec: t.lastSeenWallMs === null ? 0 : Math.max(0, Math.round((wallMs - t.lastSeenWallMs) / 100) / 10),
    tag: t.tag,
    source: t.source,
  };
}

const unknown = (reason: UnknownReason): UnknownFact => ({ value: null, reason });

function player(p: TrackedPlayer, wallMs: number): AiPlayer {
  const dead = p.alive.value === false && p.alive.tag !== 'unknown';
  return {
    slot: p.slot,
    team: p.team,
    side: p.side,
    hero: fact(p.hero, wallMs),
    alive: fact(p.alive, wallMs),
    respawnAtSec: dead ? fact(p.respawnAt, wallMs) : unknown('not-applicable'),
    position: fact(p.position, wallMs, (v) => ({ x: Math.round(v.x), y: Math.round(v.y), zone: mapZone(v.x, v.y) })),
    missing: p.missing,
    missingForSec: p.missing && p.missingSinceWallMs !== null ? Math.max(0, Math.round((wallMs - p.missingSinceWallMs) / 1000)) : null,
    hpPercent: fact(p.hpPercent, wallMs, undefined, 'not-linked'),
  };
}

/** Снимок для ИИ. mechanics — механика карты из базы знаний (null — базы нет) */
export function buildAiContext(s: MatchState, mechanics: readonly MechanicsEntry[] | null): AiContext {
  const w = s.wallMs;
  const h = s.hero;
  const heroReason: UnknownReason = h.locked ? 'never-observed' : 'hero-not-identified';
  const clockKnown = s.match.clock.value !== null && s.match.clock.tag !== 'unknown';
  let timers: AiContext['timers'];
  if (!mechanics || mechanics.length === 0) timers = unknown('no-knowledge-base');
  else if (!clockKnown) timers = unknown('clock-unknown');
  else
    timers = {
      upcoming: upcomingEvents(mechanics, s.match.clock.value as number)
        .filter((e) => e.status === 'ok' || e.status === 'missing')
        .slice(0, AI_CONTEXT_TIMERS)
        .map((e) => ({ id: e.id, nameRu: e.nameRu, atSec: e.at, inSec: e.inSec, verification: e.verification })),
    };
  return {
    schema: AI_CONTEXT_SCHEMA,
    version: AI_CONTEXT_VERSION,
    wallMs: w,
    sources: { ...s.sources },
    match: {
      clockSec: fact(s.match.clock, w),
      paused: s.match.paused,
      dayNight: fact(s.match.dayNight, w),
      scoreRadiant: fact(s.match.scoreRadiant, w),
      scoreDire: fact(s.match.scoreDire, w),
    },
    myHero: {
      hero: h.locked ? fact(h.identity, w, (v) => ({ id: v.id, name: v.name })) : unknown('hero-not-identified'),
      level: fact(h.level, w, undefined, heroReason),
      health: fact(h.health, w, (v) => ({ current: v.current, max: v.max }), heroReason),
      mana: fact(h.mana, w, (v) => ({ current: v.current, max: v.max }), heroReason),
      gold: fact(h.gold, w, undefined, heroReason),
      kda: fact(h.kda, w, (v) => ({ kills: v.kills, deaths: v.deaths, assists: v.assists }), heroReason),
    },
    myTeam: s.ourTeam ? { value: s.ourTeam, source: 'gsi' } : unknown('team-unknown'),
    players: s.players.map((p) => player(p, w)),
    timers,
  };
}
