// D. Фарм и экономика: GPM/XPM против ориентиров, простой, непотраченное золото и следующий предмет,
// тайминги предметов, очки навыков, ТП, варды, нейтральный предмет, маршрут фарма.
import { TP_ITEMS } from '../data.ts';
import { hasItem, tpReady } from '../memory.ts';
import { actionChoice, nearEnemies } from '../prob.ts';
import { isOwnBase } from '../geo.ts';
import { derivedFact, fact, kbFact } from '../view.ts';
import { draft, playing, type Rule, type RuleContext } from './context.ts';


/** Порог «много золота» по умолчанию */
export const GOLD_HIGH = 1800;
export const IDLE_SEC = 20;

/** Следующий предмет сборки (профи патча), которого у героя ещё нет */
export function nextItem(c: RuleContext): { key: string; name: string; cost: number | null; medianMin: number; share: number; source: 'pro' | 'popular' } | null {
  const hero = c.v.me.hero.value;
  if (!hero) return null;
  const owned = new Set([...c.mem.items.keys(), ...c.v.me.items.map((i) => i.key)]);
  const b = c.look.buildFor(hero.id, hero.key).find((x) => !owned.has(x.key));
  return b ? { key: b.key, name: c.look.itemName(b.key), cost: c.look.itemCost(b.key), medianMin: b.medianMin, share: b.share, source: b.source } : null;
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
  return draft({
    id: 'economy.gold',
    category: 'economy',
    priority: 'advice',
    confidence: 0.8,
    short: item ? `Золото ${gold}: купите ${item.name}` : `Золото ${gold} — потратьте`,
    normal: item ? `${gold} золота лежит без дела. Следующий предмет по сборке профи патча — ${item.name} (${item.cost}).` : `${gold} золота лежит без дела: при смерти часть потеряется.`,
    facts: [fact('gold', 'Золото', c.v.me.gold), ...(item ? [kbFact('next-item', 'Следующий предмет (профи патча)', item.name, false, 'stats'), kbFact('item-cost', 'Цена', item.cost, c.look.data.kbVerified)] : [])],
    ttlSec: 10,
    cooldownSec: 90,
    icon: item ? `item:${item.key}` : null,
  });
};

export const nextItemRule: Rule = (c) => {
  if (!c.v.inGame || c.ev.newItems.length === 0) return null;
  const hero = c.v.me.hero.value;
  if (!hero) return null;
  const build = new Set(c.look.buildFor(hero.id, hero.key).map((b) => b.key));
  if (!c.ev.newItems.some((k) => build.has(k))) return null;
  const next = nextItem(c);
  if (!next) return null;
  return draft({
    id: `economy.next:${next.key}`,
    ruleId: 'economy.next',
    category: 'economy',
    priority: 'info',
    confidence: 0.7,
    short: `Дальше: ${next.name}`,
    // Минута профи — из обычных матчей; в Турбо её не называем
    normal:
      next.source === 'pro' && c.look.hasNorms
        ? `Следующий предмет: ${next.name} — профи патча берут его к ${Math.round(next.medianMin)} мин.`
        : `Следующий предмет: ${next.name} — его чаще всего собирают на этом герое.`,
    facts: [kbFact('next-item', 'Следующий предмет (профи патча)', next.name, false, 'stats'), ...(c.look.hasNorms ? [kbFact('median-min', 'Обычно к минуте', next.medianMin, false, 'stats')] : [])],
    ttlSec: 10,
    cooldownSec: 0,
    icon: `item:${next.key}`,
  });
};

export const itemTimingRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const hero = c.v.me.hero.value;
  // «Запаздывает» — по минутам профи обычных матчей; в Турбо норм нет
  if (!playing(c) || clock === null || !hero || !c.v.me.itemsKnown || !c.look.hasNorms) return null;
  const owned = new Set([...c.mem.items.keys(), ...c.v.me.items.map((i) => i.key)]);
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
    short: 'Нет ТП — купите свиток',
    normal: `У вас нет свитка телепортации (${cost} золота): без него не успеть на помощь и не сбежать.`,
    facts: [derivedFact('tp', 'Свиток ТП', false, 0.9), kbFact('tp-cost', 'Цена ТП', cost, c.look.data.kbVerified)],
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
  if (!roles.includes('Support') || roles.includes('Carry')) return null;
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
    short: 'Нет вардов — купите обзор',
    normal: 'У вас, саппорта, нет вардов уже 3 минуты: обзор спасает команду от ганков.',
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

export const routeRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 10 * 60 || c.mem.inFight || nearEnemies(c.v).length > 0) return null;
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

export const ECONOMY_RULES: Rule[] = [goldRule, tpRule, skillRule, idleRule, nextItemRule, itemTimingRule, gpmRule, wardsRule, neutralRule, routeRule];

