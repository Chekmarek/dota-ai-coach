// Данные для правил: база знаний патча (герои, предметы, механика) и статистика патча (stats.json).
// Ничего не выдумываем: нет записи — null, и правило либо молчит, либо помечает факт «не проверено».
import type { KbHero, KbItem } from '../../shared/types/kb.ts';
import type { MechanicsEntry } from '../../shared/types/mechanics.ts';
import type { HeroStats, KbStats } from '../../shared/types/stats.ts';

export interface CoachData {
  patch: string | null;
  heroes: KbHero[];
  items: KbItem[];
  mechanics: MechanicsEntry[];
  stats: KbStats | null;
  /** База знаний сверена вручную? (сейчас — imported-unverified) */
  kbVerified: boolean;
}

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

const INVIS_RE = /(станов\w*|оставаясь|делает[^.]{0,40}|там он)\s+невидим/i;

export class CoachLookup {
  readonly heroByKey = new Map<string, KbHero>();
  readonly heroById = new Map<number, KbHero>();
  readonly itemByKey = new Map<string, KbItem>();
  readonly statsById = new Map<number, HeroStats>();
  readonly invisHeroes = new Set<string>();
  readonly abilityByKey = new Map<string, { hero: KbHero; name: string; innate: boolean }>();

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
  mechanic(id: string): MechanicsEntry | null {
    return this.data.mechanics.find((m) => m.id === id) ?? null;
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

  /** Сборка героя по профессиональным матчам патча: только готовые предметы, по медианной минуте покупки */
  buildFor(heroId: number | null | undefined, heroKey?: string | null): { key: string; share: number; medianMin: number }[] {
    const st = this.statsFor(heroId, heroKey);
    return (st?.pro?.build ?? []).filter((b) => !this.isComponent(b.key) && this.itemByKey.has(b.key) && b.share >= 0.2);
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
}
