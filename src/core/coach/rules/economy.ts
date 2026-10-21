// D. Фарм и экономика: GPM/XPM против ориентиров, простой, непотраченное золото и следующий предмет,
// тайминги предметов, очки навыков, ТП, варды, нейтральный предмет, маршрут фарма.
import { personalNote } from '../profile.ts';
import { TP_ITEMS } from '../data.ts';
import { enemyThreats } from '../../draft/index.ts';
import { hasItem, nearEnemyCount, tpReady } from '../memory.ts';
import { actionChoice, nearEnemies } from '../prob.ts';
import { isOwnBase } from '../geo.ts';
import { derivedFact, fact, kbFact, poolPct } from '../view.ts';
import { draft, game, playing, purchaseWait, type Rule, type RuleContext } from './context.ts';
import { leavesAt, timedBuild } from '../item-timings.ts';
import { killSituation, SITUATION_STABLE_SEC, situationPicks, stableSituation, type MatchSituation, type SituationPick } from '../item-situation.ts';


/** Порог «много золота» по умолчанию */
export const GOLD_HIGH = 1800;
export const IDLE_SEC = 20;

/** Дешёвый ранний предмет сборки, чьё время прошло на столько минут, больше не советуется (Soul Ring на 18-й минуте) */
export const EARLY_ITEM_COST = 1500;
export const EARLY_ITEM_LATE_MIN = 6;

/** Предмет против угрозы врагов берётся вперёд, если он среди стольких ближайших предметов сборки */
export const COUNTER_LOOKAHEAD = 3;

export interface NextItem {
  key: string;
  name: string;
  cost: number | null;
  medianMin: number;
  share: number;
  source: 'pro' | 'popular' | 'ranked';
  /** Взят вперёд против угрозы врагов: что за угроза и у кого */
  vs: { threatRu: string; heroes: string[] } | null;
  /** Взят вперёд по положению в матче (подтверждённая разница, item-situations.json) */
  sit?: { situation: MatchSituation; pick: SituationPick; score: string } | null;
}

/**
 * Следующий предмет сборки (что реально покупают профи на этом герое), которого у героя ещё нет; ранние дешёвые, чьё
 * время прошло, пропускаются. Поправка на врагов: если среди ближайших предметов сборки есть предмет против угрозы
 * вражеской команды (Mjollnir против иллюзий и т. п.), он идёт первым — но только из сборки профи этого героя, а не
 * «Radiance любому кору против Phantom Lancer».
 */
export function nextItem(c: RuleContext): NextItem | null {
  const hero = c.v.me.hero.value;
  if (!hero) return null;
  const owned = new Set([...c.mem.items.keys(), ...c.v.me.items.map((i) => i.key)]);
  const min = (c.v.clock.value ?? 0) / 60;
  // Минуты сборки — из обычных матчей; в Турбо — минута по матчам Турбо, если они есть, иначе примерно вдвое раньше
  const scale = c.look.isTurbo ? 0.5 : 1;
  const turbo = c.look.isTurbo ? timedBuild(c.look.timings, heroKeyOf(c) ?? '', posKey(c)) : null;
  const minuteOf = (x: { key: string; medianMin: number }) => turbo?.items.find((i) => i.key === x.key)?.p50 ?? x.medianMin * scale;
  const passed = (x: { key: string; medianMin: number }) => (c.look.itemCost(x.key) ?? Infinity) < EARLY_ITEM_COST && min > minuteOf(x) + EARLY_ITEM_LATE_MIN;
  // Сборка — сильных игроков рейтинга на вашей позиции (STRATZ), если позиция известна и данные есть; иначе — профи
  const build = c.look.buildForPosition(hero.id, hero.key, game(c).position);
  const left = build.filter((x) => !owned.has(x.key) && !passed(x));
  const out = (b: (typeof left)[number], vs: NextItem['vs']): NextItem => ({ key: b.key, name: c.look.itemName(b.key), cost: c.look.itemCost(b.key), medianMin: b.medianMin, share: b.share, source: b.source, vs });
  const enemies = [...new Set(c.v.enemies.map((e) => e.hero.value).filter((k): k is string => !!k))];
  if (enemies.length) {
    const soon = left.slice(0, COUNTER_LOOKAHEAD);
    for (const t of enemyThreats(enemies, c.look.invisHeroes)) {
      const b = soon.find((x) => t.threat.items.some((it) => it.key === x.key));
      if (b) return out(b, { threatRu: t.threat.nameRu, heroes: t.heroes });
    }
  }
  // Положение в матче (устойчивое, ≥ 90 с): подтверждённый предмет для этого положения — вперёд, если он не куплен.
  // Только обычная игра: данные — рейтинговые матчи All Pick
  const sit = c.look.isTurbo ? null : currentSituation(c);
  const key = heroKeyOf(c);
  if (sit && key) {
    const pick = situationPicks(c.look.data.itemSituations, key, posKey(c), sit).find((p) => !owned.has(p.key));
    if (pick) return { key: pick.key, name: c.look.itemName(pick.key), cost: c.look.itemCost(pick.key), medianMin: -1, share: pick.share, source: 'ranked', vs: null, sit: { situation: sit, pick, score: scoreText(c) } };
  }
  return left[0] ? out(left[0], null) : null;
}

/** Счёт убийств «наши:их»; пусто — счёт или своя команда неизвестны */
function scoreText(c: RuleContext): string {
  const r = c.v.score.radiant.value;
  const d = c.v.score.dire.value;
  if (r === null || d === null || !c.v.team) return '';
  return c.v.team === 'radiant' ? `${r}:${d}` : `${d}:${r}`;
}

/** Устойчивое положение по счёту убийств (память коуча обновляет situationTrackRule каждый тик) */
export function currentSituation(c: RuleContext): MatchSituation | null {
  const at = c.mem.marks.get('sit@');
  const code = c.mem.marks.get('sit');
  if (at === undefined || !code || c.now - at < SITUATION_STABLE_SEC * 1000) return null;
  return code === 1 ? 'behind' : code === 2 ? 'ahead' : 'even';
}

/** Каждый тик: положение по счёту убийств → память коуча (с какого момента оно держится). Подсказок не даёт */
export const situationTrackRule: Rule = (c) => {
  if (!c.v.inGame || !c.v.team) return null;
  const r = c.v.score.radiant.value;
  const d = c.v.score.dire.value;
  stableSituation(c.mem.marks, c.now, c.v.team === 'radiant' ? killSituation(r, d) : killSituation(d, r));
  return null;
};

/** Ключ своего героя: из данных игры, а с экрана — по id */
export function heroKeyOf(c: RuleContext): string | null {
  const h = c.v.me.hero.value;
  if (!h) return null;
  return h.key ?? (h.id !== null ? (c.look.heroById.get(h.id)?.key ?? null) : null);
}

/** Позиция '1'…'5' для таблиц по позициям; null — не известна */
const posKey = (c: RuleContext): string | null => (game(c).position === null ? null : String(game(c).position));

/**
 * Сколько золота держать на выкуп: в лейте (стадия — с поправкой на Турбо), когда выкуп не на перезарядке и цена
 * известна; иначе 0 — выкуп ещё не важен.
 */
export function buybackReserve(c: RuleContext): number {
  const cost = c.v.me.buybackCost.value;
  if (game(c).stage !== 'late' || cost === null || cost <= 0 || (c.v.me.buybackCooldown.value ?? 0) > 0) return 0;
  return cost;
}

export const gpmRule: Rule = (c) => {
  const clock = c.v.clock.value;
  // Медиана GPM — из обычных матчей: в Турбо её нет (золото идёт вдвое быстрее)
  if (!playing(c) || clock === null || clock < 10 * 60 || !c.look.hasNorms) return null;
  const st = c.look.statsFor(c.v.me.hero.value?.id, c.v.me.hero.value?.key);
  const gpm = c.v.me.gpm.value;
  const ref = st?.bench?.gpm?.p50;
  if (gpm === null || !ref || gpm >= ref * 0.75) return null;
  return draft({
    id: 'economy.gpm',
    category: 'economy',
    priority: 'info',
    confidence: 0.85,
    short: `GPM ${gpm} — ниже обычного ${ref}`,
    normal: `Золото в минуту ${gpm}, на этом герое обычно ${ref}. Больше фарма между драками.`,
    facts: [fact('gpm', 'GPM', c.v.me.gpm), { key: 'gpm-ref', label: 'GPM, медиана (публичные матчи)', value: ref, source: 'stats', ageSec: null, confidence: 0.9, verified: false }],
    ttlSec: 10,
    cooldownSec: 600,
  });
};

export const idleRule: Rule = (c) => {
  if (!playing(c) || c.mem.idleSinceMs === null || c.mem.inFight) return null;
  const sec = Math.round((c.now - c.mem.idleSinceMs) / 1000);
  if (sec < IDLE_SEC || (c.v.clock.value ?? 0) < 0) return null;
  return draft({
    id: 'economy.idle',
    category: 'economy',
    priority: 'advice',
    confidence: 0.75,
    short: `Простой ${sec} с — идите фармить`,
    normal: `Вы ${sec} с на одном месте без приказов. Каждая минута простоя — потерянное золото.`,
    facts: [derivedFact('idle', 'Без движения, с', sec, 0.75)],
    ttlSec: 8,
    cooldownSec: 60,
  });
};

export const goldRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const gold = c.v.me.gold.value;
  if (!playing(c) || clock === null || gold === null || c.mem.goldHighSince === null || clock - c.mem.goldHighSince < 45) return null;
  if (c.mem.inFight) return null;
  const next = nextItem(c);
  const item = next && next.cost !== null && next.cost <= gold ? next : null;
  // Лейт: покупка не должна съесть выкуп. Предмет по карману, но после него на выкуп не хватит — предупреждаем
  const reserve = buybackReserve(c);
  if (reserve && item && gold - item.cost! < reserve) {
    return draft({
      id: 'economy.buyback',
      category: 'economy',
      priority: 'advice',
      confidence: 0.8,
      short: `${item.name} — потом не хватит на выкуп`,
      normal: `${item.name} стоит ${item.cost}, у вас ${gold}: останется ${gold - item.cost!}, а выкуп ${reserve}. В поздней игре смерть без выкупа может стоить матча — подкопите до ${item.cost! + reserve}.`,
      facts: [fact('gold', 'Золото', c.v.me.gold), fact('buyback', 'Цена выкупа', c.v.me.buybackCost), kbFact('item-cost', 'Цена', item.cost, c.look.data.kbVerified)],
      ttlSec: 10,
      cooldownSec: 300,
      icon: `item:${item.key}`,
    });
  }
  // Без предмета: «потратьте» — только если и после выкупа золота много
  if (!item && reserve && gold - reserve < GOLD_HIGH) return null;
  return draft({
    id: 'economy.gold',
    category: 'economy',
    priority: 'advice',
    confidence: 0.8,
    short: item ? `Золото ${gold}: купите ${item.name}` : `Золото ${gold} — потратьте`,
    normal: (item ? `${gold} золота лежит без дела. Следующий предмет по сборке — ${item.name} (${item.cost}).` : `${gold} золота лежит без дела: при смерти часть потеряется.`) + personalNote(c.look.data.profile, 'unspent-gold'),
    facts: [fact('gold', 'Золото', c.v.me.gold), ...(item ? [kbFact('next-item', 'Следующий предмет (профи патча)', item.name, false, 'stats'), kbFact('item-cost', 'Цена', item.cost, c.look.data.kbVerified)] : [])],
    ttlSec: 10,
    cooldownSec: 90,
    icon: item ? `item:${item.key}` : null,
  });
};

/** Сколько после покупки совет «что дальше» ждёт места в очереди (одна подсказка экономики — раз в 20 с) */
export const NEXT_ITEM_WAIT_MS = 90_000;

export const nextItemRule: Rule = (c) => {
  if (!c.v.inGame) return null;
  // Совет — после покупки; если очередь занята другой подсказкой экономики, он ждёт, а не теряется
  if (c.ev.newItems.length) c.mem.marks.set('next-item@', c.now);
  const boughtAt = c.mem.marks.get('next-item@');
  if (boughtAt === undefined || c.now - boughtAt > NEXT_ITEM_WAIT_MS) return null;
  const hero = c.v.me.hero.value;
  if (!hero) return null;
  // После любой покупки (а не только предмета из сборки профи): своя сборка тоже получает совет, что дальше
  const next = nextItem(c);
  if (!next) return null;
  return draft({
    id: `economy.next:${next.key}`,
    ruleId: 'economy.next',
    category: 'economy',
    priority: 'info',
    confidence: 0.7,
    short: next.sit ? `Дальше: ${next.name} — команда ${next.sit.situation === 'behind' ? 'отстаёт' : 'ведёт'}` : next.vs ? `Дальше: ${next.name} — против ${c.look.heroName(next.vs.heroes[0]!)}` : `Дальше: ${next.name}`,
    // Минута профи — из обычных матчей; в Турбо её не называем
    normal: next.sit
      ? `Команда ${next.sit.situation === 'behind' ? 'отстаёт' : 'ведёт'}${next.sit.score ? ` (${next.sit.score} по убийствам)` : ''} — ${next.name}: ${next.sit.situation === 'behind' ? 'при отставании' : 'при перевесе'} сильные игроки на этом герое берут его чаще (${Math.round(next.sit.pick.share * 100)}% против ${Math.round(next.sit.pick.other * 100)}%${next.sit.pick.measure === 'purchases' ? ' покупок' : ' матчей'}).`
      : next.vs
      ? `Следующий предмет: ${next.name} — у врагов ${next.vs.threatRu} (${next.vs.heroes.map((h) => c.look.heroName(h)).join(', ')}); профи на этом герое его тоже собирают.`
      : next.source === 'ranked' && c.look.hasNorms
        ? `Следующий предмет: ${next.name} — сильные игроки рейтинга на этой позиции берут его к ${Math.round(next.medianMin)} мин.`
        : next.source === 'ranked'
          ? `Следующий предмет: ${next.name} — его берут сильные игроки рейтинга на этой позиции.`
          : next.source === 'pro' && c.look.hasNorms
        ? `Следующий предмет: ${next.name} — профи патча берут его к ${Math.round(next.medianMin)} мин.`
        : `Следующий предмет: ${next.name} — его чаще всего собирают на этом герое.`,
    facts: next.sit
      ? [kbFact('next-item', 'Следующий предмет (по положению в матче)', next.name, false, 'stats'), derivedFact('situation', 'Положение по убийствам', next.sit.score || next.sit.situation, 0.7), kbFact('sit-share', 'Берут в этом положении / в противоположном, %', `${Math.round(next.sit.pick.share * 100)} / ${Math.round(next.sit.pick.other * 100)}`, false, 'stats')]
      : [kbFact('next-item', 'Следующий предмет (профи патча)', next.name, false, 'stats'), ...(c.look.hasNorms ? [kbFact('median-min', 'Обычно к минуте', next.medianMin, false, 'stats')] : [])],
    ttlSec: 10,
    // Тот же совет не повторяется: правило держится минуту после покупки
    cooldownSec: 300,
    icon: `item:${next.key}`,
  });
};

/**
 * Покупка оставила золото ниже цены выкупа (в лейте, выкуп готов): одно предупреждение, перерыв общий с советом
 * «потом не хватит на выкуп» (тот же id) — не при каждой покупке.
 */
export const buybackSpendRule: Rule = (c) => {
  if (!playing(c) || !c.ev.newItems.length || c.mem.inFight) return null;
  const reserve = buybackReserve(c);
  const gold = c.v.me.gold.value;
  if (!reserve || gold === null || gold >= reserve) return null;
  // Золото до покупки (последние 4 с истории): уже было меньше выкупа — дело не в покупке
  const before = Math.max(-1, ...c.mem.last(4, c.now).map((s) => s.gold ?? -1));
  if (before < reserve) return null;
  return draft({
    id: 'economy.buyback',
    category: 'economy',
    priority: 'advice',
    confidence: 0.8,
    short: `На выкуп не хватает: ${gold} из ${reserve}`,
    normal: `После покупки осталось ${gold}, а выкуп стоит ${reserve} (было ${before}). До ${reserve} больше не тратьте: в поздней игре смерть без выкупа может стоить матча.`,
    facts: [fact('gold', 'Золото', c.v.me.gold), fact('buyback', 'Цена выкупа', c.v.me.buybackCost), derivedFact('gold-before', 'Золото до покупки', before, 0.8)],
    ttlSec: 10,
    cooldownSec: 300,
  });
};

/** Турбо: «запаздывает» по реальным матчам Турбо на этой позиции — позже, чем в 8 из 10 матчей */
function turboLate(c: RuleContext, clock: number, owned: Set<string>) {
  const key = heroKeyOf(c);
  const tb = key ? timedBuild(c.look.timings, key, posKey(c)) : null;
  if (!tb) return null;
  const late = tb.items.find((b) => b.share >= 0.4 && (c.look.itemCost(b.key) ?? 0) >= 1500 && !owned.has(b.key) && clock / 60 > b.p80 && !c.mem.once.has(`late:${b.key}`));
  if (!late) return null;
  c.mem.once.add(`late:${late.key}`);
  const name = c.look.itemName(late.key);
  return draft({
    id: `economy.late:${late.key}`,
    ruleId: 'economy.late',
    category: 'economy',
    priority: 'info',
    confidence: 0.7,
    short: `${name} запаздывает`,
    normal: `В Турбо${c.look.timings?.rank ? ` (игроки ${c.look.timings.rank.label})` : ''} на этой позиции ${name} берут к ${Math.round(late.p50)} мин, в 8 из 10 матчей — к ${Math.round(late.p80)}; сейчас ${Math.floor(clock / 60)}. Ускорьте фарм.`,
    facts: [kbFact('item', 'Предмет', name, false, 'stats'), kbFact('median-min', 'Турбо: обычно к минуте', late.p50, false, 'stats'), kbFact('turbo-games', 'Матчей Турбо на позиции', tb.n, false, 'stats'), fact('clock', 'Игровое время, с', c.v.clock)],
    ttlSec: 10,
    cooldownSec: 0,
    icon: `item:${late.key}`,
  });
}

export const itemTimingRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const hero = c.v.me.hero.value;
  if (!playing(c) || clock === null || !hero || !c.v.me.itemsKnown || purchaseWait(c)) return null;
  // «Запаздывает» — корам: у саппортов тайминги предметов слишком разные (режим тени: «Essence Distiller запаздывает» пятёрке)
  if (game(c).core === false) return null;
  const owned = new Set([...c.mem.items.keys(), ...c.v.me.items.map((i) => i.key)]);
  // Турбо — только по реальным матчам Турбо (≥ 40 на позиции); нет данных — молчим: минуты обычной игры, делённые
  // пополам, для «запаздывает» не годятся
  if (c.look.isTurbo) return turboLate(c, clock, owned);
  // только профи патча: у запасной сборки минута примерная — «запаздывает» по ней не скажешь
  const core = c.look.buildFor(hero.id, hero.key).filter((b) => b.source === 'pro' && b.share >= 0.4 && (c.look.itemCost(b.key) ?? 0) >= 1500);
  const late = core.find((b) => !owned.has(b.key) && clock / 60 > b.medianMin + 6 && !c.mem.once.has(`late:${b.key}`));
  if (!late) return null;
  c.mem.once.add(`late:${late.key}`);
  const name = c.look.itemName(late.key);
  return draft({
    id: `economy.late:${late.key}`,
    ruleId: 'economy.late',
    category: 'economy',
    priority: 'info',
    confidence: 0.7,
    short: `${name} запаздывает`,
    normal: `${name} профи патча берут к ${Math.round(late.medianMin)} мин, сейчас ${Math.floor(clock / 60)}. Ускорьте фарм.`,
    facts: [kbFact('item', 'Предмет', name, false, 'stats'), kbFact('median-min', 'Обычно к минуте', late.medianMin, false, 'stats'), fact('clock', 'Игровое время, с', c.v.clock)],
    ttlSec: 10,
    cooldownSec: 0,
    icon: `item:${late.key}`,
  });
};

/** Неиспользованные очки: уровень − (уровни способностей + таланты + характеристики) */
export function unspentPoints(c: RuleContext): number | null {
  const lvl = c.v.me.level.value;
  const talents = c.v.me.talentsTaken.value;
  const attrs = c.v.me.attributesLevel.value;
  if (lvl === null || talents === null || attrs === null || c.v.me.abilities.length === 0) return null;
  let spent = talents + attrs;
  for (const a of c.v.me.abilities) {
    if (a.level === null) return null;
    const kb = a.key ? c.look.abilityByKey.get(a.key) : undefined;
    if (kb?.innate) continue;
    spent += a.level;
  }
  return lvl - spent;
}

export const skillRule: Rule = (c) => {
  if (!playing(c)) return null;
  const n = unspentPoints(c);
  if (n === null || n <= 0) {
    c.mem.marks.delete('unspent@');
    return null;
  }
  const since = c.mem.marks.get('unspent@') ?? c.now;
  c.mem.marks.set('unspent@', since);
  if (c.now - since < 10_000) return null;
  const lvl = c.v.me.level.value!;
  const st = c.look.statsFor(c.v.me.hero.value?.id, c.v.me.hero.value?.key);
  const sug = st?.pro?.skills[lvl - 1] ?? null;
  const sugName = sug ? (sug.key === 'talent' ? 'талант' : (c.look.abilityByKey.get(sug.key)?.name ?? null)) : null;
  return draft({
    id: 'economy.skill',
    category: 'economy',
    priority: 'advice',
    confidence: 0.6,
    short: sugName ? `Очко навыка: ${sugName}` : 'Есть неиспользованное очко навыка',
    normal: `Неиспользованных очков: ${n}.${sugName ? ` На ${lvl} уровне профи патча чаще берут ${sugName}.` : ''}`,
    facts: [derivedFact('unspent', 'Свободных очков', n, 0.6), ...(sugName ? [kbFact('skill', `Навык ${lvl} уровня (профи патча)`, sugName, false, 'stats')] : [])],
    ttlSec: 10,
    cooldownSec: 45,
  });
};

export const tpRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 3 * 60 || tpReady(c.v) !== false) return null;
  if (hasItem(c.v, TP_ITEMS)) return null; // свиток есть, просто на перезарядке
  const cost = c.look.itemCost('tpscroll');
  const gold = c.v.me.gold.value;
  if (cost === null || gold === null || gold < cost) return null;
  return draft({
    id: 'economy.tp',
    category: 'economy',
    priority: 'advice',
    confidence: 0.85,
    short: 'Нет Town Portal Scroll — купите',
    normal: `У вас нет свитка телепортации (${cost} золота): без него не успеть на помощь и не сбежать.`,
    facts: [derivedFact('tp', 'Town Portal Scroll', false, 0.9), kbFact('tp-cost', 'Цена Town Portal Scroll', cost, c.look.data.kbVerified)],
    ttlSec: 10,
    cooldownSec: 120,
    icon: 'item:tpscroll',
  });
};

export const wardsRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const key = c.v.me.hero.value?.key;
  if (!playing(c) || clock === null || clock < 2 * 60 || !key || !c.v.me.itemsKnown) return null;
  const roles = c.look.heroByKey.get(key)?.roles ?? [];
  // Варды — дело позиций 4–5; позиция не известна — по ролям героя, как раньше
  const pos = game(c).position;
  if (pos !== null ? pos < 4 : !roles.includes('Support') || roles.includes('Carry')) return null;
  if (hasItem(c.v, ['ward_observer', 'ward_dispenser', 'ward_sentry'])) {
    c.mem.marks.delete('no-wards@');
    return null;
  }
  const since = c.mem.marks.get('no-wards@') ?? c.now;
  c.mem.marks.set('no-wards@', since);
  if (c.now - since < 180_000) return null;
  return draft({
    id: 'economy.wards',
    category: 'economy',
    priority: 'info',
    confidence: 0.6,
    short: 'Нет Observer Ward — купите обзор',
    normal: 'У вас, саппорта, нет Observer Ward уже 3 минуты: обзор спасает команду от ганков.',
    facts: [kbFact('roles', 'Роли героя (база)', roles.join(', '), false), derivedFact('wards', 'Вардов в инвентаре', 0, 0.9)],
    ttlSec: 10,
    cooldownSec: 240,
    icon: 'item:ward_observer',
  });
};

export const neutralRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || !c.v.me.emptySlots.includes('neutral')) return null;
  const at = c.look.mechanicValue('neutral-items-t1', 'availableAt');
  if (at === null || clock < at + 180) return null;
  return draft({
    id: 'economy.neutral',
    category: 'economy',
    priority: 'info',
    confidence: 0.8,
    short: 'Пустой слот нейтрального предмета',
    normal: 'Слот нейтрального предмета пуст — выберите предмет текущего уровня.',
    facts: [{ key: 'neutral', label: 'Нейтральный слот', value: 'пусто', source: 'gsi', ageSec: 0, confidence: 1, verified: true }, kbFact('neutral-t1', 'Нейтральные предметы с, с', at, true)],
    ttlSec: 10,
    cooldownSec: 300,
  });
};

/**
 * Предметы, которые к этой минуте (обычная игра; в Турбо — вдвое раньше) обычно уже лишние: занимают ячейку
 * и почти ничего не дают. Эвристика коуча, не статистика: совет «продайте», а не приказ.
 */
export const OUTGROWN_ITEMS: Record<string, number> = {
  tango: 15,
  clarity: 15,
  faerie_fire: 15,
  enchanted_mango: 15,
  flask: 20,
  branches: 25,
  quelling_blade: 25,
  orb_of_venom: 20,
  magic_stick: 25,
  boots: 25,
  bracer: 30,
  wraith_band: 30,
  null_talisman: 30,
  soul_ring: 35,
};
const MANA_CONSUMABLES = new Set(['clarity', 'enchanted_mango']);
const HP_CONSUMABLES = new Set(['tango', 'flask', 'faerie_fire']);
/** Совет продать — только когда основной инвентарь почти полон (ячейка нужна) */
export const SELL_WHEN_FULL = 5;

/**
 * Ранние предметы, для которых «когда уходят из 6 ячеек» взято из матчей сильных игроков (item-timings.json): их не
 * улучшают в другой предмет, так что уход — это продажа или рюкзак. Magic Stick, Iron Branch, Ring of Basilius и т. п.
 * уходят, потому что их собирают дальше, — для них по-прежнему OUTGROWN_ITEMS.
 */
export const SELL_DATA_ITEMS = new Set(['bracer', 'wraith_band', 'null_talisman', 'magic_wand', 'soul_ring', 'falcon_blade', 'orb_of_corrosion', 'quelling_blade']);
/** Предмет из данных устарел настолько (минут после обычной минуты ухода), что советуем и при неполном инвентаре */
export const SELL_LATE_EXTRA_MIN = 10;

export const sellRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || !c.v.me.itemsKnown || c.mem.inFight) return null;
  const inv = c.v.me.items.filter((i) => /^inv\d$/.test(i.slot));
  const bp = c.v.me.items.filter((i) => /^bp\d$/.test(i.slot));
  const min = clock / 60;
  const scale = c.look.isTurbo ? 0.5 : 1;
  // С какой минуты предмет лишний: по матчам сильных игроков (Турбо — по матчам Турбо), иначе эвристика OUTGROWN_ITEMS.
  // Данные говорят «больше половины держат до конца» (null) — не советуем
  const outgrownAt = (key: string): { min: number; data: boolean } | null => {
    if (SELL_DATA_ITEMS.has(key) && c.look.timings?.leaves[key]) {
      const at = leavesAt(c.look.timings, key);
      return at === null ? null : { min: at, data: true };
    }
    return OUTGROWN_ITEMS[key] !== undefined ? { min: OUTGROWN_ITEMS[key]! * scale, data: false } : null;
  };
  // Не продавать то, из чего собирается следующий предмет сборки (Magic Wand → Holy Locket)
  const hero = c.v.me.hero.value;
  const owned = new Set([...c.mem.items.keys(), ...c.v.me.items.map((i) => i.key)]);
  const upcoming = hero ? c.look.buildForPosition(hero.id, heroKeyOf(c), game(c).position).filter((b) => !owned.has(b.key)).slice(0, COUNTER_LOOKAHEAD) : [];
  const keep = new Set(upcoming.flatMap((b) => [...c.look.itemParts(b.key)]));
  // Расходник, который сейчас пригодится (мало маны — Clarity, мало здоровья — Tango), не «лишний»: в матче 9051474634
  // коуч сказал «Clarity — продайте», а через 5 с «Мало маны — выпейте Clarity»
  const mana = poolPct(c.v.me.mana.value);
  const hp = poolPct(c.v.me.hp.value);
  const neededNow = (key: string) => (MANA_CONSUMABLES.has(key) && (mana === null || mana < 50)) || (HP_CONSUMABLES.has(key) && (hp === null || hp < 80));
  const stale = (key: string, extraMin = 0) => {
    const o = outgrownAt(key);
    return o !== null && min >= o.min + extraMin && !keep.has(key) && !neededNow(key);
  };
  // Основные ячейки: почти полный инвентарь — как раньше; при 4 предметах — только сильно устаревшие по данным
  const extra = inv.filter((i) => (inv.length >= SELL_WHEN_FULL ? stale(i.key) : inv.length >= SELL_WHEN_FULL - 1 && outgrownAt(i.key)?.data === true && stale(i.key, SELL_LATE_EXTRA_MIN)));
  // Рюкзак: предмет там ничего не даёт, устаревший — только место и золото
  const extraBp = bp.filter((i) => stale(i.key));
  if (!extra.length && !extraBp.length) return null;
  const all = [...extra, ...extraBp];
  const names = [...new Set(all.map((i) => c.look.itemName(i.key)))];
  // Расходники выгоднее использовать, чем продать за бесценок
  const allConsumable = all.every((i) => MANA_CONSUMABLES.has(i.key) || HP_CONSUMABLES.has(i.key));
  const verb = allConsumable ? 'используйте или продайте' : 'продайте';
  // Причина с цифрами: когда предмет убирают сильные игроки (если это из данных)
  const first = all[0]!;
  const o = outgrownAt(first.key)!;
  const why = o.data ? ` Сильные игроки${c.look.isTurbo ? ' в Турбо' : ''} обычно убирают ${c.look.itemName(first.key)} к ${Math.round(o.min)}-й минуте, сейчас ${Math.floor(min)}-я.` : '';
  const where = !extra.length ? 'Лежит в рюкзаке без пользы.' : inv.length >= SELL_WHEN_FULL ? 'Инвентарь почти полон.' : 'Ячейка нужна под большой предмет.';
  return draft({
    // Один id на правило: перерыв между советами — общий. С id по набору предметов («два Null Talisman», «Null Talisman»,
    // «Null Talisman + Tango») совет звучал 5 раз за 7 минут (матч 9051512826)
    id: 'economy.sell',
    ruleId: 'economy.sell',
    category: 'economy',
    priority: 'info',
    confidence: 0.6,
    short: `${extra.length ? 'Лишнее' : 'В рюкзаке лишнее'}: ${names.slice(0, 2).join(', ')} — ${verb}`,
    normal: `${names.join(', ')} к ${Math.floor(min)}-й минуте почти ничего не дают. ${where}${why} ${allConsumable ? 'Используйте или продайте' : 'Продайте'} и освободите место под предмет посильнее.`,
    facts: [derivedFact('outgrown', 'Лишние предметы', names.join(', '), 0.6), fact('clock', 'Игровое время, с', c.v.clock), ...(o.data ? [kbFact('leaves-at', 'Сильные игроки убирают к минуте', Math.round(o.min), false, 'stats')] : [])],
    ttlSec: 10,
    cooldownSec: 300,
    icon: `item:${first.key}`,
  });
};

export const routeRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 10 * 60 || c.mem.inFight || nearEnemyCount(c.v) > 0) return null;
  if (c.v.team && isOwnBase(c.v.me.zone, c.v.team)) return null;
  const missing = c.v.enemies.filter((e) => e.missing === true).length;
  if (missing > 1) return null;
  // Маршрут нужен, когда игрок не знает, что делать: стоит без дела
  if (c.mem.idleSinceMs === null || c.now - c.mem.idleSinceMs < 8000) return null;
  const a = actionChoice(c.v, c.mem, c.look, c.settings.minPercentConfidence);
  if (a.best !== 'farm' || !a.showable) return null;
  const from = c.look.mechanicValue('neutral-stack-window', 'fromSecond');
  return draft({
    id: 'economy.route',
    category: 'economy',
    priority: 'info',
    confidence: a.confidence,
    short: 'Карта тихая: линия → лес → стак',
    normal: `Врагов рядом нет: заберите волну, потом лагеря леса${from !== null ? `, стак в :${from}` : ''}.`,
    facts: [derivedFact('missing', 'Врагов не видно', missing, 0.75), derivedFact('action', 'Лучшее действие', 'фарм', a.confidence)],
    ttlSec: 10,
    cooldownSec: 240,
  });
};

export const ECONOMY_RULES: Rule[] = [situationTrackRule, goldRule, buybackSpendRule, tpRule, skillRule, idleRule, nextItemRule, itemTimingRule, gpmRule, wardsRule, neutralRule, sellRule, routeRule];

