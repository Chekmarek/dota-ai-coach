// A. Драки и решения: вступать ли, 1×1, драка/фарм/пуш/отход, цель, окно ульты, отход из проигранной драки, выкуп.
import { ACTION_RU, actionChoice, engagePercent, factorsText, matchupPercent, nearEnemies } from '../prob.ts';
import { nearEnemyCount, ultReady } from '../memory.ts';
import { derivedFact, fact, kbFact, poolPct } from '../view.ts';
import { draft, game, playing, plural, type Rule } from './context.ts';
import { NEAR_UNITS, dist } from '../geo.ts';
import type { HintDraft } from '../types.ts';

/** Сколько после «Отходи» не советовать «Вступать» */
export const DISENGAGE_HOLD_MS = 10_000;

export const engageRule: Rule = (c) => {
  if (!playing(c)) return null;
  // Врагов рядом — по мини-карте и полоскам на экране (на мини-карте двое рядом сливаются в один значок)
  const n = nearEnemyCount(c.v);
  if (n === 0) return null;
  const e = engagePercent(c.v, c.mem, c.look, c.settings.minPercentConfidence);
  if (c.mem.inFight && c.mem.engageAtEntry === null) c.mem.engageAtEntry = e.value;
  if (!e.showable) return null;
  // В лайнинге один враг рядом — это обычный размен на линии, а не драка: процент «вступать» каждые 15 с только мешал
  // (матч 9051402480: «Вступать: шанс 92%» в 0:10 на 1-м уровне)
  if (game(c).stage === 'laning' && n < 2) return null;
  const enemies = `${n} ${plural(n, 'враг', 'врага', 'врагов')} рядом`;
  // Только что сказали «Отходи» — «Вступать» сразу после него противоречит; ждём DISENGAGE_HOLD_MS
  const disengagedAt = c.mem.marks.get('disengage@');
  if (e.value >= 60 && disengagedAt !== undefined && c.now - disengagedAt < DISENGAGE_HOLD_MS) return null;
  const go = e.value >= 60;
  const no = e.value <= 40;
  const short = go ? `Вступать: шанс ${e.value}%` : no ? `Не вступать: шанс ${e.value}%` : `Драка на равных: ${e.value}%`;
  const facts = [
    derivedFact('enemies-near', 'Врагов рядом', n, 0.8),
    fact('hp', 'Здоровье, %', { ...c.v.me.hp, value: poolPct(c.v.me.hp.value) === null ? null : Math.round(poolPct(c.v.me.hp.value)!) }),
    derivedFact('engage', 'Шанс в драке, %', e.value, e.confidence),
  ];
  return draft({
    id: 'fight.engage',
    category: 'fight',
    priority: no && n >= 2 ? 'critical' : 'advice',
    confidence: e.confidence,
    short,
    normal: `${short}. ${enemies}.`,
    detailed: `${short}. ${enemies}. Почему: ${factorsText(e)}.`,
    facts,
    ttlSec: 8,
    cooldownSec: 15,
    percent: { label: go ? 'Вступать' : no ? 'Не вступать' : 'Драка', estimate: e },
  });
};

export const matchupRule: Rule = (c) => {
  if (!playing(c)) return null;
  const near = nearEnemies(c.v);
  if (near.length !== 1 || !near[0]!.hero.value) return null;
  const enemy = near[0]!;
  const e = matchupPercent(c.v, enemy, c.look, c.settings.minPercentConfidence);
  if (!e.showable) return null;
  const name = c.look.heroName(enemy.hero.value);
  const short = `1×1 против ${name}: ${e.value}%`;
  return draft({
    id: `fight.matchup:${enemy.hero.value}`,
    ruleId: 'fight.matchup',
    category: 'fight',
    priority: 'info',
    confidence: e.confidence,
    short,
    normal: `${short}. ${e.value >= 55 ? 'Можно давить' : e.value <= 45 ? 'Лучше не размениваться' : 'Примерно равны'}.`,
    detailed: `${short}. Почему: ${factorsText(e)}.`,
    facts: [fact('enemy', 'Враг', enemy.hero), derivedFact('matchup', 'Шанс 1×1, %', e.value, e.confidence)],
    ttlSec: 8,
    cooldownSec: 30,
    percent: { label: '1×1', estimate: e },
    icon: `hero:${enemy.hero.value}`,
  });
};

/** Матчап по запросу (кнопка «Матчапы» в интерфейсе): по всем врагам, кого знаем */
export function matchupsOnDemand(c: Parameters<Rule>[0]): HintDraft[] {
  return c.v.enemies
    .filter((e) => e.hero.value)
    .map((enemy) => {
      const e = matchupPercent(c.v, enemy, c.look, c.settings.minPercentConfidence);
      const name = c.look.heroName(enemy.hero.value);
      const short = e.showable ? `1×1 против ${name}: ${e.value}%` : `1×1 против ${name}: мало данных`;
      return draft({
        id: `fight.matchup:${enemy.hero.value}`,
        ruleId: 'fight.matchup',
        category: 'fight',
        priority: 'info',
        confidence: e.showable ? e.confidence : c.settings.minConfidence.info,
        short,
        normal: short,
        detailed: `${short}. ${factorsText(e)}.`,
        facts: [fact('enemy', 'Враг', enemy.hero)],
        ttlSec: 12,
        cooldownSec: 0,
        percent: e.showable ? { label: '1×1', estimate: e } : null,
        icon: `hero:${enemy.hero.value}`,
      });
    });
}

export const actionRule: Rule = (c) => {
  if (!playing(c) || c.mem.inFight) return null;
  if ((c.v.clock.value ?? 0) < 60) return null;
  const a = actionChoice(c.v, c.mem, c.look, c.settings.minPercentConfidence);
  if (!a.showable) return null;
  // Только когда план сменился (новое лучшее действие держится 3 с), а не по таймеру
  const ACTIONS = ['fight', 'farm', 'push', 'retreat'] as const;
  const idx = ACTIONS.indexOf(a.best);
  if (c.mem.marks.get('action-cand') !== idx) {
    c.mem.marks.set('action-cand', idx);
    c.mem.marks.set('action-cand@', c.now);
  }
  if (c.mem.marks.get('action-shown') === idx || c.now - (c.mem.marks.get('action-cand@') ?? c.now) < 3000) return null;
  c.mem.marks.set('action-shown', idx);
  const p = a.percents[a.best];
  const short = `${ACTION_RU[a.best]}: ${p}%`;
  const others = (Object.keys(a.percents) as (keyof typeof a.percents)[])
    .filter((k) => k !== a.best)
    .map((k) => `${ACTION_RU[k].toLowerCase()} ${a.percents[k]}%`)
    .join(', ');
  return draft({
    id: `fight.action:${a.best}`,
    ruleId: 'fight.action',
    category: 'fight',
    priority: a.best === 'retreat' && p >= 50 ? 'advice' : 'info',
    confidence: a.confidence,
    short,
    normal: `${short}${a.reasons.length ? ` — ${a.reasons[0]}` : ''}.`,
    detailed: `${short}. Остальное: ${others}.${a.reasons.length ? ` Почему: ${a.reasons.join(', ')}.` : ''}`,
    facts: [derivedFact('action', 'Рекомендация', a.best, a.confidence), derivedFact('action-pct', 'Доля, %', p, a.confidence)],
    ttlSec: 10,
    cooldownSec: 20,
  });
};

export const targetRule: Rule = (c) => {
  if (!playing(c)) return null;
  const near = nearEnemies(c.v).filter((e) => e.hpPercent.value !== null && e.hero.value && (e.hpPercent.ageSec ?? 99) <= 2);
  if (near.length < 2) return null;
  const t = near.reduce((a, b) => (b.hpPercent.value! < a.hpPercent.value! ? b : a));
  const name = c.look.heroName(t.hero.value);
  const hp = Math.round(t.hpPercent.value!);
  return draft({
    id: `fight.target:${t.hero.value}`,
    ruleId: 'fight.target',
    category: 'fight',
    priority: 'advice',
    confidence: t.hpPercent.confidence,
    short: `Фокус: ${name}, ${hp}% здоровья`,
    normal: `Бейте ${name}: у него меньше всех здоровья (${hp}%).`,
    facts: [fact('target', 'Цель', t.hero), fact('target-hp', 'Здоровье цели, %', { ...t.hpPercent, value: hp })],
    ttlSec: 5,
    cooldownSec: 8,
    icon: `hero:${t.hero.value}`,
  });
};

export const ultWindowRule: Rule = (c) => {
  if (!playing(c)) return null;
  const ready = ultReady(c.v);
  const prev = c.mem.marks.get('ult-ready');
  c.mem.marks.set('ult-ready', ready === null ? -1 : ready ? 1 : 0);
  const near = nearEnemies(c.v);
  const ult = c.v.me.abilities.find((a) => a.ultimate);
  // Ульта на перезарядке, а враги рядом
  if (ready === false && ult && (ult.level ?? 0) > 0 && (ult.cooldownSec ?? 0) > 20 && near.length >= 2) {
    const cd = Math.round(ult.cooldownSec!);
    return draft({
      id: 'fight.no-ult',
      category: 'fight',
      priority: 'advice',
      confidence: 0.9,
      short: `Ульта через ${cd} с — не драться`,
      normal: `Ульта будет готова через ${cd} с: в драку пока не лезьте.`,
      facts: [{ key: 'ult-cd', label: 'Перезарядка ульты, с', value: cd, source: 'gsi', ageSec: 0, confidence: 0.9, verified: true }],
      ttlSec: 6,
      cooldownSec: 30,
    });
  }
  // Ульта только что стала готова и враги видны
  if (ready === true && prev === 0 && c.v.enemies.some((e) => e.pos.value && (e.pos.ageSec ?? 99) <= 3)) {
    return draft({
      id: 'fight.ult-ready',
      category: 'fight',
      priority: 'info',
      confidence: 0.9,
      short: 'Ульта готова — окно для драки',
      normal: 'Ульта снова готова: хорошее окно, чтобы навязать драку.',
      facts: [{ key: 'ult', label: 'Ульта готова', value: true, source: 'gsi', ageSec: 0, confidence: 0.9, verified: true }],
      ttlSec: 6,
      cooldownSec: 45,
    });
  }
  return null;
};

export const disengageRule: Rule = (c) => {
  if (!playing(c) || !c.mem.inFight) return null;
  const me = c.v.me.pos.value;
  const s = c.mem.last(4, c.now);
  const before = s.length ? s[0]!.enemiesNear : 0;
  const now = nearEnemyCount(c.v);
  // Подкрепление — только если драка уже шла (враги были рядом и раньше)
  const reinforce = before >= 1 && now - before >= 2;
  // Союзник погиб рядом (там, где идёт ваша драка), а не на другом конце карты: раньше «Отходи: союзник погиб»
  // звучало на любую смерть союзника — 99 раз за 5 матчей
  const allyLost =
    me !== null &&
    c.ev.allyDied.some((slot) => {
      const a = c.v.allies.find((x) => x.slot === slot);
      return !!a?.pos.value && (a.pos.ageSec ?? 99) <= 5 && dist(a.pos.value, me) <= NEAR_UNITS * 1.5;
    });
  if (!reinforce && !allyLost) return null;
  // «Отходи» — только когда врагов рядом больше, чем вас с союзниками: иначе это противоречило «Вступать: 95%»
  // секундой раньше (матч 9051402480: 21:52, 22:10, 23:45, 26:07)
  const allies = c.mem.samples[c.mem.samples.length - 1]?.alliesNear ?? 0;
  if (now <= allies + 1) return null;
  c.mem.marks.set('disengage@', c.now);
  const short = reinforce ? 'Отходи: пришли ещё враги' : 'Отходи: союзник погиб';
  return draft({
    id: 'fight.disengage',
    category: 'fight',
    priority: 'critical',
    confidence: 0.7,
    short,
    normal: reinforce ? `Врагов стало ${now} вместо ${before} — драка проиграна, отходите.` : 'Союзник погиб в драке — без него лучше отойти.',
    facts: [derivedFact('enemies-near', 'Врагов рядом', now, 0.75), derivedFact('enemies-before', 'Врагов было', before, 0.75)],
    ttlSec: 6,
    cooldownSec: 15,
    zone: 'alert',
  });
};

export const buybackRule: Rule = (c) => {
  if (!playing(c)) return null;
  const clock = c.v.clock.value;
  const cost = c.v.me.buybackCost.value;
  const gold = c.v.me.gold.value;
  // Выкуп важен в лейте (стадия — по времени с поправкой на Турбо, уровню и потерянным зданиям), а не «после 25 минут»
  // обычной игры: в Турбо 25 минут — это уже конец матча
  if (clock === null || game(c).stage !== 'late' || cost === null || gold === null) return null;
  // Только что выкупились — выкуп на перезарядке: «выкуп X, у вас Y» тогда сбивает с толку (матч 9051402480, 32:10)
  if ((c.v.me.buybackCooldown.value ?? 0) > 0) return null;
  const facts = [fact('gold', 'Золото', c.v.me.gold), fact('buyback', 'Цена выкупа', c.v.me.buybackCost)];
  if (gold < cost && (c.mem.inFight || nearEnemyCount(c.v) > 0)) {
    return draft({
      id: 'fight.no-buyback',
      category: 'fight',
      priority: 'advice',
      confidence: 0.9,
      // Сама цена выкупа и золото — как в игре; одна недостача («не хватает 4291») читалась как цена выкупа
      short: `Выкуп ${cost}, у вас ${gold}`,
      normal: `Выкуп стоит ${cost}, у вас ${gold}: смерть сейчас дорогая — осторожнее.`,
      facts,
      ttlSec: 8,
      cooldownSec: 90,
    });
  }
  if (gold >= cost && gold < cost + 600) {
    return draft({
      id: 'fight.keep-buyback',
      category: 'economy',
      priority: 'info',
      confidence: 0.8,
      short: `Держите ${cost} золота на выкуп`,
      normal: `Поздняя игра: не тратьте последние ${cost} — это выкуп.`,
      facts: [...facts, derivedFact('stage', 'Стадия игры', 'лейт', 0.8)],
      ttlSec: 8,
      cooldownSec: 300,
    });
  }
  return null;
};

// actionRule («Фармить: 59%») убран (аудит, этап 1): проценты эвристики без стадии и роли, дублировал совет «что делать»
export const FIGHT_RULES: Rule[] = [disengageRule, engageRule, matchupRule, targetRule, ultWindowRule, buybackRule];
