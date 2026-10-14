// Союзники и враги по верхней панели (этап 1 зрения): кто в какой ячейке, жив ли, когда возродится.
// Герой ячейки фиксируется, когда несколько уверенных чтений подряд согласны (как свой герой в HeroTrack),
// и дальше не меняется до нового матча. «Жив» и «возродится в» — устойчивые поля с подтверждением повтором.
// Чистое ядро: время передаётся снаружи.
import type { TopBarReading, Team } from '../vision/top-bar.ts';
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
}

export interface PlayersSnapshot {
  /** Своя команда (из GSI игрока); null — неизвестна: союзников и врагов не различаем */
  ourTeam: Team | null;
  /** Все 10 ячеек по порядку (пусто, пока верхняя панель ни разу не прочитана) */
  players: TrackedPlayer[];
  allies: TrackedPlayer[];
  enemies: TrackedPlayer[];
}

class PlayerSlot {
  locked: string | null = null;
  /** Последние уверенные чтения героя: ключ и время */
  private reads: { key: string; wallMs: number }[] = [];
  hero = new StableField<string>({ equals: (a, b) => a === b });
  alive = new StableField<boolean>({ equals: (a, b) => a === b });
  respawnAt = new StableField<number>({ equals: (a, b) => Math.abs(a - b) <= RESPAWN_TOLERANCE_SEC, fastConfidence: null });

  constructor(
    readonly slot: number,
    readonly team: Team,
  ) {}

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
      };
    });
    return {
      ourTeam: this.ourTeam,
      players,
      allies: players.filter((p) => p.side === 'ally'),
      enemies: players.filter((p) => p.side === 'enemy'),
    };
  }
}
