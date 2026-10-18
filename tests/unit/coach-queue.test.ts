// Очередь подсказок: лимит на зону, вытеснение важным, кулдауны, слияние повторов, TTL, тишина в драке, лимит в минуту.
import { describe, expect, it } from 'vitest';
import { HintQueue } from '../../src/core/coach/queue.ts';
import { defaultCoachSettings, type HintDraft } from '../../src/core/coach/types.ts';

const S = defaultCoachSettings();
const d = (over: Partial<HintDraft> = {}): HintDraft => ({
  id: 'x',
  ruleId: 'x',
  category: 'economy',
  priority: 'advice',
  confidence: 0.9,
  short: 'Тест',
  detail: { normal: 'Тест.', detailed: 'Тест подробно.' },
  facts: [],
  ttlMs: 8000,
  cooldownMs: 30_000,
  ...over,
});
const ctx = (now: number, inFight = false) => ({ now, clock: 600, inFight, settings: S });

describe('HintQueue', () => {
  it('не больше N подсказок в зоне; критичная вытесняет неважную', () => {
    const q = new HintQueue();
    q.push(d({ id: 'a', category: 'danger', priority: 'advice' }), ctx(0));
    expect(q.visible('alert')).toHaveLength(1);
    const r = q.push(d({ id: 'b', category: 'danger', priority: 'advice' }), ctx(10_000));
    expect(r.status).toBe('dropped');
    expect(r.reason).toBe('zone-full');
    const c = q.push(d({ id: 'c', category: 'danger', priority: 'critical' }), ctx(10_000));
    expect(c.status).toBe('shown');
    expect(c.evicted.map((h) => h.id)).toEqual(['a']);
    expect(q.visible('alert').map((h) => h.id)).toEqual(['c']);
  });

  it('кулдаун подсказки: та же подсказка после ухода с экрана не возвращается раньше срока', () => {
    const q = new HintQueue();
    expect(q.push(d(), ctx(0)).status).toBe('shown');
    q.tick(9000);
    expect(q.push(d(), ctx(9000)).reason).toBe('cooldown');
    expect(q.push(d(), ctx(31_000)).status).toBe('shown');
  });

  it('повтор на экране сливается: тот же номер показа, срок продлён', () => {
    const q = new HintQueue();
    const a = q.push(d(), ctx(0)).hint!;
    const b = q.push(d({ short: 'Новый текст' }), ctx(5000));
    expect(b.status).toBe('merged');
    expect(b.hint!.seq).toBe(a.seq);
    expect(b.hint!.short).toBe('Новый текст');
    expect(q.visible()).toHaveLength(1);
    expect(q.tick(9000)).toHaveLength(0);
    expect(q.tick(13_001)).toHaveLength(1);
  });

  it('TTL: подсказка уходит сама', () => {
    const q = new HintQueue();
    q.push(d({ ttlMs: 5000 }), ctx(0));
    expect(q.tick(4999)).toHaveLength(0);
    expect(q.tick(5000)).toHaveLength(1);
    expect(q.visible()).toHaveLength(0);
  });

  it('в драке неважное молчит, критичное и подсказки драки — проходят', () => {
    const q = new HintQueue();
    expect(q.push(d({ id: 'e', category: 'economy' }), ctx(0, true)).reason).toBe('in-fight');
    expect(q.push(d({ id: 'f', category: 'fight' }), ctx(0, true)).status).toBe('shown');
    // в драке — одна новая подсказка раз в 4 с, даже критичная (этап 5: драку не заваливаем текстом)
    expect(q.push(d({ id: 'g', category: 'macro', priority: 'critical' }), ctx(0, true)).reason).toBe('in-fight');
    expect(q.push(d({ id: 'g', category: 'macro', priority: 'critical' }), ctx(4000, true)).status).toBe('shown');
  });

  it('промежуток категории: две подсказки экономики подряд не показываются', () => {
    const q = new HintQueue();
    q.push(d({ id: 'a' }), ctx(0));
    expect(q.push(d({ id: 'b' }), ctx(1000)).reason).toBe('category-gap');
  });

  it('общий лимит в минуту для некритичных; критичные не считаются', () => {
    const q = new HintQueue();
    let shown = 0;
    for (let i = 0; i < 30; i++) {
      const r = q.push(d({ id: `h${i}`, category: (['fight', 'danger', 'timing', 'macro'] as const)[i % 4], ttlMs: 1000 }), ctx(i * 1500));
      q.tick(i * 1500 + 1000);
      if (r.status === 'shown') shown++;
    }
    expect(shown).toBeLessThanOrEqual(q.config.maxPerMinute);
    expect(q.push(d({ id: 'crit', category: 'danger', priority: 'critical' }), ctx(45_000)).status).toBe('shown');
  });

  it('низкая уверенность, неуверенный процент и выключенная категория — не показываются', () => {
    const q = new HintQueue();
    expect(q.push(d({ confidence: 0.2 }), ctx(0)).reason).toBe('low-confidence');
    const pct = { label: 'x', estimate: { value: 70, confidence: 0.3, factors: [], showable: false } };
    expect(q.push(d({ id: 'p', category: 'fight', percent: pct }), ctx(0)).reason).toBe('percent-uncertain');
    const off = { ...S, categories: { ...S.categories, economy: false } };
    expect(q.push(d({ id: 'z' }), { now: 0, clock: 0, inFight: false, settings: off }).reason).toBe('disabled');
  });

  it('текст ИИ не затирается шаблоном при повторе', () => {
    const q = new HintQueue();
    const h = q.push(d(), ctx(0)).hint!;
    q.updateText(h.seq, { detail: { normal: 'Текст ИИ', detailed: 'Текст ИИ подробно' }, textSource: 'ai' });
    q.push(d(), ctx(2000));
    expect(q.visible()[0]!.detail.normal).toBe('Текст ИИ');
  });

  it('устаревшая: ситуативная подсказка уходит, когда правило перестало её подтверждать, не дожидаясь TTL', () => {
    const q = new HintQueue();
    const danger = d({ id: 'enemies-missing', category: 'danger', priority: 'critical', ttlMs: 10_000 });
    q.push(danger, ctx(0));
    q.push(danger, ctx(500)); // правило подтвердило на следующем снимке
    expect(q.expireStale(2000)).toEqual([]); // пропуск пары снимков — ещё не повод
    const gone = q.expireStale(3000);
    expect(gone.map((h) => h.id)).toEqual(['enemies-missing']);
    expect(q.visible()).toEqual([]);
  });

  it('устаревшая: пока правило подтверждает — подсказка остаётся; разовая по событию и тайминг — только по сроку', () => {
    const q = new HintQueue();
    const fight = d({ id: 'fight', category: 'fight', ttlMs: 10_000 });
    q.push(fight, ctx(0));
    for (let t = 500; t <= 6000; t += 500) q.push(fight, ctx(t));
    expect(q.expireStale(7000)).toEqual([]);
    // смок: одно событие — один показ
    const smoke = d({ id: 'smoke', category: 'danger', priority: 'critical', ttlMs: 8000 });
    q.push(smoke, ctx(7000));
    expect(q.expireStale(12_000).map((h) => h.id)).toEqual(['fight']);
    expect(q.visible().map((h) => h.id)).toEqual(['smoke']);
    // тайминг (не ситуативная категория) подтверждался и замолчал — всё равно живёт до срока
    const q2 = new HintQueue();
    const rune = d({ id: 'rune', category: 'timing', ttlMs: 15_000 });
    q2.push(rune, ctx(0));
    q2.push(rune, ctx(500));
    expect(q2.expireStale(10_000)).toEqual([]);
  });
});
