// Синтетический матч для тестов движка подсказок: MatchState + чтение GSI с нужными полями.
// Не тест — помощник (vitest берёт только *.test.ts).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { MatchState, Tracked, TrackedPlayer, MapPoint } from '../../src/core/match-state/index.ts';
import type { GsiReading, GsiItemSlot, GsiAbility } from '../../src/core/gsi/map.ts';
import { UNKNOWN_MODE, type GameModeInfo } from '../../src/core/gsi/mode.ts';
import type { CoachData } from '../../src/core/coach/data.ts';
import { parseKbStats } from '../../src/shared/types/stats.ts';
import { parseMechanics } from '../../src/shared/types/mechanics.ts';
import { parseModeOverrides } from '../../src/core/knowledge-base/modes.ts';

const KB = join(import.meta.dirname, '../../resources/data/kb/7.41f');
const json = (f: string) => JSON.parse(readFileSync(join(KB, f), 'utf8'));

let cached: CoachData | null = null;
/** Настоящая база знаний и статистика патча из resources */
export function realData(): CoachData {
  if (cached) return cached;
  const mech = parseMechanics(json('mechanics.json'));
  cached = {
    patch: '7.41f',
    heroes: json('heroes.json'),
    items: json('items.json'),
    mechanics: mech.file?.entries ?? [],
    stats: parseKbStats(json('stats.json'), '7.41f'),
    kbVerified: false,
    turbo: parseModeOverrides(JSON.parse(readFileSync(join(import.meta.dirname, '../../src/data/modes/turbo.json'), 'utf8'))),
  };
  return cached;
}

export const tr = <T>(value: T | null, wallMs: number, source: 'gsi' | 'screen' = 'gsi', confidence = 1): Tracked<T> =>
  value === null
    ? { value: null, confidence: 0, tag: 'unknown', lastSeenWallMs: null, firstSeenWallMs: null, source: null }
    : { value, confidence, tag: 'visible', lastSeenWallMs: wallMs, firstSeenWallMs: wallMs, source };

export interface SimPlayer {
  slot: number;
  hero: string;
  alive?: boolean;
  respawnAt?: number | null;
  /** null — не видно (пропал), undefined — позиция неизвестна вовсе */
  pos?: MapPoint | null;
  missingForSec?: number;
  hpPercent?: number | null;
  barLevel?: number | null;
}

export interface SimInput {
  wallMs: number;
  clock: number;
  /** Режим игры; по умолчанию — неизвестен (как в записях без map.game_mode) */
  mode?: GameModeInfo;
  team?: 'radiant' | 'dire';
  heroKey?: string;
  heroId?: number;
  level?: number;
  hp?: number;
  maxHp?: number;
  mana?: number;
  maxMana?: number;
  gold?: number;
  lastHits?: number;
  kills?: number;
  deaths?: number;
  assists?: number;
  alive?: boolean;
  respawnSec?: number;
  pos?: MapPoint;
  night?: boolean;
  /** Счёт убийств команд; по умолчанию 0:0 */
  scoreRadiant?: number;
  scoreDire?: number;
  paused?: boolean;
  phase?: 'pre-game' | 'in-progress' | 'post-game';
  winTeam?: 'radiant' | 'dire' | null;
  items?: { slot: string; key: string | null; charges?: number | null; cooldownSec?: number | null; passive?: boolean | null; canCast?: boolean | null }[];
  abilities?: Partial<GsiAbility>[];
  buybackCost?: number;
  buybackCooldown?: number;
  gpm?: number;
  xpm?: number;
  commands?: number;
  talentsTaken?: number;
  attributesLevel?: number;
  buildings?: { key: string; health: number; maxHealth: number }[] | null;
  events?: { type: string; gameTime: number | null; team: string | null }[] | null;
  allies?: SimPlayer[];
  enemies?: SimPlayer[];
  /** Без GSI (только экран) */
  noGsi?: boolean;
}

const DEFAULT_ITEMS = [
  { slot: 'inv1', key: 'flask', charges: 1, cooldownSec: 0 },
  { slot: 'inv2', key: 'tango', charges: 3, cooldownSec: 0 },
  { slot: 'tp', key: 'tpscroll', charges: 1, cooldownSec: 0 },
  { slot: 'neutral', key: null },
];

function player(p: SimPlayer, side: 'ally' | 'enemy', team: 'radiant' | 'dire', wallMs: number): TrackedPlayer {
  const slotTeam = p.slot < 5 ? 'radiant' : 'dire';
  const missing = side === 'enemy' && p.pos === null && p.alive !== false;
  const lastSeen = wallMs - (p.missingForSec ?? 0) * 1000;
  return {
    slot: p.slot,
    team: slotTeam,
    side,
    locked: true,
    hero: tr(p.hero, wallMs, 'screen', 0.95),
    alive: tr(p.alive ?? true, wallMs, 'screen', 0.95),
    respawnAt: tr(p.alive === false ? (p.respawnAt ?? null) : null, wallMs, 'screen', 0.9),
    position:
      p.pos === undefined
        ? tr<MapPoint>(null, wallMs)
        : p.pos === null
          ? { value: { x: 0, y: 0 }, confidence: 0.6, tag: 'remembered', lastSeenWallMs: lastSeen, firstSeenWallMs: lastSeen, source: 'screen' }
          : tr(p.pos, wallMs, 'screen', 0.8),
    missing: side === 'enemy' ? (p.pos === undefined ? null : missing) : null,
    missingSinceWallMs: missing ? lastSeen : null,
    hpPercent: tr(p.hpPercent ?? null, wallMs, 'screen', 0.8),
  };
  void team;
}

export function sim(i: SimInput): { state: MatchState; gsi: GsiReading | null } {
  const w = i.wallMs;
  const team = i.team ?? 'radiant';
  const hp = i.hp ?? 800;
  const maxHp = i.maxHp ?? 1000;
  const alive = i.alive ?? true;
  const allies = (i.allies ?? []).map((p) => player(p, 'ally', team, w));
  const enemies = (i.enemies ?? []).map((p) => player(p, 'enemy', team, w));
  const healthBars = (i.enemies ?? [])
    .filter((p) => p.pos && (p.barLevel != null || p.hpPercent != null))
    .map((p) => ({ team: (p.slot < 5 ? 'radiant' : 'dire') as 'radiant' | 'dire', side: 'enemy' as const, hpPercent: p.hpPercent ?? 100, level: p.barLevel ?? null, slot: p.slot, x: 0, y: 0, confidence: 0.8 }));
  const items: GsiItemSlot[] = (i.items ?? DEFAULT_ITEMS).map((x: NonNullable<SimInput['items']>[number]) => ({ slot: x.slot, key: x.key, name: x.key, charges: x.charges ?? null, cooldownSec: x.cooldownSec ?? (x.key ? 0 : null), passive: x.passive ?? null, canCast: x.canCast ?? null }));
  // По умолчанию все очки вложены: уровни способностей в сумме = уровень героя
  const lvl = i.level ?? 8;
  const ult = lvl >= 6 ? 1 : 0;
  const rest = lvl - ult;
  const defAbilities: Partial<GsiAbility>[] = [
    { key: 'antimage_mana_break', level: Math.ceil(rest / 3) },
    { key: 'antimage_blink', level: Math.ceil((rest - Math.ceil(rest / 3)) / 2) },
    { key: 'antimage_counterspell', level: rest - Math.ceil(rest / 3) - Math.ceil((rest - Math.ceil(rest / 3)) / 2) },
    { key: 'antimage_mana_void', level: ult, ultimate: true, state: ult ? 'ready' : 'unlearned' },
  ];
  const abilities: GsiAbility[] = (i.abilities ?? defAbilities).map((a, n) => ({
    index: n,
    slot: n,
    key: a.key ?? `ability${n}`,
    level: a.level ?? 1,
    state: a.state ?? 'ready',
    cooldownSec: a.cooldownSec ?? 0,
    ultimate: a.ultimate ?? false,
    passive: a.passive ?? false,
    maxCooldownSec: a.maxCooldownSec ?? null,
  }));
  const state: MatchState = {
    wallMs: w,
    sources: { gsi: !i.noGsi, screen: true },
    match: {
      clock: tr(i.clock, w),
      paused: i.paused ?? false,
      scoreRadiant: tr(i.scoreRadiant ?? 0, w),
      scoreDire: tr(i.scoreDire ?? 0, w),
      dayNight: tr(i.night ? 'night' : 'day', w),
      mode: i.mode ?? { ...UNKNOWN_MODE },
    },
    hero: {
      locked: true,
      identity: tr({ id: i.heroId ?? 1, name: 'Anti-Mage' }, w),
      level: tr(i.level ?? 8, w),
      gold: tr(i.gold ?? 500, w),
      health: tr({ current: alive ? hp : 0, max: maxHp }, w),
      mana: tr({ current: i.mana ?? 300, max: i.maxMana ?? 400 }, w),
      kda: tr({ kills: i.kills ?? 0, deaths: i.deaths ?? 0, assists: i.assists ?? 0 }, w),
      farm: tr({ lastHits: i.lastHits ?? 40, denies: 5 }, w),
      abilities: [],
      items: [],
    },
    events: [],
    ourTeam: team,
    players: [...allies, ...enemies],
    allies,
    enemies,
    healthBars,
  };
  if (i.noGsi) return { state, gsi: null };
  const gsi: GsiReading = {
    matchId: '123',
    gameMode: i.mode ?? null,
    gameState: null,
    phase: i.phase ?? 'in-progress',
    clock: i.clock,
    gameTime: i.clock + 90,
    paused: i.paused ?? false,
    dayNight: i.night ? 'night' : 'day',
    scoreRadiant: i.scoreRadiant ?? 0,
    scoreDire: i.scoreDire ?? 0,
    team,
    slot: 0,
    hero: {
      key: i.heroKey ?? 'antimage',
      id: i.heroId ?? 1,
      name: 'Anti-Mage',
      level: i.level ?? 8,
      alive,
      respawnSec: alive ? 0 : (i.respawnSec ?? 25),
      x: i.pos?.x ?? -4000,
      y: i.pos?.y ?? -4000,
      health: { current: alive ? hp : 0, max: maxHp },
      mana: { current: i.mana ?? 300, max: i.maxMana ?? 400 },
    },
    gold: i.gold ?? 500,
    goldReliable: 100,
    goldUnreliable: (i.gold ?? 500) - 100,
    kda: { kills: i.kills ?? 0, deaths: i.deaths ?? 0, assists: i.assists ?? 0 },
    farm: { lastHits: i.lastHits ?? 40, denies: 5 },
    abilities,
    items,
    timestamp: null,
    extra: {
      buybackCost: i.buybackCost ?? 500,
      buybackCooldown: i.buybackCooldown ?? 0,
      gpm: i.gpm ?? 500,
      xpm: i.xpm ?? 600,
      commandsIssued: i.commands ?? 0,
      smoked: false,
      magicImmune: false,
      hasDebuff: false,
      silenced: false,
      stunned: false,
      scepter: false,
      shard: false,
      talentsTaken: i.talentsTaken ?? 0,
      attributesLevel: i.attributesLevel ?? 0,
      winTeam: i.winTeam ?? null,
      buildings: i.buildings === undefined ? null : i.buildings,
      events: i.events === undefined ? [] : i.events,
    },
  };
  return { state, gsi };
}
