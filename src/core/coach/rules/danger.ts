// B. Незамеченная опасность: пропавшие враги, смок, ганкеры, глубоко в чужом лесу, мало здоровья, здания, Рошан,
// невидимые герои. Позиции врагов — только с мини-карты (с уверенностью); не видно — правило молчит.
import { personalNote } from '../profile.ts';
import { DETECTION_ITEMS } from '../data.ts';
import { hasItem, hasRegen, nearEnemyCount, tpReady } from '../memory.ts';
import { nearEnemies } from '../prob.ts';
import { BUILDING_RU, NEAR_UNITS, buildingLane, dist, isEnemyJungle, mapSide } from '../geo.ts';
import { derivedFact, fact, kbFact, poolPct } from '../view.ts';
import { draft, game, playing, plural, zoneRu, type Rule } from './context.ts';
import type { HintDraft } from '../types.ts';
import { dangerFeatures, dangerProbability, dangerReasons, itemValueOf, RISK_RULES, type DangerFeature } from '../danger-model.ts';

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
    normal: (critical ? `${n} врагов нет на мини-карте, а вы на их стороне карты — отойдите к своим башням.` : `${n} врагов нет на мини-карте, вы один — держитесь ближе к своим.`) + personalNote(c.look.data.profile, critical ? 'position' : 'laning-deaths'),
    facts: [derivedFact('missing', 'Врагов не видно', n, 0.75), derivedFact('side', 'Сторона карты', side, 0.7), derivedFact('alone', 'Союзников рядом нет', alone, 0.7)],
    ttlSec: 8,
    // реже (этап 5, режим тени: 2 270 раз на 100 игроков про-матчей)
    cooldownSec: 90,
  });
};

export const smokeRule: Rule = (c) => {
  if (!c.ev.smoke || !c.v.inGame) return null;
  // В лайнинге враги всё время уходят в туман у своих линий, а сразу после драки — отступают все вместе:
  // «трое пропали» тогда не смок (31 раз за 5 матчей)
  if (game(c).stage === 'laning' || c.mem.inFight) return null;
  const n = c.ev.smoke.length;
  return draft({
    id: 'danger.smoke',
    category: 'danger',
    priority: 'critical',
    confidence: 0.6,
    short: `Возможен Smoke of Deceit: ${n} ${plural(n, 'герой пропал', 'героя пропали', 'героев пропали')}`,
    normal: `${n} врагов исчезли с мини-карты почти одновременно — похоже на Smoke of Deceit. Будьте рядом с союзниками.`,
    facts: [derivedFact('smoke', 'Пропали одновременно', n, 0.6)],
    ttlSec: 10,
    cooldownSec: 180,
  });
};

export const gankerRule: Rule = (c) => {
  if (!playing(c) || !c.v.team || !c.v.me.pos.value) return null;
  const hp = poolPct(c.v.me.hp.value);
  const side = mapSide(c.v.me.pos.value, c.v.team);
  // В лайнинге — только при малом здоровье (на чужой половине вы и так стоите на линии)
  const laning = game(c).stage === 'laning';
  if (!((hp !== null && hp < 50) || (side === 'enemy' && !laning))) return null;
  // С союзниками рядом ганк не страшен — предупреждаем одиночку (режим тени: 923 раза на 100 игроков); в драке — не до того
  if (alliesNear(c) > 0 || c.mem.inFight) return null;
  const g = c.v.enemies.find((e) => {
    if (e.missing !== true || !e.hero.value) return false;
    const t = e.missingForSec ?? 0;
    const roles = c.look.heroByKey.get(e.hero.value)?.roles ?? [];
    return t >= 10 && t <= 60 && (roles.includes('Initiator') || roles.includes('Disabler'));
  });
  if (!g) return null;
  const name = c.look.heroName(g.hero.value);
  return draft({
    // Один id на правило: с id по герою предупреждения о разных героях шли подряд (78 раз за 5 матчей)
    id: 'danger.ganker',
    ruleId: 'danger.ganker',
    category: 'danger',
    priority: 'advice',
    confidence: 0.6,
    short: `${name} не видно ${Math.round(g.missingForSec ?? 0)} с — опасность ганка`,
    normal: `${name} не виден ${Math.round(g.missingForSec ?? 0)} с — он умеет ловить. ${hp !== null && hp < 50 ? 'У вас мало здоровья.' : 'Вы на чужой стороне.'}`,
    facts: [fact('ganker', 'Пропал', g.hero), derivedFact('missing-for', 'Не виден, с', Math.round(g.missingForSec ?? 0), 0.7), kbFact('roles', 'Роли (база)', 'Initiator/Disabler', false)],
    ttlSec: 8,
    cooldownSec: 150,
    icon: `hero:${g.hero.value}`,
  });
};

export const deepRule: Rule = (c) => {
  if (!playing(c) || !c.v.team) return null;
  if (!isEnemyJungle(c.v.me.zone, c.v.team) || alliesNear(c) > 0) return null;
  // В лайнинге оффлейнер и саппорт ходят через чужой лес на линию — а в начале игры «не видны» все враги сразу:
  // «опасно» звучало в 0:04 (режим тени, про-матчи STRATZ)
  if (game(c).stage === 'laning') return null;
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
  const near = nearEnemyCount(c.v);
  if (regen !== false || tp === true) return null;
  if (missing < 2 && near === 0) return null;
  return draft({
    id: 'danger.low-hp',
    category: 'danger',
    priority: 'critical',
    confidence: Math.min(0.9, c.v.me.hp.confidence),
    short: 'Мало здоровья, нет регена — назад',
    normal: `Здоровья ${Math.round(hp)}%, нет регенерации${tp === false ? ' и Town Portal Scroll' : ''}, врагов не видно — уходите к базе.`,
    facts: [fact('hp', 'Здоровье, %', { ...c.v.me.hp, value: Math.round(hp) }), derivedFact('regen', 'Есть реген', false, 0.9), derivedFact('tp', 'Town Portal Scroll готов', tp, 0.9), derivedFact('missing', 'Врагов не видно', missing, 0.75)],
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
      // бьют базу (башни 3–4-го уровня, казармы, трон) — для решения о выкупе
      if (/tower3_|tower4|rax_|fort/.test(b.key)) c.mem.marks.set('bld-base-attack@', c.now);
      const lane = buildingLane(b.key);
      const away = lane === null || c.v.me.zone !== lane;
      // Мёртвому важны только здания базы (решение о выкупе); в лайнинге башня 1-го уровня на чужой линии —
      // дело тех, кто на ней стоит (54 раза за 5 матчей, в том числе когда вы были мертвы)
      const base3 = /tower3_|tower4|rax_|fort/.test(b.key);
      const dead = c.v.me.alive.value === false;
      const relevant = dead ? base3 : !(game(c).stage === 'laning' && /tower1_/.test(b.key));
      if (away && relevant) {
        out.push(
          draft({
            id: `danger.building:${b.key}`,
            ruleId: 'danger.building',
            category: 'danger',
            priority: pct < 40 ? 'critical' : 'advice',
            confidence: 0.9,
            short: `Бьют ${BUILDING_RU(b.key)} (${Math.round(pct)}%)`,
            normal: `${BUILDING_RU(b.key)[0]!.toUpperCase()}${BUILDING_RU(b.key).slice(1)} под атакой: ${Math.round(pct)}% здоровья. Защитите${c.v.me.alive.value ? ' или телепорт' : ''}.`,
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
  if (missing < 3 || nearEnemyCount(c.v) > 0) return null;
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
  // в драке «купите пыль» не к месту (режим тени) — скажем после
  if (hasItem(c.v, DETECTION_ITEMS) || c.mem.inFight) return null;
  const inv = c.v.enemies.find((e) => e.hero.value && c.look.invisHeroes.has(e.hero.value) && e.alive.value !== false);
  if (!inv) return null;
  const name = c.look.heroName(inv.hero.value);
  const dust = c.look.itemCost('dust');
  return draft({
    // Один id на правило и перерыв 8 минут: напоминание о пыли шло каждые 4 минуты на каждого невидимку
    id: 'danger.invis',
    ruleId: 'danger.invis',
    category: 'danger',
    priority: 'advice',
    confidence: 0.7,
    short: `${name} невидим — купите пыль`,
    normal: `У врага ${name} есть невидимость, а у вас нет пыли или сентри. Пыль стоит ${dust ?? '?'}.`,
    facts: [fact('invis-hero', 'Невидимый враг', inv.hero), kbFact('dust-cost', 'Цена пыли', dust, c.look.data.kbVerified), kbFact('invis', 'Невидимость (по описанию способностей)', 'да', false)],
    ttlSec: 10,
    cooldownSec: 480,
    zone: 'timing',
    icon: 'item:dust',
  });
};

/** Модель опасности этого режима, если включена (на отложенных матчах она была лучше правил о риске) */
function dangerModelFor(c: Parameters<Rule>[0]) {
  const m = c.look.data.dangerModel;
  if (!m) return null;
  const mode = c.look.isTurbo ? m.turbo : m.normal;
  return mode.enabled ? { model: m, mode } : null;
}

const REASON_RU: Partial<Record<DangerFeature, string>> = {
  hp: 'мало здоровья',
  lowHp: 'здоровья почти нет',
  closeXhurt: 'враг вплотную, а вы ранены',
  enemiesNear: 'враги рядом',
  enemiesClose: 'враг вплотную',
  closestEnemy: 'враг совсем близко',
  outnumbered: 'врагов больше, чем союзников',
  enemyLevelAdv: 'у врагов рядом выше уровень',
  missing: 'враги пропали с карты',
  enemySide: 'вы на стороне врага',
  enemyJungle: 'вы в лесу врага',
  night: 'ночь',
  itemStage: 'поздняя игра — убивают быстро',
  level: 'поздняя игра — убивают быстро',
  enemyHp: 'враги рядом здоровы',
  lowHpXnear: 'мало здоровья при врагах рядом',
  alliesNear: 'драка рядом',
};

/** Предупреждение модели опасности: вероятность смерти в ближайшие 15 с не ниже порога режима */
export const modelRule: Rule = (c) => {
  if (!playing(c)) return null;
  const sel = dangerModelFor(c);
  if (!sel) return null;
  const itemValue = c.v.me.itemsKnown ? itemValueOf(c.v.me.items.map((i) => i.key), (k) => c.look.itemCost(k)) : null;
  const f = dangerFeatures(c.v, { itemValue, turbo: c.look.isTurbo });
  if (!f) return null;
  // «hp» в модели с отрицательным весом: малое здоровье — это (1 − hp); показываем как причину отдельно
  const p = dangerProbability(sel.mode.weights, f);
  if (p < sel.mode.threshold) return null;
  const hp = poolPct(c.v.me.hp.value);
  const reasons = [...new Set([...(hp !== null && hp < 40 ? ['мало здоровья'] : []), ...dangerReasons(sel.mode.weights, f, 4).map((r) => REASON_RU[r.feature]).filter((x): x is string => !!x)])].slice(0, 3);
  const pct = Math.round(p * 100);
  return draft({
    id: 'danger.model',
    category: 'danger',
    priority: 'critical',
    confidence: 0.7,
    short: 'Высокий риск смерти — отходите',
    normal: `Так обычно умирают в ближайшие ${sel.model.horizonSec} с${reasons.length ? `: ${reasons.join(', ')}` : ''}. Отойдите к своим.`,
    facts: [derivedFact('risk', `Риск смерти за ${sel.model.horizonSec} с, %`, pct, 0.7), derivedFact('near', 'Врагов рядом', nearEnemyCount(c.v), 0.75), ...(hp !== null ? [derivedFact('hp', 'Здоровье, %', Math.round(hp), 0.9)] : [])],
    ttlSec: 6,
    cooldownSec: sel.model.cooldownSec,
  });
};

/** Правило о риске уступает модели в режиме, где она включена и заменяет именно его */
const unlessModel =
  (id: (typeof RISK_RULES)[number], r: Rule): Rule =>
  (c) =>
    dangerModelFor(c)?.mode.replaces.includes(id) ? null : r(c);

export const DANGER_RULES: Rule[] = [smokeRule, modelRule, unlessModel('danger.low-hp', lowHpRule), unlessModel('danger.missing', missingRule), buildingRule, unlessModel('danger.deep', deepRule), unlessModel('danger.ganker', gankerRule), roshanRule, invisRule];
