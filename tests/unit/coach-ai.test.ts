// Слой ИИ движка подсказок: правила работают без модели и не ждут её; ответ модели проверяется,
// выдуманные числа и варианты вне списка отклоняются; при ошибке — пауза и шаблоны.
import { describe, expect, it } from 'vitest';
import { CoachEngine } from '../../src/core/coach/engine.ts';
import { CoachAi, parseAdvice, AI_BACKOFF_MS } from '../../src/core/coach/ai.ts';
import type { AiProvider, AiRequest } from '../../src/core/ai/provider.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const data = realData();
const T0 = 2_000_000;
const tick = () => new Promise((r) => setTimeout(r, 0));

/** Поставщик-заглушка: отвечает текстом, ждёт delayMs или бросает ошибку */
function fake(answer: (req: AiRequest) => string, opts: { delayMs?: number; fail?: boolean } = {}): AiProvider & { calls: AiRequest[] } {
  const calls: AiRequest[] = [];
  return {
    id: 'mock',
    calls,
    async *generate(req: AiRequest) {
      calls.push(req);
      if (opts.delayMs) {
        await new Promise<void>((resolve, reject) => {
          const t = setTimeout(resolve, opts.delayMs);
          req.signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new Error('aborted'));
          });
        });
      }
      if (opts.fail) throw new Error('server');
      yield answer(req);
    },
  };
}

const quiet = (t: number): Partial<SimInput> => ({ pos: { x: -4000 + t * 200, y: -4000 }, commands: t, enemies: [5, 6, 7, 8, 9].map((slot) => ({ slot, hero: 'axe', pos: { x: 6000, y: 6000 } })) });

async function drive(engine: CoachEngine, seconds: number, frame = quiet, startClock = 900) {
  const ups = [];
  for (let t = 0; t < seconds; t++) {
    const wallMs = T0 + t * 1000;
    const s = sim({ wallMs, clock: startClock + t, ...frame(t) });
    ups.push(engine.tick(s.state, s.gsi, wallMs));
    await tick();
  }
  return ups;
}

describe('совет ИИ «что делать и куда идти»', () => {
  it('ИИ выключен (нет поставщика) — правила работают, советов ИИ нет', async () => {
    const ai = new CoachAi({ provider: () => null, now: () => Date.now() });
    const e = new CoachEngine({ data, ai });
    const ups = await drive(e, 70);
    const all = ups.flatMap((u) => u.shown);
    expect(all.some((h) => h.id === 'ai.advice')).toBe(false);
    expect(all.length).toBeGreaterThan(0);
    expect(all.every((h) => h.textSource === 'template')).toBe(true);
  });

  it('модель отвечает верно — совет показан, текст от ИИ', async () => {
    const p = fake(() => '{"action":"farm","where":"radiant-jungle","say":"Фарми свой лес, враги далеко"}');
    const ai = new CoachAi({ provider: () => p, now: () => Date.now() });
    const e = new CoachEngine({ data, ai });
    const ups = await drive(e, 5);
    const h = ups.flatMap((u) => [...u.shown, ...u.changed]).find((x) => x.id === 'ai.advice');
    expect(p.calls.length).toBeGreaterThan(0);
    expect(h?.textSource).toBe('ai');
    expect(h?.short).toBe('Фармить: лес Сил Света');
    expect(h?.detail.normal).toBe('Фарми свой лес, враги далеко');
  });

  it('модель медленная — тик не ждёт её, по таймауту остаётся шаблон', async () => {
    const p = fake(() => '{"action":"farm","where":"radiant-jungle","say":"Фарми лес"}', { delayMs: 60_000 });
    const ai = new CoachAi({ provider: () => p, now: () => Date.now(), timeoutMs: { advice: 50, phrase: 50 } });
    const e = new CoachEngine({ data, ai });
    const t0 = performance.now();
    const s = sim({ wallMs: T0, clock: 900, ...quiet(0) });
    e.tick(s.state, s.gsi, T0);
    expect(performance.now() - t0).toBeLessThan(50);
    await new Promise((r) => setTimeout(r, 120));
    expect(ai.stats.timeouts).toBeGreaterThan(0);
    expect(e.queue.visible().some((h) => h.id === 'ai.advice')).toBe(false);
  });

  it('ошибка модели — пауза перед следующим запросом', async () => {
    let now = 0;
    const p = fake(() => '', { fail: true });
    const ai = new CoachAi({ provider: () => p, now: () => now });
    const e = new CoachEngine({ data, ai, now: () => now });
    await drive(e, 3);
    expect(ai.stats.failed).toBe(1);
    expect(ai.available).toBe(false);
    now += AI_BACKOFF_MS + 1;
    expect(ai.available).toBe(true);
  });
});

describe('проверка ответа ИИ', () => {
  const opts = { actions: ['farm', 'retreat'] as ('farm' | 'retreat')[], destinations: ['radiant-jungle', 'radiant-base'] as ('radiant-jungle' | 'radiant-base')[] };
  const facts = ['Здоровье: 40%', 'Врагов не видно на мини-карте: 3'];

  it('годный JSON принимается', () => {
    expect(parseAdvice('{"action":"retreat","where":"radiant-base","say":"Отходи на базу: 3 врага пропали"}', opts, facts)).toEqual({ action: 'retreat', where: 'radiant-base', say: 'Отходи на базу: 3 врага пропали' });
  });
  it('действие или место вне списка — отказ', () => {
    expect(parseAdvice('{"action":"push","where":"radiant-base","say":"Пушь"}', opts, facts)).toBeNull();
    expect(parseAdvice('{"action":"farm","where":"dire-base","say":"Фарми"}', opts, facts)).toBeNull();
  });
  it('выдуманное число — отказ', () => {
    expect(parseAdvice('{"action":"farm","where":"radiant-jungle","say":"У врага 7 героев рядом"}', opts, facts)).toBeNull();
  });
  it('не JSON или слишком длинно — отказ', () => {
    expect(parseAdvice('фарми лес', opts, facts)).toBeNull();
    expect(parseAdvice(`{"action":"farm","where":"radiant-jungle","say":"${'очень '.repeat(20)}"}`, opts, facts)).toBeNull();
  });
});

describe('разборы с ИИ', () => {
  it('разбор смерти: ИИ дописывает текст, шаблон уже был показан', async () => {
    const p = fake((req) => (req.system.includes('только что умер') ? '— Вас поймали 2 врага на чужой стороне.\n— Держитесь ближе к своим.' : '{"action":"farm","where":"radiant-jungle","say":"Фарми лес"}'));
    const ai = new CoachAi({ provider: () => p, now: () => Date.now() });
    const e = new CoachEngine({ data, ai });
    const near = (slot: number) => ({ slot, hero: 'axe', pos: { x: 2900, y: 2500 } });
    const ups = await drive(e, 14, (t) => (t < 8 ? { pos: { x: 3000, y: 2500 }, hp: 1000 - t * 120, enemies: [near(5), near(6)] } : { pos: { x: 3000, y: 2500 }, alive: false, respawnSec: 40, enemies: [near(5), near(6)] }), 1500);
    expect(ups.some((u) => u.deathReview)).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(e.deathReviewNow?.aiText).toContain('Вас поймали 2 врага');
  });
});
