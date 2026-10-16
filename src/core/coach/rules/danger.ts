// B. Незамеченная опасность: пропавшие враги, смок, ганкеры, глубоко в чужом лесу, мало здоровья, здания, Рошан,
// невидимые герои. Позиции врагов — только с мини-карты (с уверенностью); не видно — правило молчит.
import { DETECTION_ITEMS } from '../data.ts';
import { hasItem, hasRegen, tpReady } from '../memory.ts';
import { nearEnemies } from '../prob.ts';
import { BUILDING_RU, NEAR_UNITS, buildingLane, dist, isEnemyJungle, mapSide } from '../geo.ts';
import { derivedFact, fact, kbFact, poolPct } from '../view.ts';
import { draft, playing, plural, zoneRu, type Rule } from './context.ts';
import type { HintDraft } from '../types.ts';

const alliesNear = (c: Parameters<Rule>[0]): number => {
  const me = c.v.me.pos.value;
  if (!me) return 0;
  return c.v.allies.filter((a) => a.alive.value !== false && a.pos.value && (a.pos.ageSec ?? 99) <= 3 && dist(a.pos.value, me) <= NEAR_UNITS).length;
};

export const missingRule: Rule = (c) => {
  if (!playing(c) || !c.v.team || !c.v.me.pos.value) return null;
  const missing = c.v.enemies.filter((e) => e.missing === true && (e.missingForSec ?? 0) >= 8);
  if (missing.length < 3) return null;
  const side = mapSide(c.v.me.pos.value, c.v.team);
  const alone = alliesNear(c) === 0;
  if (side === 'own' && !alone) return null;
  const n = missing.length;
  const critical = side !== 'own';
  const short = critical ? `${n} ${plural(n, 'враг пропал', 'врага пропали', 'врагов пропали')} — назад` : `${n} ${plural(n, 'врага', 'врагов', 'врагов')} не видно — осторожно`;
  return draft({
    id: 'danger.missing',
    category: 'danger',
    priority: critical ? 'critical' : 'advice',
    confidence: 0.75,
    short,
    normal: critical ? `${n} врагов нет на мини-карте, а вы на их стороне карты — отойдите к своим башням.` : `${n} врагов нет на мини-карте, вы один — держитесь ближе к своим.`,
    facts: [derivedFact('missing', 'Врагов не видно', n, 0.75), derivedFact('side', 'Сторона карты', side, 0.7), derivedFact('alone', 'Союзников рядом нет', alone, 0.7)],
    ttlSec: 8,
    cooldownSec: 45,
  });
};

export const smokeRule: Rule = (c) => {
  if (!c.ev.smoke || !c.v.inGame) return null;
  const n = c.ev.smoke.length;
  return draft({
    id: 'danger.smoke',
    category: 'danger',
    priority: 'critical',
    confidence: 0.6,
    short: `Возможен смок: ${n} ${plural(n, 'герой пропал', 'героя пропали', 'героев пропали')}`,
    normal: `${n} врагов исчезли с мини-карты почти одновременно — похоже на Smoke of Deceit. Будьте рядом с союзниками.`,
    facts: [derivedFact('smoke', 'Пропали одновременно', n, 0.6)],
    ttlSec: 10,
    cooldownSec: 60,
  });
};

export const gankerRule: Rule = (c) => {
  if (!playing(c) || !c.v.team || !c.v.me.pos.value) return null;
  const hp = poolPct(c.v.me.hp.value);
  const side = mapSide(c.v.me.pos.value, c.v.team);
  if (!((hp !== null && hp < 50) || side === 'enemy')) return null;
  const g = c.v.enemies.find((e) => {
    if (e.missing !== true || !e.hero.value) return false;
    const t = e.missingForSec ?? 0;
    const roles = c.look.heroByKey.get(e.hero.value)?.roles ?? [];
    return t >= 10 && t <= 60 && (roles.includes('Initiator') || roles.includes('Disabler'));
  });
  if (!g) return null;
  const name = c.look.heroName(g.hero.value);
  return draft({
    id: `danger.ganker:${g.hero.value}`,
    ruleId: 'danger.ganker',
    category: 'danger',
    priority: 'advice',
    confidence: 0.6,
    short: `${name} пропал — опасность ганка`,
    normal: `${name} не виден ${Math.round(g.missingForSec ?? 0)} с — он умеет ловить. ${hp !== null && hp < 50 ? 'У вас мало здоровья.' : 'Вы на чужой стороне.'}`,
    facts: [fact('ganker', 'Пропал', g.hero), derivedFact('missing-for', 'Не виден, с', Math.round(g.missingForSec ?? 0), 0.7), kbFact('roles', 'Роли (база)', 'Initiator/Disabler', false)],
    ttlSec: 8,
    cooldownSec: 40,
    icon: `hero:${g.hero.value}`,
  });
};

export const deepRule: Rule = (c) => {
  if (!playing(c) || !c.v.team) return null;
  if (!isEnemyJungle(c.v.me.zone, c.v.team) || alliesNear(c) > 0) return null;
  const night = c.v.dayNight.value === 'night';
  const missing = c.v.enemies.filter((e) => e.missing === true).length;
  if (!night && missing < 2) return null;
  return draft({
    id: 'danger.deep',
    category: 'danger',
    priority: night && missing >= 2 ? 'critical' : 'advice',
    confidence: 0.65,
    short: night ? 'Ночь, чужой лес — опасно' : 'Чужой лес без обзора — опасно',
    normal: `Вы один в лесу врага${night ? ' ночью' : ''}, ${missing} врагов не видно. Фармите ближе к своим.`,
    facts: [derivedFact('zone', 'Где вы', zoneRu(c.v.me.zone), 0.7), fact('day-night', 'Время суток', c.v.dayNight), derivedFact('missing', 'Врагов не видно', missing, 0.75)],
    ttlSec: 8,
    cooldownSec: 60,
  });
};

export const lowHpRule: Rule = (c) => {
  if (!playing(c)) return null;
  const hp = poolPct(c.v.me.hp.value);
  if (hp === null || hp >= 30) return null;
  const regen = hasRegen(c.v);
  const tp = tpReady(c.v);
  const missing = c.v.enemies.filter((e) => e.missing === true).length;
  const near = nearEnemies(c.v).length;
  if (regen !== false || tp === true) return null;
  if (missing < 2 && near === 0) return null;
  return draft({
    id: 'danger.low-hp',
    category: 'danger',
    priority: 'critical',
    confidence: Math.min(0.9, c.v.me.hp.confidence),
    short: 'Мало здоровья, нет регена — назад',
    normal: `Здоровья ${Math.round(hp)}%, нет регенерации${tp === false ? ' и ТП' : ''}, врагов не видно — уходите к базе.`,
    facts: [fact('hp', 'Здоровье, %', { ...c.v.me.hp, value: Math.round(hp) }), derivedFact('regen', 'Есть реген', false, 0.9), derivedFact('tp', 'ТП готов', tp, 0.9), derivedFact('missing', 'Врагов не видно', missing, 0.75)],
    ttlSec: 8,
    cooldownSec: 30,
  });
};

export const buildingRule: Rule = (c) => {
  if (!c.v.inGame || !c.v.buildings) return null;
  const out: HintDraft[] = [];
  for (const b of c.v.buildings) {
    const pct = (b.health / b.maxHealth) * 100;
    const key = `bld:${b.key}`;
    // База для сравнения — здоровье до 6 с назад: урон по башне идёт понемногу каждую секунду
    const base = c.mem.marks.get(key);
    const baseAt = c.mem.marks.get(`${key}@`);
    if (base === undefined || baseAt === undefined || c.now - baseAt > 6000 || pct > base) {
      c.mem.marks.set(key, pct);
      c.mem.marks.set(`${key}@`, c.now);
      continue;
    }
    if (base - pct >= 4 && pct > 0) {
      c.mem.marks.set('bld-attack@', c.now);
      const lane = buildingLane(b.key);
      const away = lane === null || c.v.me.zone !== lane;
      if (away) {
        out.push(
          draft({
            id: `danger.building:${b.key}`,
            ruleId: 'danger.building',
            category: 'danger',
            priority: pct < 40 ? 'critical' : 'advice',
            confidence: 0.9,
            short: `Бьют ${BUILDING_RU(b.key)}`,
            normal: `${BUILDING_RU(b.key)[0]!.toUpperCase()}${BUILDING_RU(b.key).slice(1)} под атакой: ${Math.round(pct)}% здоровья. Защитите${c.v.me.alive.value ? ' или ТП' : ''}.`,
            facts: [{ key: 'building-hp', label: 'Здоровье здания, %', value: Math.round(pct), source: 'gsi', ageSec: 0, confidence: 1, verified: true }],
            ttlSec: 8,
            cooldownSec: 45,
          }),
        );
      }
      c.mem.marks.set(key, pct);
      c.mem.marks.set(`${key}@`, c.now);
    }
  }
  return out;
};

export const roshanRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 15 * 60) return null;
  const missing = c.v.enemies.filter((e) => e.missing === true && (e.missingForSec ?? 0) >= 10).length;
  if (missing < 3 || nearEnemies(c.v).length > 0) return null;
  const min = c.look.mechanicValue('roshan-respawn', 'min');
  const dead = c.mem.roshanKilledAt;
  if (dead !== null && (min === null || clock - dead < min)) return null;
  return draft({
    id: 'danger.roshan',
    category: 'danger',
    priority: 'info',
    confidence: 0.45 + (dead === null ? 0 : 0.1),
    short: 'Враги пропали — возможно, Рошан',
    normal: `${missing} врагов не видно, Рошан ${dead === null ? 'не убит' : 'мог возродиться'} — проверьте яму Рошана.`,
    facts: [derivedFact('missing', 'Врагов не видно', missing, 0.75), derivedFact('roshan-dead-at', 'Рошан убит в', dead, dead === null ? 0.5 : 1)],
    ttlSec: 10,
    cooldownSec: 120,
  });
};

export const invisRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 6 * 60 || !c.v.me.itemsKnown) return null;
  if (hasItem(c.v, DETECTION_ITEMS)) return null;
  const inv = c.v.enemies.find((e) => e.hero.value && c.look.invisHeroes.has(e.hero.value) && e.alive.value !== false);
  if (!inv) return null;
  const name = c.look.heroName(inv.hero.value);
  const dust = c.look.itemCost('dust');
  return draft({
    id: `danger.invis:${inv.hero.value}`,
    ruleId: 'danger.invis',
    category: 'danger',
    priority: 'advice',
    confidence: 0.7,
    short: `${name} невидим — купите пыль`,
    normal: `У врага ${name} есть невидимость, а у вас нет пыли или сентри. Пыль стоит ${dust ?? '?'}.`,
    facts: [fact('invis-hero', 'Невидимый враг', inv.hero), kbFact('dust-cost', 'Цена пыли', dust, c.look.data.kbVerified), kbFact('invis', 'Невидимость (по описанию способностей)', 'да', false)],
    ttlSec: 10,
    cooldownSec: 240,
    zone: 'timing',
    icon: 'item:dust',
  });
};

export const DANGER_RULES: Rule[] = [smokeRule, lowHpRule, missingRule, buildingRule, deepRule, gankerRule, roshanRule, invisRule];
