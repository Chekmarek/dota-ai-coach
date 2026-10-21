// Слой фактов для правил: MatchState (зрение + GSI) и последнее чтение GSI → плоский снимок, где у каждого значения
// есть источник, возраст и уверенность. Ничего не придумывает: нет данных — value = null.
import type { MatchState, Tracked, Pool, MapPoint } from '../match-state/index.ts';
import { mapZone, type MapZone } from '../match-state/map-zones.ts';
import type { GsiReading, GsiBuilding, GsiEvent } from '../gsi/map.ts';
import type { FactRef, FactSource } from './types.ts';

/** Значение с источником, возрастом и уверенностью */
export interface F<T> {
  value: T | null;
  source: FactSource | null;
  /** Секунд с последнего подтверждения; null — значения нет */
  ageSec: number | null;
  confidence: number;
}

export const unknownF = <T>(): F<T> => ({ value: null, source: null, ageSec: null, confidence: 0 });
/** Без свежего GSI матч считается идущим, пока часы подтверждены не раньше этого (чтения экрана могут пропадать) */
export const CLOCK_CONFIRM_MS = 30_000;
export const known = <T>(v: F<T>): v is F<T> & { value: T } => v.value !== null;

export function fromTracked<T>(t: Tracked<T> | undefined, wallMs: number): F<T> {
  if (!t || t.value === null) return unknownF();
  return {
    value: t.value,
    source: t.source,
    ageSec: t.lastSeenWallMs === null ? null : Math.max(0, (wallMs - t.lastSeenWallMs) / 1000),
    confidence: t.confidence,
  };
}

const gsiF = <T>(v: T | null | undefined, ageSec: number): F<T> =>
  v === null || v === undefined ? unknownF() : { value: v, source: 'gsi', ageSec, confidence: 1 };

export interface ViewItem {
  slot: string;
  key: string;
  charges: number | null;
  cooldownSec: number | null;
  /** Пассивный предмет; null/нет — не известно (экран) */
  passive?: boolean | null;
  /** Можно нажать сейчас (GSI can_cast); null/нет — не известно */
  canCast?: boolean | null;
}

export interface ViewAbility {
  key: string | null;
  level: number | null;
  ultimate: boolean;
  /** ready | cooldown | no-mana | unlearned */
  state: string | null;
  cooldownSec: number | null;
  /** Пассивная (нажать нельзя); null/нет — не известно */
  passive?: boolean | null;
  /** Полная перезарядка, с; null/нет — не известно */
  maxCooldownSec?: number | null;
}

export interface ViewPlayer {
  slot: number;
  side: 'ally' | 'enemy' | null;
  hero: F<string>;
  alive: F<boolean>;
  respawnAt: F<number>;
  pos: F<MapPoint>;
  missing: boolean | null;
  missingForSec: number | null;
  hpPercent: F<number>;
  /** Уровень с полоски здоровья над героем (последний кадр); null — не видно */
  barLevel: number | null;
}

export interface CoachView {
  wallMs: number;
  sources: { gsi: boolean; screen: boolean };
  /** Матч идёт (GSI in-progress или часы ≥ 0 по экрану) */
  inGame: boolean;
  phase: 'pre-game' | 'in-progress' | 'post-game' | null;
  winTeam: 'radiant' | 'dire' | null;
  matchId: string | null;
  clock: F<number>;
  /** game_time − clock_time из GSI: переводит время событий в игровые часы; null — неизвестно */
  clockOffset: number | null;
  paused: boolean;
  dayNight: F<'day' | 'night'>;
  /** Счёт убийств команд (GSI или верхняя панель) */
  score: { radiant: F<number>; dire: F<number> };
  team: 'radiant' | 'dire' | null;
  me: {
    slot: number | null;
    /** key — ключ героя (из GSI); с экрана известны только id и имя */
    hero: F<{ key: string | null; name: string; id: number | null }>;
    level: F<number>;
    alive: F<boolean>;
    respawnSec: F<number>;
    hp: F<Pool>;
    mana: F<Pool>;
    gold: F<number>;
    goldReliable: F<number>;
    kills: F<number>;
    deaths: F<number>;
    assists: F<number>;
    lastHits: F<number>;
    denies: F<number>;
    gpm: F<number>;
    xpm: F<number>;
    commands: F<number>;
    pos: F<MapPoint>;
    zone: MapZone | null;
    buybackCost: F<number>;
    buybackCooldown: F<number>;
    smoked: F<boolean>;
    talentsTaken: F<number>;
    attributesLevel: F<number>;
    items: ViewItem[];
    /** Предметы известны (GSI или экран) */
    itemsKnown: boolean;
    /** Пустые ячейки по GSI (inv1…, neutral, tp); пусто — не известно или всё занято */
    emptySlots: string[];
    abilities: ViewAbility[];
  };
  allies: ViewPlayer[];
  enemies: ViewPlayer[];
  /**
   * Полоски здоровья на экране (последний кадр). Вражеские считаются «рядом», только если на том же кадре видна
   * своя полоска (камера у героя): так видно 2 врага, даже когда на мини-карте их значки слились в один.
   */
  screen: { meOnScreen: boolean; enemyBars: { hpPercent: number; level: number | null }[]; allyBars: { hpPercent: number; level: number | null }[] };
  buildings: GsiBuilding[] | null;
  events: GsiEvent[] | null;
  /** Предметы врагов, увиденные на их панели (игрок выделял героя): id героя, предмет, сколько секунд назад видели */
  enemyItems?: { heroId: number; key: string; ageSec: number }[];
}

/** Ниже этой уверенности полоска врага не считается (тени, крипы, обрезанные края) */
export const ENEMY_BAR_MIN_CONFIDENCE = 0.5;

const hpPct = (p: Pool | null): number | null => (p && p.max > 0 ? (p.current / p.max) * 100 : null);
export const poolPct = hpPct;

function player(p: MatchState['players'][number], s: MatchState): ViewPlayer {
  const bar = s.healthBars.find((b) => b.slot === p.slot);
  return {
    slot: p.slot,
    side: p.side,
    hero: fromTracked(p.hero, s.wallMs),
    alive: fromTracked(p.alive, s.wallMs),
    respawnAt: fromTracked(p.respawnAt, s.wallMs),
    pos: fromTracked(p.position, s.wallMs),
    missing: p.missing,
    missingForSec: p.missingSinceWallMs === null ? null : Math.max(0, (s.wallMs - p.missingSinceWallMs) / 1000),
    hpPercent: fromTracked(p.hpPercent, s.wallMs),
    barLevel: bar?.level ?? null,
  };
}

/**
 * Снимок для правил. gsi — последнее чтение GSI (null — нет); gsiWallMs — когда оно пришло.
 * GSI считается свежим, только если state.sources.gsi = true.
 */
export function buildView(s: MatchState, gsi: GsiReading | null, gsiWallMs: number | null): CoachView {
  const wallMs = s.wallMs;
  const g = s.sources.gsi && gsi ? gsi : null;
  const gAge = g && gsiWallMs !== null ? Math.max(0, (wallMs - gsiWallMs) / 1000) : 0;
  const x = g?.extra;
  const clock = fromTracked(s.match.clock, wallMs);
  const phase = g?.phase ?? null;
  // Матч идёт: после горна, а также 90 с до горна (DOTA_GAMERULES_STATE_PRE_GAME: герои на карте, руны в 0:00)
  const preHorn = g?.gameState === 'DOTA_GAMERULES_STATE_PRE_GAME';
  // Без свежего GSI матч «идёт», только если часы недавно подтверждены (экраном или GSI), а не досчитаны моделью,
  // и последнее чтение GSI не было концом матча: иначе после победы подсказки шли бы по часам, которые никто не видит
  const ended = gsi?.phase === 'post-game';
  const clockSeen = s.match.clock.lastSeenWallMs !== null && wallMs - s.match.clock.lastSeenWallMs <= CLOCK_CONFIRM_MS;
  const inGame = phase !== null ? phase === 'in-progress' || preHorn : !ended && clockSeen && clock.value !== null && clock.value >= -90;

  const kda = fromTracked(s.hero.kda, wallMs);
  const farm = fromTracked(s.hero.farm, wallMs);
  const pick = <T>(v: F<{ [k: string]: unknown }>, k: string): F<T> => (v.value === null ? unknownF() : { ...v, value: v.value[k] as T });

  const pos: F<MapPoint> =
    g && g.hero.x !== null && g.hero.y !== null
      ? gsiF({ x: g.hero.x, y: g.hero.y }, gAge)
      : (() => {
          const own = s.players.find((p) => g?.slot !== null && p.slot === g?.slot);
          return own ? fromTracked(own.position, wallMs) : unknownF<MapPoint>();
        })();

  // Предметы: из GSI (с зарядами), иначе с экрана
  let items: ViewItem[] = [];
  let itemsKnown = false;
  let emptySlots: string[] = [];
  if (g?.items) {
    itemsKnown = true;
    emptySlots = g.items.filter((i) => !i.key).map((i) => i.slot);
    items = g.items.filter((i) => i.key).map((i) => ({ slot: i.slot, key: i.key!, charges: i.charges, cooldownSec: i.cooldownSec, passive: i.passive ?? null, canCast: i.canCast ?? null }));
  } else {
    const all = [...s.hero.items, ...(s.hero.extraItems ?? [])];
    itemsKnown = all.some((i) => i.value !== null);
    items = all.filter((i) => i.value?.item).map((i) => ({ slot: i.slot, key: i.value!.item!.key, charges: null, cooldownSec: null }));
  }

  const abilities: ViewAbility[] = g
    ? g.abilities
        .filter((a) => a.slot !== null)
        .map((a) => ({ key: a.key, level: a.level, ultimate: a.ultimate === true, state: a.state, cooldownSec: a.cooldownSec, passive: a.passive, maxCooldownSec: a.maxCooldownSec ?? null }))
    : s.hero.abilities.map((a) => ({
        key: a.key,
        level: a.level.value,
        ultimate: false,
        state: a.state.value,
        cooldownSec: a.cooldown.value,
      }));

  const identity = fromTracked(s.hero.identity, wallMs);
  const hero: F<{ key: string | null; name: string; id: number | null }> = g
    ? gsiF({ key: g.hero.key, name: g.hero.name ?? g.hero.key, id: g.hero.id }, gAge)
    : identity.value
      ? { ...identity, value: { key: null, name: identity.value.name, id: identity.value.id } }
      : unknownF();

  return {
    wallMs,
    sources: s.sources,
    inGame,
    phase,
    winTeam: x?.winTeam ?? null,
    matchId: g?.matchId ?? null,
    clock,
    clockOffset: g && g.gameTime !== null && g.clock !== null ? g.gameTime - g.clock : null,
    paused: s.match.paused,
    dayNight: fromTracked(s.match.dayNight, wallMs),
    score: { radiant: fromTracked(s.match.scoreRadiant, wallMs), dire: fromTracked(s.match.scoreDire, wallMs) },
    team: s.ourTeam,
    me: {
      slot: g?.slot ?? null,
      hero,
      level: fromTracked(s.hero.level, wallMs),
      alive: g && g.hero.alive !== null ? gsiF(g.hero.alive, gAge) : unknownF(),
      respawnSec: g ? gsiF(g.hero.respawnSec, gAge) : unknownF(),
      hp: fromTracked(s.hero.health, wallMs),
      mana: fromTracked(s.hero.mana, wallMs),
      gold: fromTracked(s.hero.gold, wallMs),
      goldReliable: g ? gsiF(g.goldReliable, gAge) : unknownF(),
      kills: pick<number>(kda as F<never>, 'kills'),
      deaths: pick<number>(kda as F<never>, 'deaths'),
      assists: pick<number>(kda as F<never>, 'assists'),
      lastHits: pick<number>(farm as F<never>, 'lastHits'),
      denies: pick<number>(farm as F<never>, 'denies'),
      gpm: gsiF(x?.gpm, gAge),
      xpm: gsiF(x?.xpm, gAge),
      commands: gsiF(x?.commandsIssued, gAge),
      pos,
      zone: pos.value ? mapZone(pos.value.x, pos.value.y) : null,
      buybackCost: gsiF(x?.buybackCost, gAge),
      buybackCooldown: gsiF(x?.buybackCooldown, gAge),
      smoked: gsiF(x?.smoked, gAge),
      talentsTaken: gsiF(x?.talentsTaken, gAge),
      attributesLevel: gsiF(x?.attributesLevel, gAge),
      items,
      itemsKnown,
      emptySlots,
      abilities,
    },
    allies: s.allies.filter((p) => g?.slot === null || g?.slot === undefined || p.slot !== g.slot).map((p) => player(p, s)),
    enemies: s.enemies.map((p) => player(p, s)),
    screen: {
      meOnScreen: g?.slot !== null && g?.slot !== undefined && s.healthBars.some((b) => b.slot === g.slot),
      enemyBars: s.healthBars.filter((b) => b.side === 'enemy' && b.confidence >= ENEMY_BAR_MIN_CONFIDENCE).map((b) => ({ hpPercent: b.hpPercent, level: b.level })),
      // Зелёные полоски союзников на экране (кроме своей): к героям они не привязываются — уровень знаем только свой
      allyBars: s.healthBars.filter((b) => b.side === 'ally' && b.confidence >= ENEMY_BAR_MIN_CONFIDENCE && (g?.slot === null || g?.slot === undefined || b.slot !== g.slot)).map((b) => ({ hpPercent: b.hpPercent, level: b.level })),
    },
    buildings: x?.buildings ?? null,
    events: x?.events ?? null,
    enemyItems: (s.enemyItems ?? []).flatMap((e) => e.items.map((i) => ({ heroId: e.heroId, key: i.key, ageSec: Math.max(0, Math.round((s.wallMs - i.lastWallMs) / 1000)) }))),
  };
}

/** Факт для подсказки из значения снимка */
export function fact<T extends string | number | boolean>(key: string, label: string, v: F<T>, verified = true): FactRef {
  return { key, label, value: v.value, source: v.source ?? 'derived', ageSec: v.ageSec, confidence: v.confidence, verified };
}

export function derivedFact(key: string, label: string, value: string | number | boolean | null, confidence: number, verified = true): FactRef {
  return { key, label, value, source: 'derived', ageSec: 0, confidence, verified };
}

export function kbFact(key: string, label: string, value: string | number | null, verified: boolean, source: 'kb' | 'stats' = 'kb'): FactRef {
  return { key, label, value, source, ageSec: null, confidence: value === null ? 0 : 1, verified };
}

/** Уверенность значения с учётом возраста: свежее — как есть, старое — линейно падает до 0 к maxAgeSec */
export function freshConfidence<T>(v: F<T>, maxAgeSec: number): number {
  if (v.value === null || v.ageSec === null) return 0;
  return v.confidence * Math.max(0, 1 - v.ageSec / maxAgeSec);
}
