// Типы базы знаний (формат файлов resources/data/kb/<патч>/*.json, см. scripts/import-kb.mjs)

export type Verification = 'verified' | 'imported-unverified' | 'missing';

export interface KbSource {
  name: string;
  url: string;
  license?: string;
  commit?: { sha: string; date: string } | null;
  retrievedAt: string;
  covers: string[];
}

export interface KbMeta {
  patch: string;
  patchDate: string;
  generatedAt: string;
  verification: Verification;
  note: string;
  sources: KbSource[];
  counts: { heroes: number; items: number; abilities: number; itemsByAvailability?: Partial<Record<KbItemAvailability, number>> };
  /** Где Valve исправил OpenDota (цена, рецепт, части) — для отчёта */
  priceCorrections?: string[];
}

export interface KbAbility {
  id: number;
  key: string;
  name: string;
  descRu: string | null;
  maxLevel: number;
  cooldowns: number[];
  manaCosts: number[];
  castRanges: number[];
  innate: boolean;
  scepter: boolean;
  shard: boolean;
}

export interface KbHero {
  id: number;
  key: string;
  name: string;
  primaryAttr: 'str' | 'agi' | 'int' | 'all' | null;
  attackType: 'melee' | 'ranged' | null;
  complexity: number;
  roles: string[];
  stats: {
    str: { base: number; gain: number };
    agi: { base: number; gain: number };
    int: { base: number; gain: number };
    damageMin: number;
    damageMax: number;
    attackRate: number;
    attackRange: number;
    projectileSpeed: number;
    armor: number;
    magicResist: number;
    moveSpeed: number;
    turnRate: number;
    sightDay: number;
    sightNight: number;
    maxHealth: number;
    healthRegen: number;
    maxMana: number;
    manaRegen: number;
  };
  abilities: KbAbility[];
  talents: string[];
}

export interface KbItem {
  id: number;
  key: string;
  name: string;
  cost: number | null;
  components: string[];
  recipeCost: number | null;
  quality: string | null;
  neutralTier: number | null;
  cooldown: number | null;
  manaCost: number | null;
  attributes: { key: string; value: string; display: string | null }[];
  abilities: { type: string; title: string; description: string }[];
  /**
   * Где предмет берётся в текущем патче (по данным Valve datafeed):
   * shop — магазин или сборка; neutral — нейтральный предмет текущего набора; not-sold — не продаётся
   * (добыча, событие и т. п.); removed — нет в игре (нет в datafeed или собираемый предмет с ценой 0).
   * Нет поля — данные старого формата (до 0.9.0), считаем shop.
   */
  availability?: KbItemAvailability;
  /** Откуда цена и рецепт: valve — Valve datafeed, opendota — dotaconstants (Valve такого предмета не знает) */
  priceSource?: 'valve' | 'opendota';
  componentsSource?: 'valve' | 'opendota';
  /** Почему цена не сходится, если расхождение есть в самих данных Valve (одна строка) */
  priceNote?: string | null;
}

export type KbItemAvailability = 'shop' | 'neutral' | 'not-sold' | 'removed';

/** Автоматическая самопроверка базы: найденные противоречия */
export interface KbAudit {
  /** Цена предмета ≠ сумма частей + рецепт; reason — известная причина (если есть) */
  costMismatches: { key: string; name: string; cost: number; computed: number; reason?: string | null }[];
  /** Компонент рецепта отсутствует в базе */
  unknownComponents: { key: string; component: string }[];
}

export interface KnowledgeBase {
  meta: KbMeta;
  heroes: KbHero[];
  items: KbItem[];
  audit: KbAudit;
  /** Какая копия загружена: asar — из обновления приложения, external — рядом с программой */
  copy: 'asar' | 'external';
}
