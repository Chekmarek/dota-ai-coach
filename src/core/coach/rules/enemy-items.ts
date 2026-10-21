// Советы о поведении против предметов врага без прямого ответа-покупки (DECISIONS.md п. 80): Blink Dagger и
// Linken's Sphere. Предмет — с панели выделенного врага (как ENEMY_ITEM_ANSWERS: два уверенных чтения, не старше
// 3 мин). Механики и числа — из базы знаний патча: Blink не работает 3 с после урона от вражеского героя (дальность
// 1200), Linken's блокирует большинство заклинаний на одну цель раз в 14 с. Тип цели — Valve datafeed (targeting.json).
import { dist } from '../geo.ts';
import { derivedFact, kbFact } from '../view.ts';
import { massControl, type TargetedTool } from '../targeting.ts';
import { ENEMY_ITEM_MAX_AGE_SEC, myHeroKey } from './draft.ts';
import { draft, playing, purchaseWait, type Rule, type RuleContext } from './context.ts';

export const BLINK_ITEMS = ['blink', 'overwhelming_blink', 'swift_blink', 'arcane_blink'];
/** Спасительные предметы: их называем в совете «держите наготове», если они у вас есть */
const SAVE_ITEMS = ['force_staff', 'hurricane_pike', 'glimmer_cape', 'ghost', 'cyclone', 'wind_waker', 'black_king_bar', 'aeon_disk', 'lotus_orb', 'manta', 'blade_mail', 'sphere'];
/** Напоминание о Blink перед дракой — не чаще раза в столько секунд на врага (300 давали 76 напоминаний на 10 про-матчей) */
export const BLINK_REMIND_SEC = 480;
/** «Пропал рядом»: враг ушёл в туман не больше столько секунд назад (давно пропавший может быть где угодно) */
const BLINK_FOG_SEC = 15;
/** «Рядом его зона прыжка»: враг ближе дальности Blink плюс столько единиц (успеет подойти) */
const BLINK_NEAR_EXTRA = 600;

/** Увиденные у врагов предметы из списка (не старше 3 мин): ключ героя, предмет, сколько секунд назад */
function seen(c: RuleContext, keys: readonly string[]): { heroKey: string; key: string; ageSec: number }[] {
  return (c.v.enemyItems ?? []).flatMap((e) => {
    const heroKey = c.look.heroById.get(e.heroId)?.key;
    return heroKey && keys.includes(e.key) && e.ageSec <= ENEMY_ITEM_MAX_AGE_SEC ? [{ heroKey, key: e.key, ageSec: e.ageSec }] : [];
  });
}

const ownedKeys = (c: RuleContext) => new Set(c.v.me.items.filter((i) => /^inv\d$/.test(i.slot)).map((i) => i.key));

/** Один раз, когда коуч увидел Blink у врага: что это значит для вас (инициатор с массовым контролем или прыжок на одного) */
export const blinkSeenRule: Rule = (c) => {
  const t = c.look.data.targeting ?? null;
  if (!playing(c) || !t || purchaseWait(c)) return null;
  for (const e of seen(c, BLINK_ITEMS)) {
    const once = `blink-seen:${e.heroKey}`;
    if (c.mem.once.has(once)) continue;
    c.mem.once.add(once);
    const hero = c.look.heroName(e.heroKey);
    const item = c.look.itemName(e.key);
    const range = c.look.itemAttr(e.key, 'blink_range');
    const lock = c.look.itemAttr(e.key, 'blink_damage_cooldown');
    const mass = massControl(c.look.heroByKey.get(e.heroKey), t);
    const me = myHeroKey(c);
    const ranged = me ? c.look.heroByKey.get(me)?.attackType === 'ranged' : false;
    const save = SAVE_ITEMS.find((k) => ownedKeys(c).has(k));
    const reach = range !== null ? ` на ${range}` : '';
    const what = mass.length
      ? `может прыгнуть${reach} и сразу применить ${mass[0]!.name}. Не стойте кучей с союзниками, держитесь в тумане дальше${range !== null ? ` ${range}` : ''} от него.`
      : `прыгнет${reach} на одного из тумана. ${save ? `Держите ${c.look.itemName(save)} наготове.` : 'Держите спасительный предмет или способность наготове.'}`;
    // Механика из базы знаний: Blink не работает N с после урона от героя — дальнобойный может держать его под уроном
    const pressure = ranged && lock !== null ? ` Пока бьёте его с дистанции, ${item} ${lock} с не работает.` : '';
    return draft({
      id: `macro.enemy-blink:${e.heroKey}`,
      ruleId: 'macro.enemy-blink',
      category: 'macro',
      priority: 'info',
      confidence: 0.7,
      short: mass.length ? `У ${hero} ${item}: не стойте кучей` : `У ${hero} ${item}: ждите прыжка`,
      normal: `У ${hero} ${item}: ${what}${pressure}`,
      facts: [derivedFact('enemy-item', `Предмет ${hero}`, item, 0.8), ...(range !== null ? [kbFact('blink-range', 'Дальность прыжка', range, c.look.data.kbVerified)] : []), ...(mass.length ? [kbFact('mass', 'Массовый контроль', mass.map((m) => m.name).join(', '), false)] : [])],
      ttlSec: 12,
      cooldownSec: 0,
      icon: `item:${e.key}`,
    });
  }
  return null;
};

/** Перед дракой («Вступать» на экране): у врага Blink, а он не виден или рядом — напоминание, раз в 5 мин на врага */
export const blinkFightRule: Rule = (c) => {
  const t = c.look.data.targeting ?? null;
  if (!playing(c) || !t || purchaseWait(c) || !c.engageGo) return null;
  const myPos = c.v.me.pos.value;
  for (const e of seen(c, BLINK_ITEMS)) {
    const p = c.v.enemies.find((x) => x.hero.value === e.heroKey);
    if (!p || p.alive.value === false) continue;
    const range = c.look.itemAttr(e.key, 'blink_range') ?? 1200;
    const d = p.missing !== true && p.pos.value && myPos ? Math.round(dist(p.pos.value, myPos)) : null;
    // Виден и рядом (дальность прыжка + подход) или только что ушёл в туман
    const justHid = p.missing === true && p.missingForSec !== null && p.missingForSec <= BLINK_FOG_SEC;
    if (!justHid && (d === null || d > range + BLINK_NEAR_EXTRA)) continue;
    const hero = c.look.heroName(e.heroKey);
    const item = c.look.itemName(e.key);
    const mass = massControl(c.look.heroByKey.get(e.heroKey), t);
    return draft({
      id: `macro.blink-watch:${e.heroKey}`,
      ruleId: 'macro.blink-watch',
      category: 'macro',
      priority: 'info',
      confidence: 0.65,
      short: `Осторожно: у ${hero} ${item}`,
      normal: `Перед дракой: ${hero} ${justHid ? `ушёл в туман ${p.missingForSec} с назад` : `в ${d} от вас`}, ${item} достаёт на ${range}. ${mass.length ? `${mass[0]!.name} заденет всех рядом — разойдитесь.` : 'Ждите прыжка и держите спасение наготове.'}`,
      facts: [derivedFact('enemy-item', `Предмет ${hero}`, item, 0.8), derivedFact('enemy-pos', `${hero}`, justHid ? `в тумане ${p.missingForSec} с` : `${d} ед.`, 0.7)],
      ttlSec: 8,
      cooldownSec: BLINK_REMIND_SEC,
      icon: `item:${e.key}`,
    });
  }
  return null;
};

/** Ваши способности (изученные) и предметы на одну цель по врагу — то, что Linken's Sphere заблокирует */
export function targetedTools(c: RuleContext): TargetedTool[] {
  const t = c.look.data.targeting;
  if (!t) return [];
  const out: TargetedTool[] = [];
  for (const a of c.v.me.abilities) {
    if (!a.key || !a.level || a.level < 1 || a.state === 'unlearned') continue;
    const f = t.abilities[a.key];
    const kb = c.look.abilityByKey.get(a.key);
    if (!f || !f.unitEnemy || f.passive || !kb || kb.innate) continue;
    const cds = kb.hero.abilities.find((x) => x.key === a.key)?.cooldowns ?? [];
    out.push({ key: a.key, name: kb.name, kind: 'ability', cooldown: cds.length ? cds[Math.min(cds.length, a.level) - 1]! : null, ult: a.ultimate || f.ult === true });
  }
  for (const key of ownedKeys(c)) {
    const f = t.items[key];
    if (!f || !f.unitEnemy || f.passive) continue;
    out.push({ key, name: c.look.itemName(key), kind: 'item', cooldown: c.look.itemByKey.get(key)?.cooldown ?? null, ult: false });
  }
  return out;
}

/**
 * Linken's Sphere у врага: если у вас есть что-то на одну цель — что сбивает сферу (самое дешёвое по перезарядке) и
 * что бить потом (ульта или самое долгое). Одно такое — «применяйте, когда сферу собьёт союзник». Нечем — молчим.
 */
export const linkenRule: Rule = (c) => {
  if (!playing(c) || !c.look.data.targeting || purchaseWait(c)) return null;
  for (const e of seen(c, ['sphere'])) {
    const once = `linken:${e.heroKey}`;
    if (c.mem.once.has(once)) continue;
    const tools = targetedTools(c);
    if (!tools.length) continue;
    c.mem.once.add(once);
    const hero = c.look.heroName(e.heroKey);
    const item = c.look.itemName('sphere');
    const block = c.look.itemAttr('sphere', 'block_cooldown');
    const every = block !== null ? ` раз в ${block} с` : '';
    const byCd = [...tools].sort((a, b) => (a.cooldown ?? 999) - (b.cooldown ?? 999));
    const main = tools.find((x) => x.ult) ?? byCd[byCd.length - 1]!;
    const cheap = byCd.find((x) => x !== main);
    const cd = (x: TargetedTool) => (x.cooldown !== null ? ` (перезарядка ${x.cooldown} с)` : '');
    return draft({
      id: `macro.enemy-linken:${e.heroKey}`,
      ruleId: 'macro.enemy-linken',
      category: 'macro',
      priority: 'info',
      confidence: 0.7,
      short: cheap ? `У ${hero} ${item}: сначала ${cheap.name}` : `У ${hero} ${item}: ${main.name} заблокируется`,
      normal: cheap
        ? `У ${hero} ${item}: сначала снимите сферу — ${cheap.name}${cd(cheap)}, потом ${main.name}. Сфера блокирует одно заклинание на одну цель${every}.`
        : `У ${hero} ${item}: ${main.name} заблокируется. Применяйте, когда сферу собьёт союзник — она восстанавливается${block !== null ? ` ${block} с` : ''}.`,
      facts: [derivedFact('enemy-item', `Предмет ${hero}`, item, 0.8), ...(block !== null ? [kbFact('linken-cd', 'Linken\'s Sphere: блок раз в, с', block, c.look.data.kbVerified)] : []), derivedFact('targeted', 'Ваше на одну цель', tools.map((x) => x.name).join(', '), 0.8)],
      ttlSec: 12,
      cooldownSec: 0,
      icon: 'item:sphere',
    });
  }
  return null;
};

export const ENEMY_ITEM_RULES: Rule[] = [blinkSeenRule, blinkFightRule, linkenRule];
