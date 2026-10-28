// Драфт с экрана выбора героев: какие герои у Сил Света и Сил Тьмы (src/core/vision/draft-screen.ts).
// Герой принимается, когда одно и то же место показало его DRAFT_CONFIRM_READS чтений подряд: портреты на экране драфта
// неподвижны, а случайное совпадение на кадре загрузки или анимации повторяется редко.
// Живёт вне сброса матча: начало игры (часы, GSI) сбрасывает модель, а драфт нужен именно тогда. Новый драфт —
// когда после долгой паузы (DRAFT_NEW_AFTER_MS) экран драфта снова показал героев.
// Своя команда: из GSI; без GSI — та, чьи пики видны, пока у другой все места закрыты (флажки врагов во время пиков).
import type { DraftScreenReading } from '../vision/draft-screen.ts';
import type { Team } from '../vision/top-bar.ts';

export const DRAFT_CONFIRM_READS = 2;
/** Дольше этого экран драфта не показывал героев — следующие герои считаются новым драфтом */
export const DRAFT_NEW_AFTER_MS = 10 * 60_000;
/** Столько чтений подряд одна команда с героями, а другая пустая — значит, это наша (враги скрыты) */
const OWN_TEAM_READS = 3;

export interface DraftSnapshot {
  radiant: string[];
  dire: string[];
  /** Своя команда: gsi — из игры, screen — по закрытым пикам врагов, null — неизвестна */
  ourTeam: Team | null;
  ourTeamSource: 'gsi' | 'screen' | null;
  /** Когда экран драфта последний раз показал героя (wallMs) */
  lastSeenWallMs: number;
}

export class DraftTrack {
  private teams: Record<Team, string[]> = { radiant: [], dire: [] };
  /** Кандидат на каждое место: герой и сколько чтений подряд */
  private pending = new Map<number, { key: string; reads: number }>();
  private lastSeenWallMs: number | null = null;
  private gsiTeam: Team | null = null;
  private screenTeam: Team | null = null;
  private loneReads: Record<Team, number> = { radiant: 0, dire: 0 };

  setOurTeam(team: Team | null): void {
    if (team) this.gsiTeam = team;
  }

  ingest(r: DraftScreenReading, wallMs: number): void {
    if (!r.supported) return;
    const seen = r.slots.filter((s) => s.heroKey !== null);
    if (seen.length === 0) {
      this.pending.clear();
      return;
    }
    if (this.lastSeenWallMs !== null && wallMs - this.lastSeenWallMs > DRAFT_NEW_AFTER_MS) this.restart();
    this.lastSeenWallMs = wallMs;
    for (const s of r.slots) {
      if (s.heroKey === null) {
        this.pending.delete(s.index);
        continue;
      }
      const p = this.pending.get(s.index);
      const reads = p && p.key === s.heroKey ? p.reads + 1 : 1;
      this.pending.set(s.index, { key: s.heroKey, reads });
      const list = this.teams[s.team];
      if (reads >= DRAFT_CONFIRM_READS && !list.includes(s.heroKey) && list.length < 5) {
        // герой мог оказаться в другой команде из-за ошибки — убираем его оттуда
        const other = this.teams[s.team === 'radiant' ? 'dire' : 'radiant'];
        const i = other.indexOf(s.heroKey);
        if (i >= 0) other.splice(i, 1);
        list.push(s.heroKey);
      }
    }
    // Своя команда по экрану: у одной команды есть герои, у другой — ни одного (вражеские пики закрыты)
    const has = (t: Team) => seen.some((s) => s.team === t);
    for (const t of ['radiant', 'dire'] as const) {
      const other: Team = t === 'radiant' ? 'dire' : 'radiant';
      this.loneReads[t] = has(t) && !has(other) ? this.loneReads[t] + 1 : 0;
      if (this.loneReads[t] >= OWN_TEAM_READS && this.screenTeam === null) this.screenTeam = t;
    }
  }

  snapshot(): DraftSnapshot | null {
    if (this.lastSeenWallMs === null || (this.teams.radiant.length === 0 && this.teams.dire.length === 0)) return null;
    const ourTeam = this.gsiTeam ?? this.screenTeam;
    return {
      radiant: [...this.teams.radiant],
      dire: [...this.teams.dire],
      ourTeam,
      ourTeamSource: this.gsiTeam ? 'gsi' : this.screenTeam ? 'screen' : null,
      lastSeenWallMs: this.lastSeenWallMs,
    };
  }

  private restart(): void {
    this.teams = { radiant: [], dire: [] };
    this.pending.clear();
    this.gsiTeam = null;
    this.screenTeam = null;
    this.loneReads = { radiant: 0, dire: 0 };
  }
}
