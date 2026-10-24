// Фильтр внимания (src/core/gate): бюджет, тишина в драке, очередь до спокойного момента, повторы, «не нужно»,
// низкая уверенность → разбор, «уже сделано», короткая подача без выдуманных фактов, метрики.
import { describe, expect, it } from 'vitest';
import { AttentionGate, deriveReason, deriveShort, shortWordCount, toGateHint, type GateSignals } from '../../src/core/gate/index.ts';
import { draft, type DraftInput } from '../../src/core/coach/rules/context.ts';
import { usefulAiText } from '../../src/core/coach/hud.ts';
import type { HintDraft } from '../../src/core/coach/types.ts';

const sig = (nowMs: number, p: Partial<GateSignals> = {}): GateSignals => ({
  nowMs,
  matchId: 'm1',
  inGame: true,
  paused: false,
  preGame: false,
  alive: true,
  hpPct: 100,
  disabled: false,
  abilityCooldowns: [0, 0, 0, 0],
  enemiesNear: 0,
  enemiesClose: 0,
  visionFight: false,
  atBase: false,
  distToBase: 6000,
  distToRune: 5000,
  items: [],
  ...p,
});

const mk = (p: Partial<DraftInput> & { id: string }): HintDraft =>
  draft({ category: 'economy', priority: 'advice', confidence: 0.8, short: p.id, normal: `${p.id}: подробно`, facts: [], ttlSec: 10, cooldownSec: 20, ...p });

const tp = mk({ id: 'economy.tp', short: 'Нет Town Portal Scroll — купите', icon: 'item:tpscroll' });
const wards = mk({ id: 'economy.wards', short: 'Нет Observer Ward — купите обзор', icon: 'item:ward_observer' });
const retreat = mk({ id: 'danger.model', category: 'danger', priority: 'critical', short: 'Высокий риск смерти — отходите', facts: [{ key: 'risk', label: 'Риск смерти, %', value: 71, source: 'derived', ageSec: 0, confidence: 0.8, verified: true }], ttlSec: 6, cooldownSec: 8 });

/** Тики раз в секунду с from до to (мс), на каждом — эти подсказки и сигналы */
function run(g: AttentionGate, from: number, to: number, offered: (t: number) => HintDraft[], s: (t: number) => Partial<GateSignals> = () => ({})) {
  const shown: { t: number; key: string; type: string }[] = [];
  for (let t = from; t <= to; t += 1000) {
    const r = g.tick({ signals: sig(t, s(t)), offered: offered(t) });
    for (const v of r.shown) shown.push({ t, key: v.hint.key, type: v.hint.type });
  }
  return shown;
}

describe('фильтр внимания: бюджет', () => {
  it('несрочная — не чаще одной за бюджет; вторая ждёт и выходит, когда бюджет открылся', () => {
    const g = new AttentionGate({ budgetMs: 50_000 });
    const shown = run(g, 0, 70_000, () => [tp, wards]);
    expect(shown.map((x) => x.type)).toEqual(['economy.tp', 'economy.wards']);
    expect(shown[1]!.t - shown[0]!.t).toBeGreaterThanOrEqual(50_000);
  });

  it('срочная проходит мимо бюджета, но со своим кулдауном на тип', () => {
    const g = new AttentionGate({ budgetMs: 50_000, criticalCooldownMs: 10_000 });
    run(g, 0, 0, () => [tp]);
    // срочная пришла сразу после несрочной — показана
    const first = run(g, 1000, 1000, () => [retreat]);
    expect(first.map((x) => x.type)).toEqual(['danger.model']);
    // ситуация прошла (карточка ушла к 7 с) и вернулась на 10-й с — ещё кулдаун (показ был на 1-й с), на 11-й — снова
    const later = run(g, 5000, 20_000, (t) => (t >= 10_000 ? [retreat] : []));
    expect(later.map((x) => x.t)).toEqual([11_000]);
  });
});

describe('фильтр внимания: драка', () => {
  const hpFall = (t: number) => ({ hpPct: t >= 10_000 && t <= 14_000 ? 100 - (t - 10_000) / 200 : 70, enemiesClose: t >= 10_000 && t <= 14_000 ? 2 : 0 });

  it('в драке — только срочное: несрочная ждёт и выходит в спокойный момент', () => {
    const g = new AttentionGate();
    const shown = run(g, 10_000, 40_000, (t) => [...(t >= 11_000 ? [tp] : []), ...(t >= 12_000 && t <= 13_000 ? [retreat] : [])], hpFall);
    expect(shown[0]).toMatchObject({ type: 'danger.model', t: 12_000 });
    const tpAt = shown.find((x) => x.type === 'economy.tp')!.t;
    // драка держится 5 с после последнего признака (14 с), спокойно — ещё через 6 с затишья
    expect(tpAt).toBeGreaterThanOrEqual(20_000);
  });

  it('несрочная на экране уходит, когда началась драка', () => {
    const g = new AttentionGate();
    run(g, 0, 2000, () => [tp]);
    expect(g.visible().map((v) => v.hint.type)).toEqual(['economy.tp']);
    g.tick({ signals: sig(3000, { hpPct: 100 }), offered: [tp] });
    g.tick({ signals: sig(4000, { hpPct: 80, enemiesClose: 1 }), offered: [tp] });
    expect(g.visible()).toEqual([]);
  });

  it('разовое событие, прождавшее всю драку, выбрасывается с причиной «драка»', () => {
    const g = new AttentionGate();
    const rune = mk({ id: 'timing.rune-power', category: 'timing', priority: 'info', short: 'Руна силы через 15 с', ttlSec: 8, cooldownSec: 0 });
    const shown = run(g, 0, 20_000, (t) => (t === 1000 ? [rune] : []), (t) => ({ hpPct: 100 - t / 400, enemiesClose: 1 }));
    expect(shown).toEqual([]);
    expect(g.debug().suppressed.fight).toBe(1);
  });

  it('драка по GSI без зрения: здоровье резко падает', () => {
    const g = new AttentionGate();
    g.tick({ signals: sig(0, { hpPct: 100, enemiesNear: null, enemiesClose: null, visionFight: null }), offered: [] });
    g.tick({ signals: sig(1000, { hpPct: 88, enemiesNear: null, enemiesClose: null, visionFight: null }), offered: [] });
    expect(g.moment.fight).toBe(true);
  });

  it('враг на линии рядом без урона — не драка, но и не «тихо»: несрочное ждёт', () => {
    const g = new AttentionGate();
    run(g, 0, 10_000, () => [tp], () => ({ enemiesClose: 1, enemiesNear: 1 }));
    expect(g.moment.fight).toBe(false);
    expect(g.moment.calm).toBe(null);
    expect(g.visible()).toEqual([]);
  });
});

describe('фильтр внимания: повторы, очевидное, уверенность', () => {
  it('ситуативная подсказка, которую правило шлёт каждый тик, — одна показанная и одна полученная', () => {
    const g = new AttentionGate();
    const shown = run(g, 0, 30_000, () => [tp]);
    expect(shown).toHaveLength(1);
    expect(g.debug().received).toBe(1);
  });

  it('предмет уже куплен — не показываем', () => {
    const g = new AttentionGate();
    const bkb = mk({ id: 'economy.next:black_king_bar', ruleId: 'economy.next', short: 'Дальше: Black King Bar', icon: 'item:black_king_bar' });
    const shown = run(g, 0, 5000, () => [bkb], () => ({ items: ['black_king_bar'] }));
    expect(shown).toEqual([]);
    expect(g.debug().suppressed['already-done']).toBe(1);
  });

  it('низкая уверенность — не в игре, а в разбор матча', () => {
    const g = new AttentionGate({ minConfidence: 0.6 });
    const weak = mk({ id: 'economy.gpm', short: 'GPM 300 — ниже обычного 420', confidence: 0.5 });
    const shown = run(g, 0, 60_000, () => [weak]);
    expect(shown).toEqual([]);
    expect(g.deferredForReview()).toEqual([{ type: 'economy.gpm', short: 'Фарми больше', count: 1 }]);
  });

  it('та же фраза недавно — второй раз не показываем', () => {
    const g = new AttentionGate({ budgetMs: 20_000, defaultTypeCooldownMs: 0, repeatTextMs: 180_000 });
    // ситуация «нет TP» прошла и вернулась — фраза та же
    const shown = run(g, 0, 60_000, (t) => (t < 5000 || t > 30_000 ? [tp] : []));
    expect(shown).toHaveLength(1);
  });
});

describe('фильтр внимания: фокус матча', () => {
  it('подсказка фокуса: info → useful, первой в очереди и с вдвое мягким бюджетом', () => {
    const info = mk({ id: 'economy.wards', priority: 'info', short: 'Нет Observer Ward — купите обзор' });
    expect(toGateHint(info, { nowMs: 0, focus: true })).toMatchObject({ priority: 'useful', focus: true });
    // обе пришли сразу — первой фокус
    const g = new AttentionGate({ budgetMs: 50_000, focusTypes: ['economy.wards'] });
    expect(run(g, 0, 1000, () => [tp, info])[0]!.type).toBe('economy.wards');
    // несрочная показана; подсказка фокуса проходит через половину бюджета (25 с), обычная ждала бы 50 с
    const g2 = new AttentionGate({ budgetMs: 50_000, focusTypes: ['economy.wards'] });
    const shown = run(g2, 0, 40_000, (t) => (t === 0 ? [tp] : [tp, info]));
    expect(shown.map((x) => x.type)).toEqual(['economy.tp', 'economy.wards']);
    expect(shown[1]!.t).toBeGreaterThanOrEqual(25_000);
    expect(shown[1]!.t).toBeLessThan(50_000);
  });
});

describe('фильтр внимания: «не нужно»', () => {
  it('тип молчит до конца матча; три матча — понижен до info', () => {
    const g = new AttentionGate();
    for (const [i, m] of ['a', 'b', 'c'].entries()) {
      const t0 = i * 1_000_000;
      g.tick({ signals: sig(t0, { matchId: m }), offered: [tp] });
      expect(g.visible()).toHaveLength(1);
      const r = g.mute(t0 + 1000)!;
      expect(r.type).toBe('economy.tp');
      expect(g.visible()).toEqual([]);
      // в этом матче — больше нет
      const again = run(g, t0 + 2000, t0 + 120_000, (t) => (t > t0 + 10_000 ? [tp] : []), () => ({ matchId: m }));
      expect(again).toEqual([]);
      expect(r.demoted).toBe(i === 2);
    }
    expect(g.isDemoted('economy.tp')).toBe(true);
    // хранимое переживает новый фильтр (новый запуск коуча)
    const g2 = new AttentionGate({}, g.memory);
    g2.tick({ signals: sig(5_000_000, { matchId: 'd' }), offered: [tp] });
    expect(g2.visible()[0]!.hint.priority).toBe('info');
    expect(g.memory.metrics['economy.tp']!.muted).toBe(3);
  });

  it('нечего отключать — null', () => {
    expect(new AttentionGate().mute(0)).toBeNull();
  });
});

describe('фильтр внимания: метрики', () => {
  it('«Отходи» выполнено — герой стал ближе к базе; не выполнено — умер', () => {
    const g = new AttentionGate();
    run(g, 0, 8000, (t) => (t < 3000 ? [retreat] : []), (t) => ({ distToBase: 6000 - t / 8 }));
    expect(g.memory.metrics['danger.model']).toMatchObject({ shown: 1, acted: 1 });
    const g2 = new AttentionGate();
    run(g2, 0, 4000, (t) => (t < 2000 ? [retreat] : []), (t) => ({ alive: t < 3000 }));
    expect(g2.memory.metrics['danger.model']).toMatchObject({ shown: 1, ignored: 1 });
  });

  it('совет купить — выполнен, когда предмет появился', () => {
    const g = new AttentionGate();
    run(g, 0, 20_000, (t) => (t < 5000 ? [tp] : []), (t) => ({ items: t > 10_000 ? ['tpscroll'] : [] }));
    expect(g.memory.metrics['economy.tp']).toMatchObject({ shown: 1, acted: 1 });
  });
});

describe('фильтр внимания: короткая подача', () => {
  it('короткая фраза — не больше 3 слов (название — одно слово)', () => {
    const names = { item: (k: string) => (k === 'black_king_bar' ? 'Black King Bar' : null), hero: (k: string) => (k === 'keeper_of_the_light' ? 'Keeper of the Light' : null) };
    const cases: HintDraft[] = [
      mk({ id: 'economy.next:black_king_bar', ruleId: 'economy.next', short: 'Дальше: Black King Bar', icon: 'item:black_king_bar' }),
      mk({ id: 'fight.target:keeper_of_the_light', ruleId: 'fight.target', category: 'fight', short: 'Фокус: Keeper of the Light, 30% здоровья', icon: 'hero:keeper_of_the_light' }),
      mk({ id: 'fight.engage', category: 'fight', short: 'Не вступать: шанс 34% · 1 на 2' }),
      mk({ id: 'unknown.rule', short: 'Какая-то очень длинная фраза без двоеточия' }),
      retreat,
    ];
    for (const d of cases) {
      const { short, name } = deriveShort(d, names);
      expect(shortWordCount(short, name ? [name] : [])).toBeLessThanOrEqual(3);
    }
    expect(deriveShort(cases[2]!).short).toBe('Не вступай');
  });

  it('причина — один факт с числом из самой подсказки, иначе null', () => {
    expect(deriveReason(mk({ id: 'fight.engage', short: 'Не вступать: шанс 34% · 1 на 2 (+1 рядом)' }), 'Не вступай')).toBe('шанс 34%');
    expect(deriveReason(mk({ id: 'timing.rune-water', short: 'Руна воды через 15 с, бежать 20 с' }), 'К руне воды')).toBe('Руна воды через 15 с');
    expect(deriveReason(retreat, 'Отходи')).toBe('Риск смерти 71%');
    expect(deriveReason(mk({ id: 'economy.sell', short: 'Лишнее: Tango — продайте' }), 'Продай лишнее')).toBeNull();
  });

  it('голос — только у срочных и не длиннее 5 слов', () => {
    const h = toGateHint(retreat, { nowMs: 0 });
    expect(h.voice).toBe('Отходи');
    expect(toGateHint(tp, { nowMs: 0 }).voice).toBeNull();
    expect(toGateHint(retreat, { nowMs: 0, demoted: true }).voice).toBeNull();
  });

  it('генератор может задать подачу сам', () => {
    const d = mk({ id: 'macro.help', short: 'Бой: верхняя линия — помогите' });
    d.gate = { short: 'Помоги топу', reason: '3 союзника дерутся' };
    const h = toGateHint(d, { nowMs: 0 });
    expect([h.short, h.reason]).toEqual(['Помоги топу', '3 союзника дерутся']);
  });
});

describe('разбор смерти: текст ИИ — только полезное', () => {
  it('пересказ фактов выбрасывается, совет остаётся', () => {
    expect(usefulAiText('— Смерть произошла в 2:07.  \n— Врагов рядом при смерти: 0.', [])).toBeNull();
    expect(usefulAiText('Смерть в 4:18. Ставьте вард у руны перед тем, как идти в лес.', ['Нажимайте спасительные предметы в начале драки.'])).toBe('Ставьте вард у руны перед тем, как идти в лес.');
    // то же, что совет шаблона, — не повторяем
    expect(usefulAiText('Нажимайте спасительные предметы в начале драки.', ['Нажимайте спасительные предметы и способности в начале драки, а не когда здоровья почти не осталось.'])).toBeNull();
  });
});
