// Тело GSI в режиме наблюдателя (просмотр записи или чужой игры в клиенте Dota) → список всех 10 героев.
// Нужен только для разметки кадров (набор данных для проверки зрения), в модель матча не идёт.
// В режиме наблюдателя Valve вкладывает данные по командам и игрокам:
//   hero:   { team2: { player0: {...}, …, player4 }, team3: { player5: {...}, … } }
//   player: { team2: { player0: { team_name, … } }, … }
// team2 — Силы Света, team3 — Силы Тьмы. Формат — по публичным описаниям GSI; на настоящей записи ещё не проверен.
// Режим игрока (mapGsi) этот модуль не трогает. Чистое ядро: без Electron, DOM, сети и файлов.

export type SpectatorTeam = 'radiant' | 'dire';

export interface SpectatorHero {
  team: SpectatorTeam;
  /** Номер игрока из ключа playerN (0–9) */
  slot: number;
  /** Ключ героя без «npc_dota_hero_»; null — герой ещё не выбран */
  heroKey: string | null;
  /** Координаты на карте (единицы мира Dota); null — нет в теле */
  xpos: number | null;
  ypos: number | null;
  alive: boolean | null;
  /** Секунды до возрождения (0 — жив); null — нет в теле */
  respawnSec: number | null;
  health: number | null;
  maxHealth: number | null;
  level: number | null;
}

export interface SpectatorReading {
  /** Игровое время, секунды (map.clock_time); null — нет */
  clock: number | null;
  daytime: boolean | null;
  /** Герои, отсортированные по номеру игрока */
  heroes: SpectatorHero[];
}

const TEAM_KEYS: Record<string, SpectatorTeam> = { team2: 'radiant', team3: 'dire' };

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

function heroKeyOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v.startsWith('npc_dota_hero_')) return null;
  const key = v.slice('npc_dota_hero_'.length);
  return key.length > 0 ? key : null;
}

/**
 * Разбор тела наблюдателя. null — это не тело наблюдателя (режим игрока, меню, мусор).
 * Неверное поле одного героя становится null, а не отбрасывает героя или всё тело.
 */
export function parseSpectatorGsi(raw: unknown): SpectatorReading | null {
  let body = raw;
  if (typeof raw === 'string') {
    try {
      body = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!isObj(body) || !isObj(body.hero)) return null;
  const heroBlock = body.hero;
  // В режиме игрока hero — один герой (есть name/id), а не словарь команд
  if (!Object.keys(heroBlock).some((k) => k in TEAM_KEYS)) return null;

  const heroes: SpectatorHero[] = [];
  for (const [teamKey, team] of Object.entries(TEAM_KEYS)) {
    const players = heroBlock[teamKey];
    if (!isObj(players)) continue;
    for (const [playerKey, h] of Object.entries(players)) {
      const m = /^player(\d+)$/.exec(playerKey);
      if (!m || !isObj(h)) continue;
      heroes.push({
        team,
        slot: Number(m[1]),
        heroKey: heroKeyOf(h.name),
        xpos: num(h.xpos),
        ypos: num(h.ypos),
        alive: bool(h.alive),
        respawnSec: int(h.respawn_seconds),
        health: int(h.health),
        maxHealth: int(h.max_health),
        level: int(h.level),
      });
    }
  }
  if (heroes.length === 0) return null;
  heroes.sort((a, b) => a.slot - b.slot);
  const map = isObj(body.map) ? body.map : {};
  return { clock: num(map.clock_time), daytime: bool(map.daytime), heroes };
}
