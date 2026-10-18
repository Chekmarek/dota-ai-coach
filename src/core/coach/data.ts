// Данные для правил: база знаний патча (герои, предметы, механика) и статистика патча (stats.json).
// Ничего не выдумываем: нет записи — null, и правило либо молчит, либо помечает факт «не проверено».
import type { KbHero, KbItem } from '../../shared/types/kb.ts';
import type { MechanicsEntry } from '../../shared/types/mechanics.ts';
import type { HeroStats, KbStats } from '../../shared/types/stats.ts';
import { modeRule, turboMechanics, type ModeOverrides } from '../knowledge-base/modes.ts';
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
  /** pro — профи патча (точная медиана минуты); popular — популярные предметы (минута примерная) */
  source: 'pro' | 'popular';
}

// «Становится невидимым», «оставаясь невидимым», «делает … невидимым», «получает невидимость».
// Не \w: в JavaScript он не совпадает с русскими буквами («станов\w*» не ловило «становится»)
const INVIS_RE = /(станов[а-яё]*|оставаясь|делает[^.]{0,40}|там он|получает)\s+невидим/i;

export class CoachLookup {
  readonly heroByKey = new Map<string, KbHero>();
  readonly heroById = new Map<number, KbHero>();
  readonly itemByKey = new Map<string, KbItem>();
  readonly statsById = new Map<number, HeroStats>();
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

  /** Матчап героя a против b по публичным матчам патча: [игр, доля побед a]; null — нет данных */
  matchup(aKey: string, bKey: string): { games: number; winrate: number; base: number } | null {
    const a = this.heroByKey.get(aKey);
    const b = this.heroByKey.get(bKey);
    if (!a || !b) return null;
    const st = this.statsById.get(a.id);
    const m = st?.matchups[String(b.id)];
    if (!st?.pub || !m) return null;
    return { games: m[0], winrate: m[1], base: st.pub.winrate };
  }

  /** Связка: a и b в одной команде по публичным матчам патча; null — нет данных */
  synergy(aKey: string, bKey: string): { games: number; winrate: number } | null {
    const a = this.heroByKey.get(aKey);
    const b = this.heroByKey.get(bKey);
    if (!a || !b) return null;
    const m = this.statsById.get(a.id)?.synergy[String(b.id)];
    return m ? { games: m[0], winrate: m[1] } : null;
  }

  /** Общая доля побед героя в публичных матчах патча; null — нет данных */
  winrate(key: string): number | null {
    const h = this.heroByKey.get(key);
    return h ? (this.statsById.get(h.id)?.pub?.winrate ?? null) : null;
  }
}
