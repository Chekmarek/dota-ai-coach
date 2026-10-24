// Фокус матча (src/core/focus): критерии успеха каждого фокуса, цели от среднего, выбор по истории, переключение.
import { describe, expect, it } from 'vitest';
import { FOCUS_DEFS, FocusSession, FocusTracker, STARTER_FOCUS_IDS, focusAverage, focusById, focusTitle, rankFocuses, resolveTarget, type FocusSample } from '../../src/core/focus/index.ts';

const def = (id: string) => focusById(id)!;
const base: FocusSample = { clock: 0, inGame: true, paused: false, alive: true, deaths: 0, lastHits: 0, gold: 600, hasTp: true, commands: 0, atBase: false };

/** Снимки раз в секунду с from по to (с игровых часов), поля — от времени */
function play(t: FocusTracker, from: number, to: number, f: (c: number) => Partial<FocusSample> = () => ({})) {
  let p = t.progress();
  for (let c = from; c <= to; c++) p = t.feed({ ...base, clock: c, commands: c, ...f(c) });
  return p;
}

describe('фокус: меньше смертей до 10 мин', () => {
  it('одна смерть до 10:00 — получилось, как только окно прошло', () => {
    const t = new FocusTracker(def('deaths-early'), 1, false);
    expect(play(t, 0, 599, (c) => ({ deaths: c >= 300 ? 1 : 0 })).state).toBe('pending');
    const p = play(t, 600, 601, () => ({ deaths: 1 }));
    expect(p).toMatchObject({ value: 1, state: 'achieved', text: '1/1' });
  });
  it('вторая смерть до 10:00 — сразу «не получилось»; смерти после 10:00 не считаются', () => {
    const t = new FocusTracker(def('deaths-early'), 1, false);
    expect(play(t, 0, 400, (c) => ({ deaths: c >= 200 ? (c >= 350 ? 2 : 1) : 0 })).state).toBe('failed');
    const t2 = new FocusTracker(def('deaths-early'), 1, false);
    expect(play(t2, 0, 900, (c) => ({ deaths: c >= 700 ? 5 : 0 }))).toMatchObject({ value: 0, state: 'achieved' });
  });
  it('в Турбо окно — до 7:00, и в названии тоже', () => {
    const t = new FocusTracker(def('deaths-early'), 1, true);
    expect(play(t, 0, 421).state).toBe('achieved');
    expect(focusTitle(def('deaths-early'), true)).toBe('меньше смертей до 7 мин');
    expect(focusTitle(def('deaths-early'), false)).toBe('меньше смертей до 10 мин');
  });
  it('подключились после 10:00 — измерить нечем', () => {
    const t = new FocusTracker(def('deaths-early'), 1, false);
    expect(play(t, 700, 710).state).toBe('unknown');
  });
});

describe('фокус: добивания к 10:00', () => {
  it('цель — чуть выше вашего среднего, без истории — по позиции', () => {
    expect(resolveTarget(def('last-hits'), { avg: 40, position: 1 })).toBe(44);
    expect(resolveTarget(def('last-hits'), { avg: null, position: 3 })).toBe(35);
    expect(resolveTarget(def('last-hits'), { avg: null, position: null })).toBe(40);
    expect(resolveTarget(def('last-hits'), { avg: 5, position: 1 })).toBe(25);
  });
  it('решается в 10:00: добрали цель — получилось, нет — нет', () => {
    const ok = new FocusTracker(def('last-hits'), 44, false);
    expect(play(ok, 0, 601, (c) => ({ lastHits: Math.floor(c / 12) }))).toMatchObject({ value: 50, state: 'achieved', text: '50/44' });
    const miss = new FocusTracker(def('last-hits'), 44, false);
    expect(play(miss, 0, 601, (c) => ({ lastHits: Math.floor(c / 20) }))).toMatchObject({ value: 30, state: 'failed' });
  });
});

describe('фокус: всегда с TP', () => {
  it('доля времени с TP — после 3:00, только живым, без пауз и разрывов', () => {
    const t = new FocusTracker(def('tp-always'), 90, false);
    play(t, 0, 179, () => ({ hasTp: false })); // до 3:00 не считается
    play(t, 180, 279, () => ({ hasTp: true }));
    play(t, 280, 299, () => ({ hasTp: false }));
    play(t, 300, 400, () => ({ hasTp: false, alive: false })); // мёртвым не считается
    play(t, 401, 420, () => ({ hasTp: false, paused: true })); // пауза не считается
    const p = t.finish();
    expect(p.value).toBe(83); // 99 с из 119
    expect(p.state).toBe('failed');
    expect(p.text).toBe('83%');
  });
  it('разрыв в записи (шаг больше 5 с) не засчитывается', () => {
    const t = new FocusTracker(def('tp-always'), 90, false);
    play(t, 180, 200);
    t.feed({ ...base, clock: 500, hasTp: false });
    expect(t.finish()).toMatchObject({ value: 100, state: 'achieved' });
  });
});

describe('фокус: тратить золото вовремя', () => {
  it('порог в Турбо выше: 2500 золота — запас в обычной игре, но не в Турбо', () => {
    const normal = new FocusTracker(def('gold-spend'), 15, false);
    play(normal, 120, 220, () => ({ gold: 2500 }));
    expect(normal.finish()).toMatchObject({ value: 100, state: 'failed' });
    const turbo = new FocusTracker(def('gold-spend'), 15, true);
    play(turbo, 120, 220, () => ({ gold: 2500 }));
    expect(turbo.finish()).toMatchObject({ value: 0, state: 'achieved' });
  });
});

describe('фокус: без простоев', () => {
  it('простой — 15 с без приказов, один раз за эпизод; на базе и мёртвым не считается', () => {
    const t = new FocusTracker(def('no-idle'), 2, false);
    const idleAt = (from: number, len: number) => (c: number) => (c >= from && c < from + len ? { commands: from } : {});
    play(t, 0, 100, idleAt(10, 40)); // один долгий простой — 1 раз
    expect(t.progress().value).toBe(1);
    play(t, 101, 200, (c) => ({ ...idleAt(110, 30)(c), atBase: true })); // на базе — не простой
    expect(t.progress().value).toBe(1);
    play(t, 201, 400, (c) => ({ ...idleAt(210, 20)(c), ...idleAt(300, 20)(c) }));
    expect(t.progress()).toMatchObject({ value: 3, state: 'failed', text: '3/2' });
  });
});

describe('выбор фокуса', () => {
  it('без истории — стартовый набор по порядку', () => {
    expect(rankFocuses([], null).slice(0, 3).map((d) => d.id)).toEqual([...STARTER_FOCUS_IDS]);
  });
  it('частая ошибка в последних матчах — её фокус первым', () => {
    const h = [{ mistakes: ['poor-cs', 'poor-cs'] }, { mistakes: ['poor-cs', 'idle'] }, { mistakes: ['unspent-gold'] }];
    expect(rankFocuses(h, 1)[0]!.id).toBe('last-hits');
  });
  it('добивания саппорту не предлагаем', () => {
    const h = [{ mistakes: ['poor-cs', 'poor-cs', 'poor-cs'] }];
    expect(rankFocuses(h, 5).map((d) => d.id)).not.toContain('last-hits');
  });
  it('получалось два матча подряд — в конец списка', () => {
    const h = [
      { mistakes: ['died-unused'], focus: { id: 'deaths-early', achieved: true } },
      { mistakes: ['died-unused'], focus: { id: 'deaths-early', achieved: true } },
    ];
    const r = rankFocuses(h, null).map((d) => d.id);
    expect(r[r.length - 1]).toBe('deaths-early');
  });
  it('среднее — только того же режима и хотя бы за 2 матча', () => {
    const h = [
      { mistakes: [], metrics: { 'last-hits': 40 } },
      { mistakes: [], metrics: { 'last-hits': 50 } },
      { mistakes: [], metrics: { 'last-hits': 90 }, turbo: true },
    ];
    expect(focusAverage(h, 'last-hits', false)).toBe(45);
    expect(focusAverage(h, 'last-hits', true)).toBeNull();
  });
});

describe('сессия фокуса', () => {
  it('клавиша — следующий фокус; итог — выбранный фокус и метрики всех фокусов', () => {
    const s = new FocusSession({ matchId: '1', turbo: false, position: 1, history: [] });
    expect(s.current.def.id).toBe('deaths-early');
    expect(s.next().def.id).toBe('last-hits');
    for (let c = 0; c <= 700; c++) s.feed({ ...base, clock: c, commands: c, lastHits: Math.floor(c / 12) });
    const r = s.finish();
    expect(r.result).toMatchObject({ id: 'last-hits', title: 'добивания к 10:00', value: 50, target: 45, achieved: true, prevAvg: null });
    expect(Object.keys(r.metrics).sort()).toEqual(FOCUS_DEFS.map((d) => d.id).sort());
  });
  it('позиция стала известна: саппорту добивания не оставляем (если игрок не выбрал сам)', () => {
    const h = [{ mistakes: ['poor-cs', 'poor-cs'] }];
    const s = new FocusSession({ matchId: '1', turbo: false, position: null, history: h });
    expect(s.current.def.id).toBe('last-hits');
    expect(s.setPosition(5)).toBe(true);
    expect(s.current.def.id).not.toBe('last-hits');
  });
  it('у каждого фокуса — критерий, звук-подсказки и фраза после матча', () => {
    for (const d of FOCUS_DEFS) {
      expect(d.voice.split(/\s+/).length, d.id).toBeLessThanOrEqual(5);
      expect(d.hintTypes.length, d.id).toBeGreaterThan(0);
      expect(d.keep.achieved && d.keep.failed, d.id).toBeTruthy();
    }
  });
});
