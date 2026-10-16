// Раскладка подсказок поверх игры: на любом экране зоны не заходят на HUD Dota и не выходят за край.
import { describe, expect, it } from 'vitest';
import layoutJson from '../../src/data/hud-overlay-layout.json';
import { SCREENS, areaRect, applyOverrides, layoutSchema, moveZone, resolveLayout, hudUnit } from '../../src/core/hud/layout.ts';

const layout = layoutSchema.parse(layoutJson);

describe('раскладка подсказок', () => {
  for (const s of [...SCREENS, { id: 'odd', nameRu: '2560×1080', width: 2560, height: 1080 }, { id: 'tall', nameRu: '1280×1024', width: 1280, height: 1024 }]) {
    it(`${s.nameRu}: зоны не перекрывают HUD игры и помещаются на экран`, () => {
      const r = resolveLayout(layout, s.width, s.height);
      for (const z of r.zones) {
        expect(z.conflicts, `${z.zone.id} на ${s.nameRu}`).toEqual([]);
        expect(z.offscreen, `${z.zone.id} за краем на ${s.nameRu}`).toBe(false);
      }
      // зоны друг друга тоже не перекрывают (кроме разбора — он один на экране)
      const live = r.zones.filter((z) => z.zone.id !== 'review');
      for (const a of live) for (const b of live) if (a !== b) expect(a.rect.x < b.rect.x + b.rect.w && b.rect.x < a.rect.x + a.rect.w && a.rect.y < b.rect.y + b.rect.h && b.rect.y < a.rect.y + a.rect.h).toBe(false);
    });
  }


  it('единица растёт с высотой, на узком экране — с шириной', () => {
    expect(hudUnit(1920, 1080)).toBe(1080);
    expect(hudUnit(3440, 1440)).toBe(1440);
    expect(hudUnit(1440, 1080)).toBe(810);
  });

  it('якоря: правый край, низ, середина', () => {
    expect(areaRect({ ax: 'right', ay: 'bottom', x: 0, y: 0, w: 0.1, h: 0.1 }, 1920, 1080)).toEqual({ x: 1920 - 108, y: 1080 - 108, w: 108, h: 108 });
    expect(areaRect({ ax: 'center', ay: 'center', x: 0, y: 0, w: 0.2, h: 0.2 }, 1920, 1080)).toEqual({ x: 960 - 108, y: 540 - 108, w: 216, h: 216 });
  });

  it('перетаскивание: сдвиг в пикселях переводится в смещение от якоря и обратно', () => {
    const zone = layout.zones.find((z) => z.id === 'decision')!;
    const moved = moveZone(zone, -100, 50, 1920, 1080);
    const before = areaRect(zone, 1920, 1080);
    const after = areaRect({ ...zone, ...moved }, 1920, 1080);
    expect(Math.round(after.x - before.x)).toBe(-100);
    expect(Math.round(after.y - before.y)).toBe(50);
    const l2 = applyOverrides(layout, { decision: moved });
    expect(l2.zones.find((z) => z.id === 'decision')!.x).toBe(moved.x);
  });

  it('зона, перетащенная на мини-карту, помечается конфликтом', () => {
    const l2 = applyOverrides(layout, { timing: { x: 0.01, y: 0.85 } });
    const z = resolveLayout(l2, 1920, 1080).zones.find((x) => x.zone.id === 'timing')!;
    expect(z.conflicts.length).toBeGreaterThan(0);
  });
});
