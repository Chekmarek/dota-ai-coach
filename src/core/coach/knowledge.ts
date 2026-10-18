// Знания на матч (ночная задача, этап 2): как только известны мой герой, позиция и враги, из локальной базы (STRATZ —
// рейтинг Divine–Immortal, OpenDota — профи и публичные матчи) собирается всё нужное на этот матч: моя сборка и
// ориентиры, для каждого врага — вероятная позиция, угрозы, ключевые предметы с минутой покупки у сильных игроков,
// мой матчап против него. Собирается один раз (пересобирается, когда меняется состав) — подсказки берут из кэша,
// без сети и без задержек. Чистое ядро.
import { enemyThreats, type ThreatId } from '../draft/index.ts';
import { counterDelta } from '../draft/suggest.ts';
import type { BuildItem, CoachLookup } from './data.ts';
import type { CoachView } from './view.ts';
import type { GameContext } from './game-context.ts';

export interface EnemyKnowledge {
  key: string;
  name: string;
  /** Вероятная позиция: самая частая у сильных игроков рейтинга; null — нет данных */
  position: number | null;
  threats: ThreatId[];
  /** Ключевые предметы (≥ 2000 золота, берут в ≥ 30% матчей) у сильных игроков на этой позиции, по минуте */
  keyItems: { key: string; name: string; minute: number; share: number }[];
  /** Мой матчап против него: отклонение доли побед от ожидаемой (−0,03 = −3%) и число игр; null — нет данных */
  vsMe: { delta: number; games: number } | null;
}

export interface MatchKnowledge {
  /** Подпись состава: при смене героев знания пересобираются */
  sig: string;
  me: { key: string | null; position: number | null; build: BuildItem[]; benchmark: 'ranked' | 'pro' | null };
  enemies: EnemyKnowledge[];
  /** Угрозы вражеской команды: угроза → герои */
  threats: { id: ThreatId; nameRu: string; heroes: string[] }[];
}

export const KEY_ITEM_MIN_COST = 2000;
export const KEY_ITEM_MIN_SHARE = 0.3;

export function knowledgeSig(v: CoachView, g: GameContext): string {
  const enemies = [...new Set(v.enemies.map((e) => e.hero.value).filter((k): k is string => !!k))].sort();
  return [g.hero.key ?? '-', g.position ?? '-', g.scale, ...enemies].join('|');
}

export function buildMatchKnowledge(v: CoachView, g: GameContext, look: CoachLookup): MatchKnowledge {
  const me = g.hero.key;
  const hero = v.me.hero.value;
  const build = hero ? look.buildForPosition(hero.id, me, g.position) : [];
  const enemyKeys = [...new Set(v.enemies.map((e) => e.hero.value).filter((k): k is string => !!k))];
  const threats = enemyThreats(enemyKeys, look.invisHeroes);
  const enemies = enemyKeys.map((key): EnemyKnowledge => {
    const position = look.rankedMainPosition(key);
    const keyItems = look
      .rankedBuild(key, position)
      .filter((b) => (look.itemCost(b.key) ?? 0) >= KEY_ITEM_MIN_COST && b.share >= KEY_ITEM_MIN_SHARE)
      .map((b) => ({ key: b.key, name: look.itemName(b.key), minute: b.medianMin, share: b.share }));
    const d = me ? counterDelta(look, me, key) : null;
    return { key, name: look.heroName(key), position, threats: threats.filter((t) => t.heroes.includes(key)).map((t) => t.threat.id), keyItems, vsMe: d ? { delta: d.delta, games: d.games } : null };
  });
  const benchmark = me && g.position !== null && look.rankedAt(me, g.position, 10) ? 'ranked' : me && look.proAt(me, g.position, 10) ? 'pro' : null;
  return {
    sig: knowledgeSig(v, g),
    me: { key: me, position: g.position, build, benchmark },
    enemies,
    threats: threats.map((t) => ({ id: t.threat.id, nameRu: t.threat.nameRu, heroes: t.heroes })),
  };
}
