// Союзники и враги по верхней панели (этап 1 зрения): кто в какой ячейке, жив ли, когда возродится.
// Мини-карта (этап 2): где герой (видно сейчас / видели раньше и как давно) и «пропал» — враг жив, его уже видели,
// но на мини-карте нет дольше MISSING_AFTER_MS.
// Полоски здоровья (этап 3): видимые сейчас полоски героев с командой и % здоровья; к игроку полоска привязывается,
// только когда это несомненно — уровень на полоске совпадает с известным уровнем ровно одного игрока этой команды
// и полоска с таким уровнем и цветом на кадре одна (иллюзии и клоны одинаковы с героем — тогда не привязываем).
// Герой ячейки фиксируется, когда несколько уверенных чтений подряд согласны (как свой герой в HeroTrack),
// и дальше не меняется до нового матча. «Жив» и «возродится в» — устойчивые поля с подтверждением повтором.
// Чистое ядро: время передаётся снаружи.
import type { TopBarReading, Team } from '../vision/top-bar.ts';
import type { MinimapReading } from '../vision/minimap.ts';
import { barTeam, type HealthBarsReading } from '../vision/health-bars.ts';
import { StableField, unknownTracked } from './stable-field.ts';
import type { Tracked } from './types.ts';

/** Сколько согласных уверенных чтений героя ячейки нужно для фиксации */
export const PLAYER_LOCK_READS = 5;
/** Окно, в котором считаются чтения героя ячейки (мс) */
export const PLAYER_LOCK_WINDOW_MS = 30_000;
/** Доля чтений за окно, которая должна совпасть с героем-кандидатом */
export const PLAYER_LOCK_SHARE = 0.8;
/** Сколько помним «жив» и «возродится в» без новых чтений (мс): верхняя панель видна почти всегда */
export const PLAYER_TTL_MS = 10_000;
/** Зафиксированного героя ячейки помним весь матч (сброс — только новым матчем) */
export const PLAYER_HERO_TTL_MS = 4 * 3_600_000;
/** Возрождение в пределах этого (с) — то же самое время (таймер тикает, кадр и часы читаются не одновременно) */
const RESPAWN_TOLERANCE_SEC = 2;
/** Враг «пропал», если жив, его уже видели, а на мини-карте нет дольше этого (мс) */
export const MISSING_AFTER_MS = 3000;
/** Позиция «видно сейчас», пока последнее чтение моложе этого (мс); дальше — «видели раньше» */
export const POSITION_VISIBLE_MS = 1500;
/** Последнюю позицию помним столько (мс); дальше — неизвестно */
export const POSITION_TTL_MS = 5 * 60_000;
/** Здоровье с полоски помним столько (мс); до POSITION_VISIBLE_MS — «видно сейчас», дальше — «видели раньше» */
export const HP_TTL_MS = 10_000;
/** Известный уровень игрока (из GSI) годится для привязки полоски столько (мс) */
const LEVEL_TTL_MS = 10_000;

export interface MapPoint {
  /** Координаты мира Dota (единицы карты) */
  x: number;
  y: number;
}

export interface TrackedPlayer {
  /** Ячейка верхней панели = номер игрока в GSI: 0–4 Силы Света, 5–9 Силы Тьмы */
  slot: number;
  team: Team;
  /** Союзник или враг; null — своя команда неизвестна (нет GSI игрока) */
  side: 'ally' | 'enemy' | null;
  /** Герой зафиксирован (до нового матча) */
  locked: boolean;
  /** Ключ героя, например «nevermore» */
  hero: Tracked<string>;
  alive: Tracked<boolean>;
  /** Игровое время возрождения (секунды); только пока герой мёртв и таймер прочитан при известных часах */
  respawnAt: Tracked<number>;
  /** Где герой: «видно сейчас» (значок на мини-карте) или «видели раньше» (последнее место, возраст — lastSeenWallMs) */
  position: Tracked<MapPoint>;
  /**
   * Враг пропал: жив (не известно, что мёртв), его уже видели, но на мини-карте нет дольше MISSING_AFTER_MS.
   * null — не определить (ещё ни разу не видели, мини-карта не читается, союзник или своя команда неизвестна).
   */
  missing: boolean | null;
  /** С какого момента пропал (мс); null — не пропал */
  missingSinceWallMs: number | null;
  /** Здоровье, % — с полоски над героем (только если полоска привязана к игроку несомненно), TTL HP_TTL_MS */
  hpPercent: Tracked<number>;
}

/** Полоска здоровья героя, видная на последнем кадре */
export interface VisibleHealthBar {
  team: Team;
  side: 'ally' | 'enemy' | null;
  hpPercent: number;
  /** Уровень с полоски; null — не прочитан */
  level: number | null;
  /** Ячейка игрока, если привязка несомненна; иначе null (герой не назван) */
  slot: number | null;
  /** Левый верхний угол заливки, пиксели кадра */
  x: number;
  y: number;
  confidence: number;
}

export interface PlayersSnapshot {
  /** Своя команда (из GSI игрока); null — неизвестна: союзников и врагов не различаем */
  ourTeam: Team | null;
  /** Все 10 ячеек по порядку (пусто, пока верхняя панель ни разу не прочитана) */
  players: TrackedPlayer[];
  allies: TrackedPlayer[];
  enemies: TrackedPlayer[];
  /** Полоски здоровья героев на экране (последний кадр не старше POSITION_VISIBLE_MS); пусто — не видно или не читались */
  healthBars: VisibleHealthBar[];
}

class PlayerSlot {
  locked: string | null = null;
  /** Последние уверенные чтения героя: ключ и время */
  private reads: { key: string; wallMs: number }[] = [];
  hero = new StableField<string>({ equals: (a, b) => a === b });
  alive = new StableField<boolean>({ equals: (a, b) => a === b });
  respawnAt = new StableField<number>({ equals: (a, b) => Math.abs(a - b) <= RESPAWN_TOLERANCE_SEC, fastConfidence: null });
  /** Последнее место на мини-карте */
  lastPos: { p: MapPoint; wallMs: number; confidence: number; ambiguous: boolean } | null = null;
  /** Последнее здоровье с привязанной полоски */
  lastHp: { value: number; wallMs: number; confidence: number } | null = null;
  /** Уровень из GSI (известен только у своего героя) */
  level: { value: number; wallMs: number } | null = null;

  readonly slot: number;
  readonly team: Team;

  constructor(slot: number, team: Team) {
    this.slot = slot;
    this.team = team;
  }

  ingestHero(key: string | null, confidence: number, wallMs: number): void {
    if (this.locked) {
      // Зафиксированный герой только подтверждается
      if (key === this.locked) this.hero.ingest(key, Math.max(confidence, 0.9), true, wallMs);
      return;
    }
    if (key === null) return;
    this.reads.push({ key, wallMs });
    this.reads = this.reads.filter((r) => wallMs - r.wallMs <= PLAYER_LOCK_WINDOW_MS);
    const n = this.reads.filter((r) => r.key === key).length;
    if (n >= PLAYER_LOCK_READS && n / this.reads.length >= PLAYER_LOCK_SHARE) {
      this.locked = key;
      this.hero.ingest(key, 1, true, wallMs);
    }
  }
}

export class PlayersTrack {
  private slots: PlayerSlot[] = [];
  private ourTeam: Team | null = null;
  /** Когда мини-карта последний раз читалась (поддерживаемый кадр); null — ещё не читалась */
  private minimapAt: number | null = null;
  private bars: { list: VisibleHealthBar[]; wallMs: number } | null = null;

  private ensureSlots(): void {
    if (this.slots.length === 0) this.slots = Array.from({ length: 10 }, (_, s) => new PlayerSlot(s, s < 5 ? 'radiant' : 'dire'));
  }

  /** Уровень игрока из GSI (свой герой): по нему полоска с тем же уровнем привязывается к ячейке */
  setLevel(slot: number, level: number, wallMs: number): void {
    this.ensureSlots();
    const p = this.slots[slot];
    if (p) p.level = { value: level, wallMs };
  }

  /** Одно чтение полосок здоровья. Неподдерживаемый кадр ничего не меняет */
  ingestHealthBars(r: HealthBarsReading, wallMs: number): void {
    if (!r.supported) return;
    this.ensureSlots();
    const side = (t: Team) => (this.ourTeam === null ? null : t === this.ourTeam ? 'ally' : 'enemy');
    const list: VisibleHealthBar[] = r.bars.map((b) => {
      const team = barTeam(b.color, this.ourTeam);
      let slot: number | null = null;
      if (b.level !== null) {
        const same = r.bars.filter((o) => o.color === b.color && o.level === b.level).length;
        const cands = this.slots.filter((p) => p.team === team && p.level && wallMs - p.level.wallMs <= LEVEL_TTL_MS && p.level.value === b.level);
        if (same === 1 && cands.length === 1) slot = cands[0]!.slot;
      }
      return { team, side: side(team), hpPercent: b.hpPercent, level: b.level, slot, x: b.x, y: b.y, confidence: b.confidence };
    });
    for (const b of list) {
      if (b.slot === null) continue;
      this.slots[b.slot]!.lastHp = { value: b.hpPercent, wallMs, confidence: b.confidence };
    }
    this.bars = { list, wallMs };
  }

  /** Своя команда из GSI игрока (team_name) */
  setOurTeam(team: Team | null): void {
    if (team) this.ourTeam = team;
  }

  /**
   * Одно чтение верхней панели. clockSec — игровое время этого кадра (для «возродится в»); null — неизвестно.
   * Неподдерживаемый кадр (не 16:9, нет раскладки) ничего не меняет.
   */
  ingest(r: TopBarReading, clockSec: number | null, wallMs: number): void {
    if (!r.supported) return;
    if (this.slots.length === 0) this.slots = r.slots.map((s) => new PlayerSlot(s.slot, s.team));
    for (const s of r.slots) {
      const p = this.slots[s.slot];
      if (!p) continue;
      p.ingestHero(s.heroKey, s.heroConfidence, wallMs);
      if (s.alive !== null) p.alive.ingest(s.alive, s.aliveConfidence, true, wallMs);
      if (s.alive === false && s.respawnSec !== null && clockSec !== null) p.respawnAt.ingest(clockSec + s.respawnSec, s.respawnConfidence, true, wallMs);
    }
  }

  /** Одно чтение мини-карты: найденные значки обновляют позиции (герой по номеру ячейки — по цвету значка) */
  ingestMinimap(r: MinimapReading, wallMs: number): void {
    if (!r.supported) return;
    this.minimapAt = wallMs;
    this.ensureSlots();
    for (const h of r.heroes) {
      const p = this.slots[h.slot];
      if (p) p.lastPos = { p: { x: h.x, y: h.y }, wallMs, confidence: h.confidence, ambiguous: h.ambiguous };
    }
  }

  snapshot(wallMs: number): PlayersSnapshot {
    const side = (t: Team) => (this.ourTeam === null ? null : t === this.ourTeam ? 'ally' : 'enemy');
    const players: TrackedPlayer[] = this.slots.map((p) => {
      const alive = p.alive.tracked(wallMs, PLAYER_TTL_MS);
      return {
        slot: p.slot,
        team: p.team,
        side: side(p.team),
        locked: p.locked !== null,
        hero: p.locked ? p.hero.tracked(wallMs, PLAYER_HERO_TTL_MS) : unknownTracked<string>(),
        alive,
        // Возрождение — только пока известно, что герой мёртв
        respawnAt: alive.value === false ? p.respawnAt.tracked(wallMs, PLAYER_TTL_MS) : unknownTracked<number>(),
        position: positionTracked(p.lastPos, wallMs),
        ...missingOf(p, alive.value, side(p.team), this.minimapAt, wallMs),
        // Мёртвый герой без полоски: прежнее здоровье больше не правда
        hpPercent: alive.value === false ? unknownTracked<number>() : hpTracked(p.lastHp, wallMs),
      };
    });
    return {
      ourTeam: this.ourTeam,
      players,
      allies: players.filter((p) => p.side === 'ally'),
      enemies: players.filter((p) => p.side === 'enemy'),
      healthBars: this.bars && wallMs - this.bars.wallMs <= POSITION_VISIBLE_MS ? this.bars.list : [],
    };
  }
}

function hpTracked(last: PlayerSlot['lastHp'], wallMs: number): Tracked<number> {
  if (!last || wallMs - last.wallMs > HP_TTL_MS) return unknownTracked<number>();
  return {
    value: last.value,
    confidence: last.confidence,
    tag: wallMs - last.wallMs > POSITION_VISIBLE_MS ? 'remembered' : 'visible',
    lastSeenWallMs: last.wallMs,
    firstSeenWallMs: last.wallMs,
    source: 'screen',
  };
}

function positionTracked(last: PlayerSlot['lastPos'], wallMs: number): Tracked<MapPoint> {
  if (!last) return unknownTracked<MapPoint>();
  const age = wallMs - last.wallMs;
  if (age > POSITION_TTL_MS) return unknownTracked<MapPoint>();
  return {
    value: last.p,
    confidence: last.confidence,
    // Несколько значков (иллюзии, клоны) — «вывод»: значок есть, но не обязательно это сам герой
    tag: age > POSITION_VISIBLE_MS ? 'remembered' : last.ambiguous ? 'inferred' : 'visible',
    lastSeenWallMs: last.wallMs,
    firstSeenWallMs: last.wallMs,
    source: 'screen',
  };
}

/** «Пропал» — только у врага, которого уже видели, пока он не мёртв и мини-карта читается */
function missingOf(p: PlayerSlot, alive: boolean | null, side: 'ally' | 'enemy' | null, minimapAt: number | null, wallMs: number): { missing: boolean | null; missingSinceWallMs: number | null } {
  const unknown = { missing: null, missingSinceWallMs: null };
  if (side !== 'enemy' || !p.lastPos || alive === false) return unknown;
  // Мини-карта давно не читалась (нет кадров) — сказать, пропал ли враг, нельзя
  if (minimapAt === null || wallMs - minimapAt > POSITION_VISIBLE_MS) return unknown;
  const gone = minimapAt - p.lastPos.wallMs;
  return gone >= MISSING_AFTER_MS ? { missing: true, missingSinceWallMs: p.lastPos.wallMs + MISSING_AFTER_MS } : { missing: false, missingSinceWallMs: null };
}
