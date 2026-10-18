// Схема тела POST-запроса Dota 2 Game State Integration (GSI) — терпимая.
// Источник формата: документация Valve по GSI для Dota 2 и публичные примеры конфигураций.
// Неизвестные ключи допускаются, каждый блок необязателен. Поле неверного типа становится undefined,
// а не роняет разбор целиком: одно странное поле не должно лишать коуча остальных данных.
// Чистое ядро: только zod, без Electron, DOM, сети и файлов.
import { z } from 'zod';

/** Необязательное поле: неверный тип → undefined */
const opt = <T extends z.ZodType>(schema: T) => schema.optional().catch(undefined);

const num = opt(z.number().finite());
const int = opt(z.number().int());
const bool = opt(z.boolean());
const str = opt(z.string());
/** matchid в GSI — строка; на всякий случай принимаем и число */
const id = opt(z.union([z.string(), z.number()]).transform((v) => String(v)));

export const gsiProviderSchema = z.looseObject({
  name: str,
  appid: int,
  version: int,
  timestamp: int,
});

export const gsiMapSchema = z.looseObject({
  name: str,
  matchid: id,
  game_time: num,
  clock_time: num,
  daytime: bool,
  nightstalker_night: bool,
  game_state: str,
  paused: bool,
  win_team: str,
  radiant_score: int,
  dire_score: int,
  /** Режим DOTA_GAMEMODE_*: в настоящей записи Hero Demo его нет — разбирается в mode.ts */
  game_mode: opt(z.union([z.string(), z.number()])),
  /** Путь к аддону пользовательской игры (Hero Demo); в матчмейкинге — пусто */
  customgamename: str,
});

export const gsiPlayerSchema = z.looseObject({
  steamid: str,
  name: str,
  activity: str,
  kills: int,
  deaths: int,
  assists: int,
  last_hits: int,
  denies: int,
  gold: int,
  gold_reliable: int,
  gold_unreliable: int,
  team_name: str,
  /** Номер игрока внутри команды (0–4) — ячейка на верхней панели; player_slot — место в лобби, не то */
  team_slot: int,
  gpm: int,
  xpm: int,
  /** Счётчик приказов игрока — по нему видно простой (с 0.12.0) */
  commands_issued: int,
});

/** Здание своей команды (блок buildings: { radiant: { dota_goodguys_tower1_top: {...} } }) */
export const gsiBuildingSchema = z.looseObject({
  health: int,
  max_health: int,
});

/** Событие матча (блок events): roshan_killed, aegis_picked_up, bounty_rune_pickup, courier_killed, … */
export const gsiEventSchema = z.looseObject({
  game_time: num,
  event_type: str,
  team: str,
});

export const gsiHeroSchema = z.looseObject({
  id: int,
  name: str,
  level: int,
  alive: bool,
  respawn_seconds: int,
  /** Координаты героя на карте (единицы мира) — для калибровки мини-карты по своему герою */
  xpos: num,
  ypos: num,
  health: int,
  max_health: int,
  mana: int,
  max_mana: int,
  silenced: bool,
  stunned: bool,
  hexed: bool,
  /** Стоимость выкупа и секунды до его готовности (с 0.12.0 — для подсказок о выкупе) */
  buyback_cost: int,
  buyback_cooldown: num,
  smoked: bool,
  magicimmune: bool,
  has_debuff: bool,
  muted: bool,
  aghanims_scepter: bool,
  aghanims_shard: bool,
  talent_1: bool,
  talent_2: bool,
  talent_3: bool,
  talent_4: bool,
  talent_5: bool,
  talent_6: bool,
  talent_7: bool,
  talent_8: bool,
  /** Сколько очков вложено в характеристики (+2 ко всем) */
  attributes_level: int,
});

export const gsiAbilitySchema = z.looseObject({
  name: str,
  level: int,
  can_cast: bool,
  passive: bool,
  ability_active: bool,
  cooldown: num,
  max_cooldown: num,
  ultimate: bool,
});

export const gsiItemSchema = z.looseObject({
  /** "empty" — пустая ячейка */
  name: str,
  charges: int,
  cooldown: num,
  /** Есть только у предметов с нажатием; у пассивных (Heart, Assault Cuirass) — passive: true */
  can_cast: bool,
  passive: bool,
});

/**
 * Запись словаря (ability0…, slot0… и т. п.): объект нужной формы или null.
 * Неподходящее значение отбрасывается только для своей записи, а не для всего блока.
 */
const entry = <T extends z.ZodType>(schema: T) =>
  z.unknown().transform((v): z.infer<T> | null => {
    const r = schema.safeParse(v);
    return r.success ? (r.data as z.infer<T>) : null;
  });

export const gsiBodySchema = z.looseObject({
  provider: opt(gsiProviderSchema),
  map: opt(gsiMapSchema),
  player: opt(gsiPlayerSchema),
  hero: opt(gsiHeroSchema),
  /** ability0…abilityN; другие ключи (например, attributes) пропускаются при разборе */
  abilities: opt(z.record(z.string(), entry(gsiAbilitySchema))),
  /** slot0…slot8, stash0…stash5, teleport0, neutral0 и, возможно, другие ячейки */
  items: opt(z.record(z.string(), entry(gsiItemSchema))),
  /** Свои здания по командам (с 0.12.0); в режиме игрока Dota присылает только свою команду */
  buildings: opt(z.record(z.string(), opt(z.record(z.string(), entry(gsiBuildingSchema))))),
  /** Последние события матча (с 0.12.0) */
  events: opt(z.array(entry(gsiEventSchema))),
  auth: opt(z.looseObject({ token: str })),
});

export type GsiBody = z.infer<typeof gsiBodySchema>;
export type GsiAbilityRaw = z.infer<typeof gsiAbilitySchema>;
export type GsiItemRaw = z.infer<typeof gsiItemSchema>;

export type GsiParseResult = { ok: true; body: GsiBody } | { ok: false; error: string };

/**
 * Разбор тела запроса. Никогда не бросает исключение.
 * Принимает объект (или JSON-строку с объектом); всё прочее — ошибка.
 */
export function parseGsiBody(raw: unknown): GsiParseResult {
  let value = raw;
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: 'тело запроса — не JSON' };
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: 'тело запроса — не объект' };
  const r = gsiBodySchema.safeParse(value);
  return r.success ? { ok: true, body: r.data } : { ok: false, error: r.error.issues.map((i) => i.message).join('; ') };
}
