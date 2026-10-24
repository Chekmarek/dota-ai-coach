// Прогресс игрока (src/core/progress): опыт только за улучшение, звания, серия со щитом, достижения,
// статистика доверия только при достаточном числе случаев, тренды ошибок.
import { describe, expect, it } from 'vitest';
import {
  ACHIEVEMENTS,
  FOCUS_XP,
  HINT_MAX,
  HINT_XP,
  IMPROVE_XP,
  TRUST_MIN_SAMPLES,
  addMatch,
  emptyProgress,
  levelOf,
  matchXp,
  mistakeTrends,
  progressView,
  streakOf,
  trustStats,
  xpToNext,
  type MatchHintOutcome,
  type MatchRecord,
} from '../../src/core/progress/index.ts';

let seq = 0;
const rec = (p: Partial<MatchRecord> = {}): MatchRecord => {
  seq++;
  return { key: `m${String(seq).padStart(4, '0')}`, startedAt: `2026-10-${String(1 + (seq % 28)).padStart(2, '0')}T${String(seq % 24).padStart(2, '0')}:00:00.000Z`, turbo: false, focus: null, metrics: {}, mistakes: {}, outcomes: [], ...p };
};
/** Записи по времени: startedAt по порядку */
const series = (ps: Partial<MatchRecord>[]): MatchRecord[] => ps.map((p, i) => ({ ...rec(p), startedAt: new Date(Date.UTC(2026, 9, 1, i)).toISOString() }));
const hit = (achieved: boolean | null): Partial<MatchRecord> => ({ focus: { id: 'deaths-early', achieved } });
const out = (short: string, result: MatchHintOutcome['result'], survived: boolean | null): MatchHintOutcome => ({ type: 'danger.model', short, result, survived });

describe('опыт: только за улучшение', () => {
  it('просто сыгранный матч без фокуса, советов и улучшений — 0 опыта', () => {
    const rs = series([{ mistakes: { idle: 2 } }]);
    expect(matchXp(rs, 0)).toEqual({ key: rs[0]!.key, items: [], total: 0 });
  });
  it('пустое состояние (приложение открыли, матчей нет) — 0 опыта и первое звание', () => {
    const v = progressView(emptyProgress());
    expect(v.level).toMatchObject({ level: 1, total: 0, name: 'Рекрут ★' });
    expect(v.matches).toBe(0);
  });
  it('фокус выполнен — FOCUS_XP; не выполнен или не измерен — ничего', () => {
    expect(matchXp(series([hit(true)]), 0).total).toBe(FOCUS_XP);
    expect(matchXp(series([hit(false)]), 0).total).toBe(0);
    expect(matchXp(series([hit(null)]), 0).total).toBe(0);
  });
  it('серия: бонус со второго подряд, не больше 50', () => {
    const rs = series([hit(true), hit(true), hit(true), hit(true), hit(true), hit(true), hit(true)]);
    expect(matchXp(rs, 1).items.find((i) => i.reason === 'streak')?.xp).toBe(20);
    expect(matchXp(rs, 6).items.find((i) => i.reason === 'streak')?.xp).toBe(50);
    expect(matchXp(rs, 0).items.some((i) => i.reason === 'streak')).toBe(false);
  });
  it('выполненные советы — по HINT_XP, не больше HINT_MAX за матч; проигнорированные — ничего', () => {
    const many = Array.from({ length: 9 }, () => out('Купи TP', 'acted', null));
    expect(matchXp(series([{ outcomes: many }]), 0).total).toBe(HINT_XP * HINT_MAX);
    expect(matchXp(series([{ outcomes: [out('Отходи', 'ignored', true), out('Купи TP', 'unclear', null)] }]), 0).total).toBe(0);
  });
  it('ошибка стала реже (5 матчей против 5 прошлых) — IMPROVE_XP, но не чаще раза в 5 матчей', () => {
    const rs = series([...Array.from({ length: 5 }, () => ({ mistakes: { idle: 3 } })), ...Array.from({ length: 7 }, () => ({ mistakes: { idle: 1 } }))]);
    const awards = rs.map((_, i) => matchXp(rs, i));
    // считаем по очереди, как в жизни: каждое следующее видит выданное раньше
    const acc: ReturnType<typeof matchXp>[] = [];
    for (let i = 0; i < rs.length; i++) acc.push(matchXp(rs, i, acc));
    const improvedAt = acc.map((a, i) => (a.items.some((x) => x.reason === 'improved') ? i : -1)).filter((i) => i >= 0);
    expect(improvedAt[0]).toBe(9); // первый раз, когда оба окна по 5 матчей полные
    expect(improvedAt.every((i, k) => k === 0 || i - improvedAt[k - 1]! >= 5)).toBe(true);
    expect(acc[9]!.items.find((x) => x.reason === 'improved')).toMatchObject({ xp: IMPROVE_XP, label: 'Реже: Простой (3 → 1 за матч)' });
    expect(awards[4]!.total).toBe(0);
  });
  it('редкая ошибка (меньше раза в матч) улучшением не считается', () => {
    const rs = series([...Array.from({ length: 5 }, (_, i) => ({ mistakes: i === 0 ? { idle: 2 } : {} })), ...Array.from({ length: 5 }, () => ({}))]);
    expect(matchXp(rs, 9).items.some((x) => x.reason === 'improved')).toBe(false);
  });
});

describe('звания', () => {
  it('опыт → уровень и звание как в Доте; до следующего — 100, 150, 200 …', () => {
    expect(xpToNext(1)).toBe(100);
    expect(levelOf(99)).toMatchObject({ level: 1, into: 99, need: 100 });
    expect(levelOf(100)).toMatchObject({ level: 2, name: 'Рекрут ★★', into: 0, need: 150 });
    expect(levelOf(250).level).toBe(3);
    expect(levelOf(1e9)).toMatchObject({ name: 'Титан', need: null });
  });
});

describe('серия со щитом', () => {
  it('один промах при готовом щите серию не обрывает; второй подряд — обрывает', () => {
    expect(streakOf(series([hit(true), hit(true), hit(false), hit(true)])).current).toBe(3);
    expect(streakOf(series([hit(true), hit(true), hit(false), hit(false)])).current).toBe(0);
  });
  it('щит — не чаще раза в 5 матчей с фокусом; матчи без фокуса не считаются', () => {
    const s = streakOf(series([hit(true), hit(false), hit(true), {}, hit(true)]));
    // щит потрачен на 2-м матче с фокусом — снова готов на 7-м: сейчас их 4, ждать ещё 2
    expect(s).toMatchObject({ current: 3, shieldReady: false, shieldIn: 2 });
    expect(streakOf(series([hit(true), hit(false), hit(true), hit(true), hit(true), hit(true), hit(false)])).current).toBe(5);
    expect(streakOf(series([hit(true), hit(false), hit(true), hit(false)])).current).toBe(0);
  });
});

describe('достижения', () => {
  const a = (id: string) => ACHIEVEMENTS.find((x) => x.id === id)!;
  it('«Осторожный»: 5 матчей подряд меньше 3 смертей до 10 мин (матчи без данных пропускаются)', () => {
    const ok = series([2, 1, 0, 2, 1].map((d) => ({ metrics: { 'deaths-early': d } })));
    expect(a('careful-5').check(ok)).toBe(true);
    expect(a('careful-5').check(series([2, 1, 3, 2, 1].map((d) => ({ metrics: { 'deaths-early': d } }))))).toBe(false);
    expect(a('careful-5').check(series([...[2, 1].map((d) => ({ metrics: { 'deaths-early': d } })), {}, ...[0, 2, 1].map((d) => ({ metrics: { 'deaths-early': d } }))]))).toBe(true);
  });
  it('«Вовремя ушёл»: 10 раз отошли по совету и выжили', () => {
    const outs = (n: number) => Array.from({ length: n }, () => out('Отходи', 'acted', true));
    expect(a('retreat-10').check(series([{ outcomes: outs(9) }]))).toBe(false);
    expect(a('retreat-10').check(series([{ outcomes: outs(6) }, { outcomes: outs(4) }]))).toBe(true);
  });
  it('получено один раз — второй раз не выдаётся; тот же матч дважды не считается', () => {
    let st = emptyProgress();
    let earned: string[] = [];
    for (const r of series(Array.from({ length: 7 }, () => hit(true)))) {
      const x = addMatch(st, r, r.startedAt)!;
      st = x.state;
      earned = earned.concat(x.award.achievements.map((y) => y.id));
      expect(addMatch(st, r, r.startedAt)).toBeNull();
    }
    expect(earned.filter((x) => x === 'focus-3')).toEqual(['focus-3']);
    expect(progressView(st).level.total).toBe(st.awards.reduce((s, x) => s + x.total, 0));
  });
});

describe('честная статистика', () => {
  it('доверие: мало случаев в любой группе — процентов нет', () => {
    const few = series([{ outcomes: [...Array(TRUST_MIN_SAMPLES).fill(out('Отходи', 'acted', true)), ...Array(TRUST_MIN_SAMPLES - 1).fill(out('Отходи', 'ignored', false))] }]);
    const t = trustStats(few)[0]!;
    expect(t).toMatchObject({ enough: false, followedPct: null, ignoredPct: null, followed: { n: TRUST_MIN_SAMPLES }, ignored: { n: TRUST_MIN_SAMPLES - 1 } });
  });
  it('доверие: хватает — проценты ровно из случаев', () => {
    const outs = [...Array(8).fill(out('Отходи', 'acted', true)), ...Array(2).fill(out('Отходи', 'acted', false)), ...Array(4).fill(out('Отходи', 'ignored', true)), ...Array(4).fill(out('Отходи', 'ignored', false))];
    expect(trustStats(series([{ outcomes: outs }]))[0]).toMatchObject({ enough: true, followedPct: 80, ignoredPct: 50 });
  });
  it('советы без проверки «выжил» и «не проверить» в статистику не идут', () => {
    expect(trustStats(series([{ outcomes: [out('Купи TP', 'acted', null), out('Отходи', 'unclear', true)] }]))).toEqual([]);
  });
  it('тренды: три самые частые ошибки и направление', () => {
    const rs = series([{ mistakes: { idle: 3, 'no-tp': 1 } }, { mistakes: { idle: 3 } }, { mistakes: { idle: 1, 'poor-cs': 2 } }, { mistakes: { idle: 0, 'poor-cs': 2 } }]);
    const t = mistakeTrends(rs);
    expect(t.map((x) => x.type)).toEqual(['idle', 'poor-cs', 'no-tp']);
    expect(t[0]).toMatchObject({ perMatch: [3, 3, 1, 0], before: 3, after: 0.5, direction: 'down' });
    expect(t[1]!.direction).toBe('up');
    expect(mistakeTrends(series([{ mistakes: { idle: 1 } }]))).toEqual([]);
  });
});
