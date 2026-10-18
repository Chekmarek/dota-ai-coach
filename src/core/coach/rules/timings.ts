// Дополнительные тайминги карты: стак для саппорта, лотосы, уровни нейтральных предметов, конец Аегиса.
// Время — из механики базы знаний (mechanics.json); нет значения — правило молчит.
import { upcomingEvents } from '../../knowledge-base/timers.ts';
import { myRole } from './draft.ts';
import { fact, kbFact } from '../view.ts';
import { draft, game, mmss, playing, type Rule, type RuleContext } from './context.ts';
import type { HintDraft } from '../types.ts';

// Саппорт — по позиции (4–5) из контекста игры; позиция не известна — по герою, как раньше
const isSupport = (c: RuleContext): boolean => {
  const g = game(c);
  return g.position !== null ? g.position >= 4 : myRole(c) === 'support';
};

/** Саппорту: окно стака через несколько секунд — пора к лагерю (с 3-й по 20-ю минуту, не в драке) */
export const stackRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 3 * 60 || clock > 20 * 60 || c.mem.inFight || !isSupport(c)) return null;
  const e = upcomingEvents(c.look.mechanics, clock).find((x) => x.id === 'stack-window');
  if (!e || e.status !== 'ok' || e.inSec === null || e.at === null || e.inSec > 12 || e.inSec < 5) return null;
  const sec = Math.round(((e.at % 60) + 60) % 60);
  return draft({
    id: 'timing.stack',
    category: 'timing',
    priority: 'info',
    confidence: e.verification === 'verified' ? 0.9 : 0.75,
    short: `Стак в :${sec} — к лагерю`,
    normal: `Через ${Math.round(e.inSec)} с окно стака (:${sec}). Ударьте лагерь и уведите крипов — лес удвоится для кора.`,
    facts: [kbFact('stack-window', 'Окно стака', mmss(e.at), e.verification === 'verified'), fact('clock', 'Игровое время, с', c.v.clock)],
    ttlSec: 8,
    cooldownSec: 150,
    zone: 'timing',
  });
};

/** Лотосы у пруда: первые четыре появления (до 12:00), за 15 с */
export const lotusRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!c.v.inGame || clock === null || clock > 12 * 60) return null;
  const m = c.look.mechanic('lotus-pool');
  const s = m?.schedule;
  if (!m || m.verification === 'missing' || !s || s.firstAt === null || s.interval === null) return null;
  const at = clock <= s.firstAt ? s.firstAt : s.firstAt + Math.ceil((clock - s.firstAt) / s.interval) * s.interval;
  const inSec = at - clock;
  if (inSec > 15 || inSec < 3 || c.mem.once.has(`lotus@${at}`)) return null;
  c.mem.once.add(`lotus@${at}`);
  return draft({
    id: 'timing.lotus',
    category: 'timing',
    priority: 'info',
    confidence: 0.8,
    short: `Лотос через ${Math.round(inSec)} с`,
    normal: `В ${mmss(at)} у пруда появится лотос (лечение и мана). Ближайший — заберите.`,
    facts: [kbFact('lotus', 'Лотос', mmss(at), m.verification === 'verified')],
    ttlSec: 8,
    cooldownSec: 0,
    zone: 'timing',
  });
};

/** Новый уровень нейтральных предметов — один раз на каждый уровень */
export const neutralTierRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!c.v.inGame || clock === null) return null;
  const out: HintDraft[] = [];
  for (const tier of [2, 3, 4, 5]) {
    const at = c.look.mechanicValue('neutral-items-tiers', `t${tier}`);
    if (at === null || clock < at || clock > at + 30 || c.mem.once.has(`neutral-tier:${tier}`)) continue;
    c.mem.once.add(`neutral-tier:${tier}`);
    out.push(
      draft({
        id: `timing.neutral-tier:${tier}`,
        ruleId: 'timing.neutral-tier',
        category: 'timing',
        priority: 'info',
        confidence: 0.8,
        short: `Нейтралки ${tier}-го уровня`,
        normal: `С ${mmss(at)} доступны нейтральные предметы ${tier}-го уровня — обновите свой.`,
        facts: [kbFact('neutral-tier', `Нейтральные ${tier}-го уровня с`, mmss(at), false)],
        ttlSec: 10,
        cooldownSec: 0,
        zone: 'timing',
      }),
    );
  }
  return out;
};

/** Наш Аегис скоро пропадёт: за 30 с */
export const aegisRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const at = c.mem.aegisAt;
  // Срок аегиса — по режиму (обычно 5 мин, Турбо — 4); не проверен — молчим
  const aegis = c.look.aegisSec();
  if (!c.v.inGame || clock === null || at === null || c.mem.aegisOurs !== true || aegis === null) return null;
  const left = at + aegis - clock;
  if (left > 30 || left < 5 || c.mem.once.has(`aegis-end@${at}`)) return null;
  c.mem.once.add(`aegis-end@${at}`);
  return draft({
    id: 'timing.aegis-end',
    category: 'timing',
    priority: 'advice',
    confidence: 0.85,
    short: `Аегис пропадёт через ${Math.round(left)} с`,
    normal: `Аегис взят в ${mmss(at)} и пропадёт в ${mmss(at + aegis)}. Используйте его: давите сейчас.`,
    facts: [{ key: 'aegis', label: 'Аегис взят в', value: mmss(at), source: 'gsi', ageSec: null, confidence: 1, verified: true }],
    ttlSec: 10,
    cooldownSec: 0,
    zone: 'timing',
  });
};

export const TIMING_RULES: Rule[] = [aegisRule, neutralTierRule, lotusRule, stackRule];
