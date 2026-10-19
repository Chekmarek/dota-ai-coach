// Данные для правил: база знаний патча (герои, предметы, механика) и статистика патча (stats.json).
// Ничего не выдумываем: нет записи — null, и правило либо молчит, либо помечает факт «не проверено».
import type { KbHero, KbItem } from '../../shared/types/kb.ts';
import type { MechanicsEntry } from '../../shared/types/mechanics.ts';
import type { HeroStats, KbStats } from '../../shared/types/stats.ts';
import type { RankedHero, StatsRanked } from '../../shared/types/stats-ranked.ts';
import type { PlayerProfile } from './profile.ts';
import { modeRule, turboMechanics, type ModeOverrides } from '../knowledge-base/modes.ts';
import type { DangerModel } from './danger-model.ts';
import { UNKNOWN_MODE, type GameModeInfo } from '../gsi/mode.ts';

export interface CoachData {
  patch: string | null;
  heroes: KbHero[];
  items: KbItem[];
  mechanics: MechanicsEntry[];
  stats: KbStats | null;
  /** База знаний сверена вручную? (сейчас — imported-unverified) */
  kbVerified: boolean;
  /** Справочник Турбо (src/data/modes/turbo.json); нет — в Турбо вся механика «не проверено» */
  turbo?: ModeOverrides | null;
  /** Статистика публичных матчей Турбо (stats-turbo.json): матчапы, связки, доля побед; нет — в Турбо их нет */
  statsTurbo?: KbStats | null;
  /** Как играют сильные игроки в рейтинге (stats-ranked.json, STRATZ Divine–Immortal): кривые и покупки по позициям */
  statsRanked?: StatsRanked | null;
  /** Профиль игрока: повторяющиеся ошибки из локальной истории коуча (profile.ts); нет — без напоминаний */
  profile?: PlayerProfile | null;
  /** Модель опасности (src/data/danger-model.json, danger-model.ts); нет — предупреждения о риске только по правилам */
  dangerModel?: DangerModel | null;
}

/** Сильные игроки рейтинга к минуте (средние): добивания, ценность героя, опыт, уровень */
export interface RankedPoint {
  lh: number;
  networth: number;
  xp: number;
  level: number;
  /** Матчей на позиции за неделю */
  n: number;
  position: number;
}

/** Аегис исчезает через (обычная игра), с */
const AEGIS_SEC = 300;

/** Реген и восстановление: ключ предмета → что восстанавливает */
export const REGEN_ITEMS: Record<string, 'hp' | 'mana' | 'both'> = {
  flask: 'hp',
  tango: 'hp',
  faerie_fire: 'hp',
  clarity: 'mana',
  enchanted_mango: 'mana',
  bottle: 'both',
  magic_stick: 'both',
  magic_wand: 'both',
  famango: 'both',
  great_famango: 'both',
  greater_famango: 'both',
};
export const TP_ITEMS = ['tpscroll', 'travel_boots', 'travel_boots_2'];
export const DETECTION_ITEMS = ['dust', 'ward_sentry', 'ward_dispenser', 'gem'];
/** Предметы «ключевого окна»: готовность сильно меняет исход драки */
export const KEY_ITEMS = ['black_king_bar', 'blink', 'refresher', 'sphere', 'aeon_disk', 'manta', 'satanic', 'butterfly', 'abyssal_blade'];

/** Меньше стольких игр профи — сборка по популярным предметам */
export const PRO_BUILD_MIN = 15;
/** Кривая позиции берётся, если на ней столько профи-игроков героя; меньше — кривая по всем позициям */
export const PRO_CURVE_MIN_N = 12;
/** Кривая «все позиции» годится, если доля роли (кор 1–3 или саппорт 4–5) у профи на герое не меньше */
export const PRO_CURVE_SAME_ROLE = 0.75;

/** Профи на герое к минуте: медиана (50) и верхняя четверть (75); null — точки нет */
export interface ProPoint {
  lh50: number | null;
  lh75: number | null;
  gold50: number | null;
  gold75: number | null;
  xp50: number | null;
  xp75: number | null;
  /** Сколько игроков в выборке */
  n: number;
  /** По какой позиции кривая; null — по всем позициям героя */
  position: number | null;
}
/** Примерная минута фаз OpenDota itemPopularity: ранняя 0–10, средняя 10–25, поздняя 25+ */
const POPULAR_PHASE_MIN: readonly ['early' | 'mid' | 'late', number][] = [
  ['early', 7],
  ['mid', 17],
  ['late', 30],
];

export interface BuildItem {
  key: string;
  share: number;
  medianMin: number;
  /** pro — профи патча (точная медиана минуты); popular — популярные предметы (минута примерная); ranked — сильные игроки рейтинга на этой позиции (STRATZ) */
  source: 'pro' | 'popular' | 'ranked';
}

// «Становится невидимым», «оставаясь невидимым», «делает … невидимым», «получает невидимость».
// Не \w: в JavaScript он не совпадает с русскими буквами («станов\w*» не ловило «становится»)
const INVIS_RE = /(станов[а-яё]*|оставаясь|делает[^.]{0,40}|там он|получает)\s+невидим/i;

export class CoachLookup {
  readonly heroByKey = new Map<string, KbHero>();
  readonly heroById = new Map<number, KbHero>();
  readonly itemByKey = new Map<string, KbItem>();
  readonly statsById = new Map<number, HeroStats>();
  readonly turboStatsById = new Map<number, HeroStats>();
  readonly invisHeroes = new Set<string>();
  readonly abilityByKey = new Map<string, { hero: KbHero; name: string; innate: boolean }>();

  /** Режим игры для правил (с ручным выбором пользователя); меняет механику и нормы */
  private gameMode: GameModeInfo = { ...UNKNOWN_MODE };
  private turboMech: MechanicsEntry[] | null = null;

  constructor(readonly data: CoachData) {
    for (const h of data.heroes) {
      this.heroByKey.set(h.key, h);
      this.heroById.set(h.id, h);
      for (const a of h.abilities) {
        this.abilityByKey.set(a.key, { hero: h, name: a.name, innate: a.innate });
        if (!a.innate && INVIS_RE.test(a.descRu ?? '')) this.invisHeroes.add(h.key);
      }
    }
    for (const i of data.items) this.itemByKey.set(i.key, i);
    for (const s of data.stats?.heroes ?? []) this.statsById.set(s.id, s);
    for (const s of data.statsTurbo?.heroes ?? []) this.turboStatsById.set(s.id, s);
  }

  heroName(key: string | null): string {
    if (!key) return 'враг';
    return this.heroByKey.get(key)?.name ?? key;
  }
  itemName(key: string): string {
    return this.itemByKey.get(key)?.name ?? key;
  }
  itemCost(key: string): number | null {
    return this.itemByKey.get(key)?.cost ?? null;
  }
  /** Режим игры сейчас; неизвестен и не Турбо — правила обычной игры */
  setMode(mode: GameModeInfo): void {
    this.gameMode = mode;
  }
  get mode(): GameModeInfo {
    return this.gameMode;
  }
  get isTurbo(): boolean {
    return this.gameMode.mode === 'turbo';
  }
  /** Механика карты для режима: в Турбо — со значениями справочника, непроверенное — «missing» */
  get mechanics(): readonly MechanicsEntry[] {
    if (!this.isTurbo) return this.data.mechanics;
    this.turboMech ??= turboMechanics(this.data.mechanics, this.data.turbo ?? null, this.data.patch);
    return this.turboMech;
  }
  /**
   * Нормы из статистики патча (медианы GPM/XPM, добивания и минуты предметов профи) — только для обычной игры:
   * статистики Турбо нет, а умножать нормы «на глаз» нельзя.
   */
  get hasNorms(): boolean {
    return !this.isTurbo;
  }
  /** Через сколько секунд исчезает аегис; null — в этом режиме не проверено */
  aegisSec(): number | null {
    return this.isTurbo ? modeRule(this.data.turbo ?? null, 'aegisSec') : AEGIS_SEC;
  }
  mechanic(id: string): MechanicsEntry | null {
    return this.mechanics.find((m) => m.id === id) ?? null;
  }
  /** Значение механики (число); null — нет записи или значение не число */
  mechanicValue(id: string, key: string): number | null {
    const v = this.mechanic(id)?.values.find((x) => x.key === key)?.value;
    return typeof v === 'number' ? v : null;
  }
  statsFor(heroId: number | null | undefined, heroKey?: string | null): HeroStats | null {
    if (heroId != null) return this.statsById.get(heroId) ?? null;
    if (heroKey) {
      const h = this.heroByKey.get(heroKey);
      return h ? (this.statsById.get(h.id) ?? null) : null;
    }
    return null;
  }
  /**
   * Как играют профи на этом герое к минуте (обычная игра): добивания, заработанное золото и опыт — медиана и верхняя
   * четверть, по позиции (если игроков на ней хватает) или по всем позициям героя. null — нет данных, минута вне
   * кривой или Турбо (профи в Турбо не играют, а умножать нормы «на глаз» нельзя).
   */
  proAt(heroKey: string | null, position: number | null, minute: number): ProPoint | null {
    if (!this.hasNorms || !heroKey) return null;
    const curves = this.statsFor(null, heroKey)?.pro?.curves;
    if (!curves) return null;
    const byPos = position !== null ? curves[String(position)] : undefined;
    // Своей позиции мало — кривая по всем позициям героя, но только если герой почти всегда в той же роли (кор или
    // саппорт), что и вы: у Ogre Magi «все позиции» — это и центр, и пятёрка (32 добивания к 10:00 — не ориентир саппорту)
    const shares = this.statsFor(null, heroKey)?.pro?.positions ?? null;
    const sameRole = position === null || (shares !== null && (position <= 3 ? shares[0]! + shares[1]! + shares[2]! : shares[3]! + shares[4]!) >= PRO_CURVE_SAME_ROLE);
    const c = byPos && byPos.n >= PRO_CURVE_MIN_N ? byPos : sameRole ? curves['all'] : undefined;
    if (!c) return null;
    const mins = Object.keys(c.at).map(Number).sort((a, b) => a - b);
    if (!mins.length || minute < mins[0]! || minute > mins[mins.length - 1]!) return null;
    const hi = mins.find((m) => m >= minute)!;
    const lo = [...mins].reverse().find((m) => m <= minute)!;
    const a = c.at[String(lo)]!;
    const b = c.at[String(hi)]!;
    const t = hi === lo ? 0 : (minute - lo) / (hi - lo);
    const v = (i: number) => (a[i] == null || b[i] == null ? null : Math.round(a[i]! + (b[i]! - a[i]!) * t));
    return { lh50: v(0), lh75: v(1), gold50: v(2), gold75: v(3), xp50: v(4), xp75: v(5), n: c.n, position: c === byPos ? position : null };
  }

  private rankedByKey: Map<string, RankedHero> | null = null;
  private ranked(heroKey: string | null): RankedHero | null {
    if (!heroKey || !this.data.statsRanked) return null;
    this.rankedByKey ??= new Map(this.data.statsRanked.heroes.map((h) => [h.key, h]));
    return this.rankedByKey.get(heroKey) ?? null;
  }

  /**
   * Сильные игроки рейтинга (STRATZ, Divine–Immortal) на этом герое и позиции к минуте — средние значения.
   * Только обычная игра (это рейтинговые матчи) и только своя позиция: у Ogre Magi центр и пятёрка — разные миры.
   */
  rankedAt(heroKey: string | null, position: number | null, minute: number): RankedPoint | null {
    if (!this.hasNorms || position === null) return null;
    const c = this.ranked(heroKey)?.curves[String(position)];
    if (!c) return null;
    const mins = Object.keys(c.at).map(Number).sort((a, b) => a - b);
    if (!mins.length || minute < mins[0]! || minute > mins[mins.length - 1]!) return null;
    const hi = mins.find((m) => m >= minute)!;
    const lo = [...mins].reverse().find((m) => m <= minute)!;
    const a = c.at[String(lo)]!;
    const b = c.at[String(hi)]!;
    const t = hi === lo ? 0 : (minute - lo) / (hi - lo);
    const v = (i: number) => a[i]! + (b[i]! - a[i]!) * t;
    return { lh: Math.round(v(0)), networth: Math.round(v(1)), xp: Math.round(v(2)), level: Math.round(v(3) * 10) / 10, n: c.n, position };
  }

  /**
   * Сборка для героя на позиции: рейтинг на этой позиции → рейтинг на соседней позиции той же роли (4↔5, 1/2/3) →
   * профи патча, только если профи сами чаще играют героя в этой роли (Ogre Magi у профи — центр: Bottle пятёрке не
   * советуем) → []. Позиция не известна — профи, как раньше.
   */
  buildForPosition(heroId: number | null | undefined, heroKey: string | null, position: number | null): BuildItem[] {
    if (position === null) return this.buildFor(heroId, heroKey);
    const own = this.rankedBuild(heroKey, position);
    if (own.length >= 3) return own;
    const sameRole = position >= 4 ? [4, 5] : [1, 2, 3];
    const m = this.ranked(heroKey)?.matches ?? {};
    for (const p of sameRole.filter((x) => x !== position).sort((a, b) => (m[String(b)] ?? 0) - (m[String(a)] ?? 0))) {
      const other = this.rankedBuild(heroKey, p);
      if (other.length >= 3) return other;
    }
    const shares = this.statsFor(heroId, heroKey)?.pro?.positions ?? null;
    const roleShare = shares ? (position >= 4 ? shares[3]! + shares[4]! : shares[0]! + shares[1]! + shares[2]!) : 0;
    return roleShare >= 0.5 ? this.buildFor(heroId, heroKey) : [];
  }

  /** Самая частая позиция героя у сильных игроков рейтинга (по числу матчей); null — нет данных */
  rankedMainPosition(heroKey: string | null): number | null {
    const m = this.ranked(heroKey)?.matches;
    if (!m) return null;
    const best = Object.entries(m).sort((a, b) => b[1] - a[1])[0];
    return best ? Number(best[0]) : null;
  }

  /**
   * Что покупают сильные игроки рейтинга на этом герое и позиции (по медианной минуте); [] — нет данных.
   * Составные части и дешёвое (< 500) не берём — как и в сборке профи.
   */
  rankedBuild(heroKey: string | null, position: number | null): BuildItem[] {
    if (position === null) return [];
    const list = this.ranked(heroKey)?.items[String(position)] ?? [];
    return list
      .filter((x) => this.itemByKey.has(x.key) && !this.isComponent(x.key) && (this.itemCost(x.key) ?? 0) >= 500 && x.share >= 0.15)
      .map((x) => ({ key: x.key, share: x.share, medianMin: x.medianMin, source: 'ranked' as const }));
  }

  /** Составная часть другого предмета (её саму в сборке не советуем); дорогие (≥ 2000) — исключение: Blink и т. п. */
  isComponent(key: string): boolean {
    this.components ??= new Set(this.data.items.flatMap((i) => i.components));
    return this.components.has(key) && (this.itemCost(key) ?? 0) < 2000;
  }
  private components: Set<string> | null = null;

  /**
   * Сборка героя: по профессиональным матчам патча (готовые предметы, по медианной минуте покупки).
   * Героя почти не берут профи (меньше PRO_BUILD_MIN игр) — запасная сборка из популярных предметов OpenDota:
   * минута там примерная (середина фазы игры), поэтому source = 'popular' и правила «предмет запаздывает» её не берут.
   */
  buildFor(heroId: number | null | undefined, heroKey?: string | null): BuildItem[] {
    const st = this.statsFor(heroId, heroKey);
    const pro = (st?.pro?.build ?? []).filter((b) => !this.isComponent(b.key) && this.itemByKey.has(b.key) && b.share >= 0.2);
    if ((st?.pro?.games ?? 0) >= PRO_BUILD_MIN || !st?.popular) return pro.map((b) => ({ ...b, source: 'pro' as const }));
    const out: BuildItem[] = [];
    for (const [phase, min] of POPULAR_PHASE_MIN) {
      const list = st.popular[phase].filter((x) => !this.isComponent(x.key) && (this.itemCost(x.key) ?? 0) >= 500 && !out.some((o) => o.key === x.key));
      const top = list[0]?.count ?? 0;
      for (const x of list.slice(0, phase === 'early' ? 3 : 4)) out.push({ key: x.key, share: top ? Math.round((x.count / top) * 100) / 100 : 0, medianMin: min, source: 'popular' });
    }
    return out;
  }

  /**
   * Статистика публичных матчей режима: в Турбо — только stats-turbo.json (матчи другого режима не подставляем),
   * иначе — рейтинговый All Pick. Сборки, позиции и нормы (statsFor) — всегда из обычной статистики.
   */
  get pubStats(): KbStats | null {
    return this.isTurbo ? (this.data.statsTurbo ?? null) : this.data.stats;
  }
  private pubById(id: number): HeroStats | undefined {
    return (this.isTurbo ? this.turboStatsById : this.statsById).get(id);
  }

  /** Матчап героя a против b по публичным матчам патча: [игр, доля побед a]; null — нет данных */
  matchup(aKey: string, bKey: string): { games: number; winrate: number; base: number } | null {
    const a = this.heroByKey.get(aKey);
    const b = this.heroByKey.get(bKey);
    if (!a || !b) return null;
    const st = this.pubById(a.id);
    const m = st?.matchups[String(b.id)];
    if (!st?.pub || !m) return null;
    return { games: m[0], winrate: m[1], base: st.pub.winrate };
  }

  /** Связка: a и b в одной команде по публичным матчам патча; null — нет данных */
  synergy(aKey: string, bKey: string): { games: number; winrate: number } | null {
    const a = this.heroByKey.get(aKey);
    const b = this.heroByKey.get(bKey);
    if (!a || !b) return null;
    const m = this.pubById(a.id)?.synergy[String(b.id)];
    return m ? { games: m[0], winrate: m[1] } : null;
  }

  /** Общая доля побед героя в публичных матчах патча; null — нет данных */
  winrate(key: string): number | null {
    const h = this.heroByKey.get(key);
    return h ? (this.pubById(h.id)?.pub?.winrate ?? null) : null;
  }

  /** Сколько публичных матчей героя в статистике режима (для доверия к доле побед); 0 — нет данных */
  pubGames(key: string): number {
    const h = this.heroByKey.get(key);
    return h ? (this.pubById(h.id)?.pub?.games ?? 0) : 0;
  }
}
