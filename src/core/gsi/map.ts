// Перевод тела GSI в чтение коуча (GsiReading). Ничего не додумывает: нет значения в GSI → null.
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { AbilityState } from '../vision/abilities.ts';
import type { DayNight } from '../vision/day-night.ts';
import type { Farm, Kda, Pool } from '../vision/hud-fields.ts';
import { parseGsiBody, type GsiAbilityRaw, type GsiBody, type GsiItemRaw } from './schema.ts';
import { detectGameMode, type GameModeInfo } from './mode.ts';

/** Стадия матча по game_state */
export type GsiPhase = 'pre-game' | 'in-progress' | 'post-game';

export interface GsiAbility {
  /** N из ключа abilityN — порядок в GSI */
  index: number;
  /**
   * Номер ячейки на панели способностей (с 0), как index у зрения. null — способность не показывается на панели
   * (служебные plus_*, таланты и т. п.): такие не сравниваются с экраном и не попадают в модель.
   */
  slot: number | null;
  /** Ключ способности, например nevermore_shadowraze1 */
  key: string;
  level: number | null;
  /**
   * ready | cooldown | no-mana | unlearned; null — по данным GSI не определить
   * (нельзя применить, но перезарядки нет, а герой мёртв, оглушён или под немотой).
   * no-mana — вывод: GSI не сообщает стоимость маны, только can_cast = false без перезарядки.
   */
  state: AbilityState | null;
  /** Секунды до готовности; 0 — готова; null — GSI не сообщил */
  cooldownSec: number | null;
  ultimate: boolean | null;
  passive: boolean | null;
  /** Полная перезарядка, с (max_cooldown); null — GSI не сообщил */
  maxCooldownSec?: number | null;
}

export interface GsiItemSlot {
  /** inv1…inv6, bp1…bp3, stash1…stash6, tp, neutral, neutral2 */
  slot: string;
  /** Ключ без «item_»; null — ячейка пустая */
  key: string | null;
  /** Имя из справочника; если справочник не знает ключ — сам ключ */
  name: string | null;
  charges: number | null;
  cooldownSec: number | null;
  /** Пассивный предмет (нажать нельзя); null — GSI не сообщил */
  passive?: boolean | null;
  /** Можно нажать сейчас; null — GSI не сообщил (пассивный предмет или пустая ячейка) */
  canCast?: boolean | null;
}

export interface GsiReading {
  matchId: string | null;
  /** Режим игры по map.game_mode / customgamename; null — в теле нет блока map */
  gameMode: GameModeInfo | null;
  /** Сырой game_state, например DOTA_GAMERULES_STATE_GAME_IN_PROGRESS */
  gameState: string | null;
  phase: GsiPhase | null;
  /** Игровое время, секунды (clock_time; до горна отрицательное) */
  clock: number | null;
  /** Время с загрузки карты, секунды (game_time) */
  gameTime: number | null;
  paused: boolean | null;
  dayNight: DayNight | null;
  scoreRadiant: number | null;
  scoreDire: number | null;
  team: 'radiant' | 'dire' | null;
  /** Ячейка своего героя на верхней панели (0–9): team_slot для Сил Света, 5 + team_slot для Сил Тьмы; null — неизвестна */
  slot: number | null;
  hero: {
    /** Ключ без «npc_dota_hero_», например nevermore */
    key: string;
    id: number | null;
    /** Отображаемое имя из справочника; null — справочник не передан или не знает героя */
    name: string | null;
    level: number | null;
    alive: boolean | null;
    respawnSec: number | null;
    /** Координаты на карте (единицы мира); null — GSI не прислал */
    x: number | null;
    y: number | null;
    health: Pool | null;
    mana: Pool | null;
  };
  gold: number | null;
  goldReliable: number | null;
  goldUnreliable: number | null;
  kda: Kda | null;
  farm: Farm | null;
  abilities: GsiAbility[];
  /** null — блока items в GSI нет (не включён в конфигурации) */
  items: GsiItemSlot[] | null;
  /** provider.timestamp, секунды Unix; null — не сообщён */
  timestamp: number | null;
  /** Данные для подсказок (с 0.12.0); нет поля — чтение старой версии или запись до 0.12.0 */
  extra?: GsiExtra;
}

/** Здание своей команды из блока buildings */
export interface GsiBuilding {
  /** Ключ Valve без префикса команды, например tower1_top, rax_melee_mid, fort */
  key: string;
  health: number;
  maxHealth: number;
}

export interface GsiEvent {
  type: string;
  /** game_time события, секунды; null — не сообщено */
  gameTime: number | null;
  team: string | null;
}

/** Поля GSI, которые нужны подсказкам. null — Dota не прислала */
export interface GsiExtra {
  buybackCost: number | null;
  /** Секунды до готовности выкупа; 0 — готов */
  buybackCooldown: number | null;
  gpm: number | null;
  xpm: number | null;
  commandsIssued: number | null;
  smoked: boolean | null;
  magicImmune: boolean | null;
  hasDebuff: boolean | null;
  silenced: boolean | null;
  stunned: boolean | null;
  scepter: boolean | null;
  shard: boolean | null;
  /** Сколько талантов взято (talent_1…8); null — Dota не прислала */
  talentsTaken: number | null;
  /** Очков в характеристиках; null — Dota не прислала */
  attributesLevel: number | null;
  /** Победитель (map.win_team) после конца матча; null — матч идёт или не сообщено */
  winTeam: 'radiant' | 'dire' | null;
  /** Свои здания; null — блока buildings нет */
  buildings: GsiBuilding[] | null;
  /** События (последние, что прислала Dota); null — блока events нет */
  events: GsiEvent[] | null;
}

export type ItemNameLookup = (key: string) => string | undefined;
export type HeroLookup = (key: string) => { id: number; name: string } | undefined;

const HERO_PREFIX = 'npc_dota_hero_';
const ITEM_PREFIX = 'item_';

/** Способности, которых нет на панели: служебные, таланты, общие для всех героев */
const OFF_BAR = /^(plus_|special_bonus_|generic_hidden|seasonal_|ability_|twin_gate_portal_warp|abyssal_underlord_portal_warp)/;

const PRE_GAME_STATES = new Set([
  'DOTA_GAMERULES_STATE_INIT',
  'DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD',
  'DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD',
  'DOTA_GAMERULES_STATE_CUSTOM_GAME_SETUP',
  'DOTA_GAMERULES_STATE_PLAYER_DRAFT',
  'DOTA_GAMERULES_STATE_HERO_SELECTION',
  'DOTA_GAMERULES_STATE_STRATEGY_TIME',
  'DOTA_GAMERULES_STATE_TEAM_SHOWCASE',
  'DOTA_GAMERULES_STATE_PRE_GAME',
]);
const POST_GAME_STATES = new Set(['DOTA_GAMERULES_STATE_POST_GAME', 'DOTA_GAMERULES_STATE_DISCONNECT']);

export function gsiPhase(gameState: string | null | undefined): GsiPhase | null {
  if (!gameState) return null;
  if (gameState === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS') return 'in-progress';
  if (PRE_GAME_STATES.has(gameState)) return 'pre-game';
  if (POST_GAME_STATES.has(gameState)) return 'post-game';
  return null;
}

/** Ячейки GSI → ячейки коуча */
export function gsiSlotName(key: string): string | null {
  let m = /^slot(\d)$/.exec(key);
  if (m) {
    const n = Number(m[1]);
    if (n <= 5) return `inv${n + 1}`;
    if (n <= 8) return `bp${n - 5}`;
    return null;
  }
  m = /^stash(\d)$/.exec(key);
  if (m && Number(m[1]) <= 5) return `stash${Number(m[1]) + 1}`;
  if (key === 'teleport0') return 'tp';
  if (key === 'neutral0') return 'neutral';
  if (key === 'neutral1') return 'neutral2';
  return null;
}

const SLOT_ORDER = ['inv1', 'inv2', 'inv3', 'inv4', 'inv5', 'inv6', 'bp1', 'bp2', 'bp3', 'stash1', 'stash2', 'stash3', 'stash4', 'stash5', 'stash6', 'tp', 'neutral', 'neutral2'];

const n = (v: number | undefined): number | null => (v === undefined ? null : v);
const b = (v: boolean | undefined): boolean | null => (v === undefined ? null : v);

function pool(current: number | undefined, max: number | undefined): Pool | null {
  if (current === undefined || max === undefined || max <= 0) return null;
  return { current, max };
}

function abilityState(a: GsiAbilityRaw, hero: GsiBody['hero']): AbilityState | null {
  if (a.level === undefined) return null;
  if (a.level === 0) return 'unlearned';
  if (a.cooldown !== undefined && a.cooldown > 0) return 'cooldown';
  if (a.can_cast === undefined) return null;
  if (a.can_cast || a.passive) return 'ready';
  // Нельзя применить без перезарядки: у живого героя без контроля это нехватка маны, иначе причину не узнать
  const disabled = hero?.alive === false || hero?.silenced === true || hero?.stunned === true || hero?.hexed === true;
  return disabled ? null : 'no-mana';
}

function mapAbilities(raw: GsiBody['abilities'], hero: GsiBody['hero']): GsiAbility[] {
  if (!raw) return [];
  const list: { index: number; a: GsiAbilityRaw }[] = [];
  for (const [k, a] of Object.entries(raw)) {
    const m = /^ability(\d+)$/.exec(k);
    if (!m || !a || !a.name) continue;
    list.push({ index: Number(m[1]), a });
  }
  list.sort((x, y) => x.index - y.index);
  let slot = 0;
  return list.map(({ index, a }) => {
    const key = a.name!;
    const onBar = !OFF_BAR.test(key);
    return {
      index,
      slot: onBar ? slot++ : null,
      key,
      level: n(a.level),
      state: abilityState(a, hero),
      cooldownSec: n(a.cooldown),
      ultimate: b(a.ultimate),
      passive: b(a.passive),
      maxCooldownSec: n(a.max_cooldown),
    };
  });
}

function mapItems(raw: GsiBody['items'], itemName?: ItemNameLookup): GsiItemSlot[] | null {
  if (!raw) return null;
  const out: GsiItemSlot[] = [];
  for (const [k, it] of Object.entries(raw)) {
    const slot = gsiSlotName(k);
    if (!slot || !it || it.name === undefined) continue;
    out.push(mapItem(slot, it, itemName));
  }
  return out.sort((x, y) => SLOT_ORDER.indexOf(x.slot) - SLOT_ORDER.indexOf(y.slot));
}

function mapItem(slot: string, it: GsiItemRaw, itemName?: ItemNameLookup): GsiItemSlot {
  const raw = it.name!;
  if (raw === 'empty' || raw === '') return { slot, key: null, name: null, charges: null, cooldownSec: null };
  const key = raw.startsWith(ITEM_PREFIX) ? raw.slice(ITEM_PREFIX.length) : raw;
  return { slot, key, name: itemName?.(key) ?? key, charges: n(it.charges), cooldownSec: n(it.cooldown), passive: b(it.passive), canCast: b(it.can_cast) };
}

/**
 * Тело GSI → чтение коуча. Принимает уже разобранное тело или сырое (объект, JSON-строку).
 * null — не матч своего героя: нет блока map или hero (меню, наблюдение за чужой игрой, выбор героя).
 * itemName — справочник имён предметов по ключу без «item_»; heroLookup — id и имя героя по ключу.
 */
export function mapGsi(body: unknown, itemName?: ItemNameLookup, heroLookup?: HeroLookup): GsiReading | null {
  const parsed = parseGsiBody(body);
  if (!parsed.ok) return null;
  const { map, player, hero, abilities, items, provider, buildings, events } = parsed.body;
  // У наблюдателя hero — словарь команд, а не герой: имени нет
  if (!map || !hero || !hero.name || !hero.name.startsWith(HERO_PREFIX)) return null;

  const key = hero.name.slice(HERO_PREFIX.length);
  const known = heroLookup?.(key);
  const team = player?.team_name === 'radiant' || player?.team_name === 'dire' ? player.team_name : null;
  const kda =
    player && player.kills !== undefined && player.deaths !== undefined && player.assists !== undefined
      ? { kills: player.kills, deaths: player.deaths, assists: player.assists }
      : null;
  const farm = player && player.last_hits !== undefined && player.denies !== undefined ? { lastHits: player.last_hits, denies: player.denies } : null;
  const dayNight: DayNight | null = map.nightstalker_night === true ? 'night' : map.daytime === undefined ? null : map.daytime ? 'day' : 'night';

  return {
    matchId: map.matchid && map.matchid !== '0' ? map.matchid : null,
    gameMode: detectGameMode(body),
    gameState: map.game_state ?? null,
    phase: gsiPhase(map.game_state),
    clock: map.clock_time === undefined ? null : Math.trunc(map.clock_time),
    gameTime: n(map.game_time),
    paused: b(map.paused),
    dayNight,
    scoreRadiant: n(map.radiant_score),
    scoreDire: n(map.dire_score),
    team,
    slot: team !== null && typeof player?.team_slot === 'number' && player.team_slot >= 0 && player.team_slot <= 4 ? (team === 'dire' ? 5 : 0) + player.team_slot : null,
    hero: {
      key,
      id: hero.id !== undefined && hero.id > 0 ? hero.id : (known?.id ?? null),
      name: known?.name ?? null,
      level: hero.level !== undefined && hero.level > 0 ? hero.level : null,
      alive: b(hero.alive),
      respawnSec: n(hero.respawn_seconds),
      x: typeof hero.xpos === 'number' ? hero.xpos : null,
      y: typeof hero.ypos === 'number' ? hero.ypos : null,
      health: pool(hero.health, hero.max_health),
      mana: hero.max_mana === 0 && hero.mana === 0 ? { current: 0, max: 0 } : pool(hero.mana, hero.max_mana),
    },
    gold: n(player?.gold),
    goldReliable: n(player?.gold_reliable),
    goldUnreliable: n(player?.gold_unreliable),
    kda,
    farm,
    abilities: mapAbilities(abilities, hero),
    items: mapItems(items, itemName),
    timestamp: n(provider?.timestamp),
    extra: {
      buybackCost: n(hero.buyback_cost),
      buybackCooldown: n(hero.buyback_cooldown),
      gpm: n(player?.gpm),
      xpm: n(player?.xpm),
      commandsIssued: n(player?.commands_issued),
      smoked: b(hero.smoked),
      magicImmune: b(hero.magicimmune),
      hasDebuff: b(hero.has_debuff),
      silenced: b(hero.silenced),
      stunned: b(hero.stunned),
      scepter: b(hero.aghanims_scepter),
      shard: b(hero.aghanims_shard),
      talentsTaken: talentsTaken(hero),
      attributesLevel: n(hero.attributes_level),
      winTeam: map.win_team === 'radiant' || map.win_team === 'dire' ? map.win_team : null,
      buildings: mapBuildings(buildings, team),
      events: events ? events.filter((e) => e !== null && typeof e.event_type === 'string').map((e) => ({ type: e!.event_type!, gameTime: n(e!.game_time), team: e!.team ?? null })) : null,
    },
  };
}

function talentsTaken(hero: NonNullable<GsiBody['hero']>): number | null {
  const flags = [hero.talent_1, hero.talent_2, hero.talent_3, hero.talent_4, hero.talent_5, hero.talent_6, hero.talent_7, hero.talent_8];
  if (flags.every((f) => f === undefined)) return null;
  return flags.filter((f) => f === true).length;
}

const BUILDING_PREFIX = /^dota_(goodguys|badguys)_/;

function mapBuildings(raw: GsiBody['buildings'], team: 'radiant' | 'dire' | null): GsiBuilding[] | null {
  if (!raw) return null;
  // В режиме игрока приходит только своя команда; если команд несколько — берём свою
  const block = (team && raw[team]) || Object.values(raw).find((v) => v) || null;
  if (!block) return [];
  const out: GsiBuilding[] = [];
  for (const [k, v] of Object.entries(block)) {
    if (!v || typeof v.health !== 'number' || typeof v.max_health !== 'number' || v.max_health <= 0) continue;
    out.push({ key: k.replace(BUILDING_PREFIX, ''), health: v.health, maxHealth: v.max_health });
  }
  return out;
}
