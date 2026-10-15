import { describe, expect, it } from 'vitest';
import { CONFIRM_MS, ILLUSION_MEMORY_MS, JUMP_CONFIRM_MS, MinimapTracker } from '../../src/core/vision/minimap-track.ts';
import type { MinimapHero, MinimapReading } from '../../src/core/vision/minimap.ts';

const hero = (x: number, y: number, others: { x: number; y: number; n: number }[] = []): MinimapHero => ({
  slot: 8,
  team: 'dire',
  x,
  y,
  px: 0,
  py: 0,
  confidence: 0.9,
  ambiguous: false,
  others,
});
const reading = (...heroes: MinimapHero[]): MinimapReading => ({ supported: true, heroes, rect: null, durationMs: 1 });

/** Подаёт значок раз в 1,1 с (как в наборе кадров), возвращает последнее решение */
function feed(t: MinimapTracker, from: number, n: number, make: (i: number) => MinimapHero): { at: number; h: MinimapHero } {
  let h!: MinimapHero, at = from;
  for (let i = 0; i < n; i++) {
    at = from + i * 1100;
    h = t.update(reading(make(i)), at).heroes[0]!;
  }
  return { at, h };
}

describe('сопровождение значков мини-карты', () => {
  it('первый показ — «вывод», пока значок не продержится; затем — утверждение', () => {
    const t = new MinimapTracker();
    expect(t.update(reading(hero(0, 0)), 0).heroes[0]!.ambiguous).toBe(true);
    expect(t.update(reading(hero(300, 0)), CONFIRM_MS).heroes[0]!.ambiguous).toBe(false);
  });

  it('скачок на другой конец карты на один кадр — не подмена: «вывод», место героя не переносится', () => {
    const t = new MinimapTracker();
    const { at } = feed(t, 0, 4, (i) => hero(-5000 + i * 300, -5000));
    const jump = t.update(reading(hero(5000, 5000)), at + 1100).heroes[0]!;
    expect(jump).toMatchObject({ ambiguous: true });
    // Герой снова там, где был, — сразу утверждается
    expect(t.update(reading(hero(-3800, -5000)), at + 2200).heroes[0]!).toMatchObject({ ambiguous: false, x: -3800 });
  });

  it('иллюзия крупнее героя: выбирается значок, достижимый от прежнего места, а не самый крупный', () => {
    const t = new MinimapTracker();
    const { at } = feed(t, 0, 3, () => hero(1000, 1000));
    const h = t.update(reading(hero(6000, -2000, [{ x: 1200, y: 1100, n: 30 }])), at + 1100).heroes[0]!;
    // Место — у прежнего, но раз значков несколько (иллюзии), это «вывод», а не утверждение
    expect(h).toMatchObject({ x: 1200, y: 1100, ambiguous: true });
    // ...и ещё ILLUSION_MEMORY_MS после, даже если значок снова один
    expect(t.update(reading(hero(1300, 1100)), at + 2200).heroes[0]!.ambiguous).toBe(true);
    let last!: MinimapHero;
    for (let dt = 3300; dt <= 1100 + ILLUSION_MEMORY_MS + 1100; dt += 1100) last = t.update(reading(hero(1300, 1100)), at + dt).heroes[0]!;
    expect(last.ambiguous).toBe(false);
  });

  it('настоящее перемещение (телепорт) подтверждается после JUMP_CONFIRM_MS', () => {
    const t = new MinimapTracker();
    const { at } = feed(t, 0, 3, () => hero(-6000, -6000));
    let last = at;
    let h!: MinimapHero;
    for (let dt = 1100; dt <= JUMP_CONFIRM_MS + 2200; dt += 1100) {
      last = at + dt;
      h = t.update(reading(hero(6000, 6000)), last).heroes[0]!;
      if (dt - 1100 < JUMP_CONFIRM_MS) expect(h.ambiguous).toBe(true);
    }
    expect(h.ambiguous).toBe(false);
  });

  it('перемотка записи назад — прежние места забываются', () => {
    const t = new MinimapTracker();
    feed(t, 10_000, 3, () => hero(-6000, -6000));
    expect(t.update(reading(hero(6000, 6000)), 0).heroes[0]!.ambiguous).toBe(true);
  });
});
