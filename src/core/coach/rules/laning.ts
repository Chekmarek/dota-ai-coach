// C. Линия: добивания против ориентира, реген, бутылка, стаки и пулы, уровни силы (свой 6-й, 6-й у видимых врагов).
import { mapZone } from '../../match-state/map-zones.ts';
import { hasRegen } from '../memory.ts';
import { nearEnemies } from '../prob.ts';
import { isOwnBase } from '../geo.ts';
import { derivedFact, fact, kbFact, poolPct } from '../view.ts';
import { draft, game, playing, type Rule, type RuleContext } from './context.ts';
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
  // Реген расходниками — совет лайнинга: в мидгейме и лейте «съешьте Tango» звучит нелепо (раньше — до 20:00, а в
  // Турбо 20:00 — уже лейт)
  if (game(c).stage !== 'laning' || (c.v.team && isOwnBase(c.v.me.zone, c.v.team))) return null;
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
  // Пассивная ульта (Bristleback) — «ищите убийство с ультой» не про неё
  if (c.ev.levelUp === 6 && game(c).hero.ultPassive !== true) {
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

/** Минуты сравнения с профи (обычная игра) */
export const BENCH_MINUTES = [5, 10, 15, 20, 25] as const;
/** Отставание, о котором стоит сказать: меньше этой доли медианы профи */
export const BENCH_LOW = 0.75;

/**
 * Сравнение с сильными игроками на этом герое (этап 3): на 5, 10, 15, 20, 25-й минуте — добивания (корам), заработанное
 * золото и опыт против медианы профи патча на той же позиции (OpenDota, gold_t / xp_t / lh_t). Говорим о самом большом
 * отставании (меньше 75% медианы) или хвалим, если добивания выше верхней четверти профи. Один раз на минуту сравнения.
 * В Турбо молчит: профи в Турбо не играют, а пересчитывать нормы обычной игры «на глаз» нельзя.
 */
export const benchRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || c.mem.inFight) return null;
  const min = BENCH_MINUTES.find((m) => clock >= m * 60 && clock < m * 60 + 45);
  if (min === undefined || c.mem.once.has(`bench:${min}`)) return null;
  const g = game(c);
  const p = c.look.proAt(g.hero.key, g.position, min);
  if (!p) return null;
  c.mem.once.add(`bench:${min}`);
  const lh = c.v.me.lastHits.value;
  const gpm = c.v.me.gpm.value;
  const xpm = c.v.me.xpm.value;
  const gold = gpm === null ? null : Math.round(gpm * (clock / 60));
  const xp = xpm === null ? null : Math.round(xpm * (clock / 60));
  const who = `у профи на ${g.hero.name ?? 'этом герое'}${p.position !== null ? ` (позиция ${p.position})` : ''}`;
  const core = g.core !== false;
  type Gap = { what: string; mine: number; ref: number; ratio: number };
  const gaps: Gap[] = [];
  if (core && lh !== null && p.lh50) gaps.push({ what: 'Добивания', mine: lh, ref: p.lh50, ratio: lh / p.lh50 });
  if (gold !== null && p.gold50) gaps.push({ what: 'Золото', mine: gold, ref: p.gold50, ratio: gold / p.gold50 });
  if (xp !== null && p.xp50) gaps.push({ what: 'Опыт', mine: xp, ref: p.xp50, ratio: xp / p.xp50 });
  const worst = gaps.filter((x) => x.ratio < BENCH_LOW).sort((a, b) => a.ratio - b.ratio)[0];
  const facts = [
    fact('lh', 'Добиваний', c.v.me.lastHits),
    derivedFact('gold-earned', 'Золота заработано (GPM × минуты)', gold, 0.8),
    { key: 'pro-lh', label: `Добивания профи к ${min}:00, медиана`, value: p.lh50, source: 'stats' as const, ageSec: null, confidence: Math.min(1, p.n / 40), verified: false },
    { key: 'pro-gold', label: `Золото профи к ${min}:00, медиана`, value: p.gold50, source: 'stats' as const, ageSec: null, confidence: Math.min(1, p.n / 40), verified: false },
  ];
  if (worst) {
    const how = worst.what === 'Добивания' ? 'Добивайте крипов: не пропускайте волны между драками.' : worst.what === 'Золото' ? 'Больше фарма: волна, лагерь, снова волна.' : 'Больше опыта: стойте у волн, не пропускайте драки рядом.';
    return draft({
      id: 'laning.bench',
      category: 'laning',
      priority: 'info',
      confidence: 0.75,
      short: `${worst.what} ${worst.mine} к ${min}:00, у профи ~${worst.ref}`,
      normal: `${worst.what}: ${worst.mine} к ${min}:00, ${who} обычно ~${worst.ref}. ${how}`,
      facts,
      ttlSec: 10,
      cooldownSec: 0,
    });
  }
  if (core && lh !== null && p.lh75 && lh >= p.lh75) {
    return draft({
      id: 'laning.bench',
      category: 'laning',
      priority: 'info',
      confidence: 0.75,
      short: `Отличный фарм: ${lh} добиваний к ${min}:00`,
      normal: `${lh} добиваний к ${min}:00 — больше, чем у трёх четвертей профи на этом герое (~${p.lh75}). Так держать.`,
      facts,
      ttlSec: 8,
      cooldownSec: 0,
    });
  }
  return null;
};

// csRule (добивания против lhAt10) заменён benchRule: тот же ориентир профи, но по минутам и с золотом и опытом
// stackRule этого файла не подключён: дублировал timing.stack из timings.ts (одинаковый id, разные тексты — аудит, этап 1)
export const LANING_RULES: Rule[] = [regenRule, levelRule, benchRule];
