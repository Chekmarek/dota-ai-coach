// C. Линия: добивания против ориентира, реген, бутылка, стаки и пулы, уровни силы (свой 6-й, 6-й у видимых врагов).
import { mapZone } from '../../match-state/map-zones.ts';
import { hasRegen } from '../memory.ts';
import { nearEnemies } from '../prob.ts';
import { isOwnBase } from '../geo.ts';
import { derivedFact, fact, kbFact, poolPct } from '../view.ts';
import { draft, playing, type Rule, type RuleContext } from './context.ts';
import type { HintDraft } from '../types.ts';

/** Роль на линии (как lane_role OpenDota): по тому, где герой стоял с 1:00 по 8:00. null — не понять */
export function laneRole(c: RuleContext): 1 | 2 | 3 | 4 | null {
  if (!c.v.team) return null;
  const counts = new Map<string, number>();
  for (const s of c.mem.samples) {
    if (s.clock === null || s.clock < 60 || s.clock > 480 || !s.pos) continue;
    const z = mapZone(s.pos.x, s.pos.y);
    counts.set(z, (counts.get(z) ?? 0) + 1);
  }
  const total = [...counts.values()].reduce((a, b) => a + b, 0);
  if (total < 90) return null;
  const [zone, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!;
  if (n / total < 0.45) return null;
  const radiant = c.v.team === 'radiant';
  if (zone === 'mid-lane') return 2;
  if (zone === 'bot-lane') return radiant ? 1 : 3;
  if (zone === 'top-lane') return radiant ? 3 : 1;
  if (zone.endsWith('jungle')) return 4;
  return null;
}

const ROLE_RU = { 1: 'лёгкая линия', 2: 'центр', 3: 'сложная линия', 4: 'лес' } as const;

export const csRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const lh = c.v.me.lastHits.value;
  if (!playing(c) || clock === null || lh === null || clock < 5 * 60 || clock > 12 * 60) return null;
  const role = laneRole(c);
  // Добивания профи — из обычных матчей; в Турбо норм нет
  if (role === null || role === 4 || !c.look.hasNorms) return null;
  const st = c.look.statsFor(c.v.me.hero.value?.id, c.v.me.hero.value?.key);
  const ref = st?.pro?.lhAt10[String(role)];
  if (!ref || ref.n < 5) return null;
  // Ориентир к текущей минуте: линейно от 1:30 (первые крипы) до 10:00
  const expected = Math.round((ref.median * Math.max(0, clock - 90)) / (600 - 90));
  if (expected < 10 || lh >= expected * 0.55) return null;
  return draft({
    id: 'laning.cs',
    category: 'laning',
    priority: 'info',
    confidence: 0.7,
    short: `Мало добиваний: ${lh} из ~${expected}`,
    normal: `Добиваний ${lh}, у профессионалов на этом герое к этой минуте ~${expected}. Сосредоточьтесь на крипах.`,
    facts: [
      fact('lh', 'Добиваний', c.v.me.lastHits),
      { key: 'lh-ref', label: `Ориентир (профи, ${ROLE_RU[role]}, к 10:00)`, value: ref.median, source: 'stats', ageSec: null, confidence: Math.min(1, ref.n / 30), verified: false },
      derivedFact('role', 'Роль на линии', ROLE_RU[role], 0.7),
    ],
    ttlSec: 10,
    cooldownSec: 150,
  });
};

const hasInv = (c: RuleContext, key: string) => c.v.me.items.some((i) => i.key === key && !i.slot.startsWith('stash') && !i.slot.startsWith('bp') && (i.charges === null || i.charges > 0));

export const regenRule: Rule = (c) => {
  if (!playing(c) || c.mem.inFight || !c.v.me.itemsKnown) return null;
  const clock = c.v.clock.value ?? 0;
  if (clock > 20 * 60 || (c.v.team && isOwnBase(c.v.me.zone, c.v.team))) return null;
  const hp = poolPct(c.v.me.hp.value);
  const mana = poolPct(c.v.me.mana.value);
  const out: HintDraft[] = [];
  const hpFact = fact('hp', 'Здоровье, %', { ...c.v.me.hp, value: hp === null ? null : Math.round(hp) });
  if (hp !== null && hp < 45) {
    const use = hasInv(c, 'flask') ? 'flask' : hasInv(c, 'tango') ? 'tango' : null;
    if (use) {
      out.push(
        draft({
          id: 'laning.use-regen',
          category: 'laning',
          priority: 'advice',
          confidence: 0.85,
          short: use === 'flask' ? 'Мало здоровья — выпейте Healing Salve' : 'Мало здоровья — съешьте Tango',
          normal: `Здоровья ${Math.round(hp)}%: восстановитесь, пока враг не давит.`,
          facts: [hpFact],
          ttlSec: 8,
          cooldownSec: 60,
          icon: `item:${use}`,
        }),
      );
    } else if (hasRegen(c.v) === false) {
      const cost = c.look.itemCost('flask');
      const gold = c.v.me.gold.value;
      if (cost !== null && gold !== null && gold >= cost) {
        out.push(
          draft({
            id: 'laning.buy-regen',
            category: 'laning',
            priority: 'advice',
            confidence: 0.8,
            short: 'Купите Healing Salve — курьером',
            normal: `Здоровья ${Math.round(hp)}%, регенерации нет. Healing Salve стоит ${cost}, у вас ${gold}.`,
            facts: [hpFact, kbFact('flask-cost', 'Цена Healing Salve', cost, c.look.data.kbVerified), fact('gold', 'Золото', c.v.me.gold)],
            ttlSec: 8,
            cooldownSec: 90,
            icon: 'item:flask',
          }),
        );
      }
    }
  }
  if (mana !== null && mana < 25 && (c.v.me.mana.value?.max ?? 0) > 0 && (hasInv(c, 'clarity') || hasInv(c, 'enchanted_mango'))) {
    const use = hasInv(c, 'clarity') ? 'clarity' : 'enchanted_mango';
    out.push(
      draft({
        id: 'laning.use-mana',
        category: 'laning',
        priority: 'info',
        confidence: 0.85,
        short: use === 'clarity' ? 'Мало маны — выпейте Clarity' : 'Мало маны — съешьте Enchanted Mango',
        normal: `Маны ${Math.round(mana)}%.`,
        facts: [fact('mana', 'Мана, %', { ...c.v.me.mana, value: Math.round(mana) })],
        ttlSec: 8,
        cooldownSec: 90,
        icon: `item:${use}`,
      }),
    );
  }
  const bottle = c.v.me.items.find((i) => i.key === 'bottle' && !i.slot.startsWith('stash'));
  if (bottle && bottle.charges === 0) {
    out.push(
      draft({
        id: 'laning.bottle',
        category: 'laning',
        priority: 'info',
        confidence: 0.9,
        short: 'Бутылка пуста — руна или база',
        normal: 'Бутылка пуста: наполните её руной или у фонтана.',
        facts: [{ key: 'bottle', label: 'Зарядов бутылки', value: 0, source: 'gsi', ageSec: 0, confidence: 1, verified: true }],
        ttlSec: 8,
        cooldownSec: 120,
        icon: 'item:bottle',
      }),
    );
  }
  return out;
};

export const levelRule: Rule = (c) => {
  if (!c.v.inGame) return null;
  const out: HintDraft[] = [];
  if (c.ev.levelUp === 6) {
    out.push(
      draft({
        id: 'laning.level6',
        category: 'laning',
        priority: 'info',
        confidence: 0.95,
        short: '6 уровень: ульта — ищите убийство',
        normal: 'У вас 6 уровень и ульта: сильное окно, чтобы убить врага на линии.',
        facts: [fact('level', 'Уровень', c.v.me.level)],
        ttlSec: 8,
        cooldownSec: 600,
      }),
    );
  }
  for (const e of nearEnemies(c.v)) {
    if (e.barLevel === null || e.barLevel < 6 || !e.hero.value || c.mem.once.has(`lvl6:${e.slot}`)) continue;
    c.mem.once.add(`lvl6:${e.slot}`);
    const name = c.look.heroName(e.hero.value);
    out.push(
      draft({
        id: `laning.enemy6:${e.hero.value}`,
        ruleId: 'laning.enemy6',
        category: 'laning',
        priority: 'advice',
        confidence: 0.7,
        short: `${name}: 6 уровень — бойтесь ульты`,
        normal: `У ${name} уже 6 уровень: учитывайте его ульту.`,
        facts: [{ key: 'enemy-level', label: `Уровень ${name} (полоска)`, value: e.barLevel, source: 'screen', ageSec: 0, confidence: 0.7, verified: true }],
        ttlSec: 8,
        cooldownSec: 0,
        icon: `hero:${e.hero.value}`,
      }),
    );
  }
  return out;
};

/** Стак и пул: напоминание за несколько секунд, если герой у своего леса (или это саппорт) */
export const stackRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 60 || !c.v.team || c.mem.inFight) return null;
  const from = c.look.mechanicValue('neutral-stack-window', 'fromSecond');
  const to = c.look.mechanicValue('neutral-stack-window', 'toSecond');
  if (from === null || to === null) return null;
  const sec = ((clock % 60) + 60) % 60;
  const ownJungle = c.v.me.zone === (c.v.team === 'radiant' ? 'radiant-jungle' : 'dire-jungle');
  const roles = c.look.heroByKey.get(c.v.me.hero.value?.key ?? '')?.roles ?? [];
  const support = roles.includes('Support') && !roles.includes('Carry');
  if (!ownJungle && !(support && clock < 15 * 60)) return null;
  if (sec < from - 8 || sec > from - 3) return null;
  return draft({
    id: 'timing.stack',
    category: 'timing',
    priority: 'info',
    confidence: 0.8,
    short: `Стак: тяните лагерь в :${from}–:${to}`,
    normal: `Через ${Math.round(from - sec)} с окно стака (:${from}–:${to}). Ударьте лагерь и уведите крипов.`,
    facts: [kbFact('stack', 'Окно стака, с минуты', `${from}–${to}`, false), fact('clock', 'Игровое время, с', c.v.clock)],
    ttlSec: 8,
    cooldownSec: ownJungle ? 50 : 170,
  });
};

export const LANING_RULES: Rule[] = [regenRule, levelRule, csRule, stackRule];
