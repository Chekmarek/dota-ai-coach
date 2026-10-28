// Драфт в матче: угрозы вражеской команды и предметы против них, слабые матчапы, ожидаемые предметы врагов.
// Герои врагов — из данных игры и экрана (верхняя панель, до неё — экран выбора героев); пока их меньше трёх — молчим.
import { KEY_ITEMS } from '../data.ts';
import { ANSWER_ANY_HERO, counterItems, ENEMY_ITEM_ANSWERS, enemyThreats, itemRole, pctRu, worstMatchups } from '../../draft/index.ts';
import { derivedFact, fact, kbFact } from '../view.ts';
import { draft, knowledge, mmss, playing, plural, purchaseWait, type Rule, type RuleContext } from './context.ts';
import type { HintDraft } from '../types.ts';

/** Враги: с верхней панели матча; пока её героев не видно — с экрана выбора героев (если своя команда известна) */
const enemyKeys = (c: RuleContext): string[] => {
  const fromBar = [...new Set(c.v.enemies.map((e) => e.hero.value).filter((k): k is string => !!k))];
  const d = c.v.draft;
  if (fromBar.length > 0 || !d?.ourTeam) return fromBar;
  return [...(d.ourTeam === 'radiant' ? d.dire : d.radiant)];
};

/** Ключ моего героя: из данных игры, а с экрана — по id */
export function myHeroKey(c: RuleContext): string | null {
  const h = c.v.me.hero.value;
  if (!h) return null;
  return h.key ?? (h.id !== null ? (c.look.heroById.get(h.id)?.key ?? null) : null);
}

export function myRole(c: RuleContext): 'core' | 'support' | null {
  const key = myHeroKey(c);
  if (!key) return null;
  return itemRole(c.look.statsFor(null, key)?.pro?.positions, c.look.heroByKey.get(key)?.roles ?? [], c.look.statsFor(null, key)?.pro?.games ?? 0);
}

function owned(c: RuleContext): Set<string> {
  return new Set([...c.mem.items.keys(), ...c.v.me.items.map((i) => i.key)]);
}

/** Один раз в начале матча: чем опасны враги, что покупать и против кого тяжелее всего */
export const enemyDraftRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const me = myHeroKey(c);
  if (!c.v.inGame || clock === null || clock > 8 * 60 || !me || c.mem.once.has('draft:overview')) return null;
  const enemies = enemyKeys(c);
  if (enemies.length < 3) return null;
  const role = myRole(c);
  if (!role) return null;
  c.mem.once.add('draft:overview');
  const threats = enemyThreats(enemies, c.look.invisHeroes).slice(0, 3);
  const items = counterItems(threats, role, owned(c)).slice(0, 3);
  const worst = worstMatchups(c.look, me, enemies, 1)[0] ?? null;
  if (!threats.length && !worst) return null;
  const threatText = threats.map((t) => `${t.threat.nameRu} (${t.heroes.map((h) => c.look.heroName(h)).join(', ')})`).join('; ');
  const itemText = items.map((i) => c.look.itemName(i.key)).join(', ');
  const worstText = worst ? ` Тяжелее всего против ${c.look.heroName(worst.hero)} (${pctRu(worst.delta)} к победе).` : '';
  return draft({
    id: 'draft.overview',
    category: 'economy',
    priority: 'info',
    confidence: 0.75,
    short: itemText ? `Против врагов: ${itemText}` : `Осторожно: ${c.look.heroName(worst!.hero)}`,
    normal: `${threatText ? `У врагов ${threatText}.` : ''}${itemText ? ` Полезно купить: ${itemText}.` : ''}${worstText}`.trim(),
    facts: [
      derivedFact('enemies', 'Враги', enemies.map((e) => c.look.heroName(e)).join(', '), 0.8),
      derivedFact('role', 'Роль для предметов', role === 'support' ? 'саппорт' : 'кор', 0.7),
      ...(worst ? [kbFact('worst', `Против ${c.look.heroName(worst.hero)}, игр ${worst.games}`, pctRu(worst.delta), false, 'stats')] : []),
    ],
    ttlSec: 14,
    cooldownSec: 0,
    icon: items[0] ? `item:${items[0].key}` : null,
  });
};

/** Предмет против угрозы: срочный (пыль против невидимки) — как только хватает золота; остальные — с 8-й минуты */
export const counterItemRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const gold = c.v.me.gold.value;
  if (!playing(c) || clock === null || gold === null || !c.v.me.itemsKnown || c.mem.inFight) return null;
  const enemies = enemyKeys(c);
  if (!enemies.length) return null;
  const role = myRole(c);
  if (!role) return null;
  const have = owned(c);
  // Несрочный предмет против угрозы (Radiance, Shiva's Guard…) — только если профи на этом герое его собирают:
  // иначе совет «против иллюзий: Radiance» получал любой кор. Срочные (пыль, сентри) — всем
  // сборка для вашей позиции (рейтинг STRATZ → профи) из знаний на матч
  const build = new Map(knowledge(c).me.build.map((b) => [b.key, b]));
  for (const s of counterItems(enemyThreats(enemies, c.look.invisHeroes), role, have)) {
    if (!s.urgent && !build.has(s.key)) continue;
    if (!s.urgent && clock < 8 * 60) continue;
    // Несрочный совет в драке или при высоком риске смерти арбитр отложит — разовый показ не тратим
    if (!s.urgent && purchaseWait(c)) continue;
    const once = `draft:item:${s.key}`;
    if (c.mem.once.has(once)) continue;
    const cost = c.look.itemCost(s.key);
    if (cost === null || gold < cost) continue;
    c.mem.once.add(once);
    const name = c.look.itemName(s.key);
    const heroes = s.heroes.map((h) => c.look.heroName(h)).join(', ');
    const n = s.heroes.length;
    // Причина с цифрами: сколько врагов с этой угрозой и когда предмет берут сильные игроки на вашем герое
    const b = build.get(s.key);
    const when = b && c.look.hasNorms ? ` ${b.source === 'ranked' ? 'Сильные игроки рейтинга' : 'Профи'} на вашем герое берут его к ~${Math.round(b.medianMin)} мин${b.source === 'ranked' ? ` (в ${Math.round(b.share * 100)}% матчей${b.winrate !== undefined ? `, доля побед купивших ${Math.round(b.winrate * 100)}%` : ''})` : ''}.` : '';
    return draft({
      id: `draft.item:${s.key}`,
      ruleId: 'draft.item',
      category: 'economy',
      priority: s.urgent ? 'advice' : 'info',
      confidence: 0.7,
      short: `Купите ${name}: ${n} ${plural(n, 'враг', 'врага', 'врагов')} — ${s.threatRu}`,
      normal: `Купите ${name} (${cost}, у вас ${gold}): у врагов ${n} ${plural(n, 'герой', 'героя', 'героев')} — ${s.threatRu} (${heroes}), ${s.whyRu}.${when}`,
      facts: [derivedFact('threat', 'Угроза', `${s.threatRu}: ${heroes}`, 0.75), kbFact('item-cost', 'Цена', cost, c.look.data.kbVerified), ...(b ? [kbFact('item-minute', 'Берут к минуте', Math.round(b.medianMin), false, 'stats')] : [])],
      ttlSec: 10,
      cooldownSec: 0,
      icon: `item:${s.key}`,
    });
  }
  return null;
};

/**
 * Ключевые предметы врагов: за ~минуту до минуты, к которой их берут сильные игроки рейтинга на вероятной позиции
 * героя (знания на матч), — предупреждение. Только ключевые (KEY_ITEMS: Black King Bar, Blink…), берут в ≥ 40% матчей.
 * В Турбо молчит: минуты — из рейтинговых матчей обычной игры.
 */
export const enemySpikeRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!c.v.inGame || clock === null || clock < 5 * 60 || !c.look.hasNorms) return null;
  const out: HintDraft[] = [];
  for (const e of knowledge(c).enemies) {
    for (const b of e.keyItems) {
      if (b.share < 0.4 || !KEY_ITEMS.includes(b.key)) continue;
      const at = b.minute * 60;
      if (clock < at - 75 || clock > at - 30) continue;
      const once = `draft:spike:${e.key}:${b.key}`;
      if (c.mem.once.has(once)) continue;
      c.mem.once.add(once);
      out.push(
        draft({
          id: `timing.enemy-item:${e.key}:${b.key}`,
          ruleId: 'timing.enemy-item',
          category: 'timing',
          priority: 'info',
          confidence: 0.6,
          short: `${e.name}: ${b.name} к ~${mmss(at)}`,
          normal: `Сильные игроки на ${e.name}${e.position ? ` (позиция ${e.position})` : ''} берут ${b.name} к ~${mmss(at)} в ${Math.round(b.share * 100)}% матчей. Драку против него лучше начать раньше.`,
          facts: [kbFact('enemy-item', `${e.name}: ${b.name}, обычно к`, mmss(at), false, 'stats'), kbFact('share', 'Берут в доле матчей, %', Math.round(b.share * 100), false, 'stats')],
          ttlSec: 10,
          cooldownSec: 0,
          icon: `item:${b.key}`,
          zone: 'timing',
        }),
      );
      break;
    }
    if (out.length) break; // не больше одного за тик — очередь сама разнесёт
  }
  return out;
};

/** Предмет врага, увиденный дольше этого назад, — не повод для совета (мог продать, разобрать; чтение старое) */
export const ENEMY_ITEM_MAX_AGE_SEC = 180;

/**
 * Ответ на предмет врага, который коуч увидел на его панели (игрок выделял героя): у Phantom Assassin Butterfly →
 * Monkey King Bar. Только предмет вашей роли и только из сборки сильных игроков на вашем герое (кроме пыли и сентри);
 * уже есть любой из ответов — молчим. Один раз за матч на предмет врага.
 */
export const enemyItemRule: Rule = (c) => {
  if (!playing(c) || purchaseWait(c) || !c.v.me.itemsKnown) return null;
  const seen = (c.v.enemyItems ?? []).filter((e) => e.ageSec <= ENEMY_ITEM_MAX_AGE_SEC && ENEMY_ITEM_ANSWERS[e.key]);
  if (!seen.length) return null;
  const role = myRole(c);
  if (!role) return null;
  const have = owned(c);
  const build = new Map(knowledge(c).me.build.map((b) => [b.key, b]));
  const gold = c.v.me.gold.value;
  for (const e of seen) {
    const once = `enemy-item:${e.key}`;
    const a = ENEMY_ITEM_ANSWERS[e.key]!;
    const heroKey = c.look.heroById.get(e.heroId)?.key;
    if (!heroKey || c.mem.once.has(once) || a.items.some((it) => have.has(it.key))) continue;
    const fit = a.items.find((it) => (it.role === 'any' || it.role === role) && (ANSWER_ANY_HERO.has(it.key) || build.has(it.key)));
    if (!fit) continue;
    c.mem.once.add(once);
    const b = build.get(fit.key);
    const name = c.look.itemName(fit.key);
    const enemyItem = c.look.itemName(e.key);
    const hero = c.look.heroName(heroKey);
    const cost = c.look.itemCost(fit.key);
    const stats = b?.source === 'ranked' ? ` Сильные игроки на вашей позиции берут ${name} в ${Math.round(b.share * 100)}% матчей${b.winrate !== undefined ? `, доля побед купивших ${Math.round(b.winrate * 100)}%` : ''}.` : '';
    return draft({
      id: `economy.enemy-item:${fit.key}`,
      ruleId: 'economy.enemy-item',
      category: 'economy',
      priority: 'info',
      confidence: 0.7,
      short: `У ${hero} ${enemyItem} — ответ: ${name}`,
      normal: `У ${hero} увиден ${enemyItem} (${a.whyRu}) ${e.ageSec < 5 ? 'только что' : `${e.ageSec} с назад`}. Ответ — ${name}${cost !== null ? ` (${cost}${gold !== null ? `, у вас ${gold}` : ''})` : ''}.${stats}`,
      facts: [derivedFact('enemy-item', `Предмет ${hero}`, enemyItem, 0.8), ...(cost !== null ? [kbFact('item-cost', 'Цена', cost, c.look.data.kbVerified)] : []), ...(b ? [kbFact('share', 'Берут в доле матчей, %', Math.round(b.share * 100), false, 'stats')] : []), fact('gold', 'Золото', c.v.me.gold)],
      ttlSec: 10,
      cooldownSec: 0,
      icon: `item:${fit.key}`,
    });
  }
  return null;
};

export const DRAFT_RULES: Rule[] = [enemyDraftRule, counterItemRule, enemySpikeRule, enemyItemRule];
