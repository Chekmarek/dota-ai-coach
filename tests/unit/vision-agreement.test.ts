import { describe, expect, it } from 'vitest';
import { VisionAgreementTracker, type SpectatorHero } from '../../src/core/gsi/index.ts';
import type { HudReading } from '../../src/core/vision/recognize-hud.ts';

const hero = (slot: number, p: Partial<SpectatorHero> = {}): SpectatorHero => ({
  team: slot < 5 ? 'radiant' : 'dire',
  slot,
  heroKey: `h${slot}`,
  xpos: slot * 1000 - 5000,
  ypos: 0,
  alive: true,
  respawnSec: 0,
  health: 500,
  maxHealth: 1000,
  level: slot + 1,
  ...p,
});
const spectator = (heroes = Array.from({ length: 10 }, (_, s) => hero(s))) => ({ clock: 600, daytime: true, heroes });

/** Кадр только с полями этапов 1–3 (остальное сверке не нужно) */
const hud = (p: Partial<HudReading>) => p as HudReading;

describe('точность зрения о союзниках и врагах по GSI наблюдателя', () => {
  it('верхняя панель, мини-карта и полоски сравниваются с GSI; без GSI наблюдателя строк нет', () => {
    const t = new VisionAgreementTracker();
    const frame = hud({
      topBar: {
        supported: true,
        durationMs: 1,
        slots: [
          { slot: 0, team: 'radiant', side: null, heroKey: 'h0', heroConfidence: 0.9, alive: true, aliveConfidence: 0.9, respawnSec: null, respawnConfidence: 0 },
          { slot: 1, team: 'radiant', side: null, heroKey: 'wrong', heroConfidence: 0.9, alive: false, aliveConfidence: 0.9, respawnSec: null, respawnConfidence: 0 },
        ],
      },
      minimap: {
        rect: null,
        supported: true,
        durationMs: 1,
        heroes: [
          { slot: 2, team: 'radiant', x: -3000 + 150, y: 100, px: 0, py: 0, confidence: 0.9, ambiguous: false, others: [] },
          { slot: 3, team: 'radiant', x: 5000, y: 5000, px: 0, py: 0, confidence: 0.9, ambiguous: false, others: [] },
          // Иллюзии: какой значок герой — неизвестно, не сравниваем
          { slot: 4, team: 'radiant', x: 9999, y: 9999, px: 0, py: 0, confidence: 0.5, ambiguous: true, others: [] },
        ],
      },
      healthBars: {
        supported: true,
        durationMs: 1,
        bars: [
          { color: 'green', hpPercent: 52, level: 3, levelConfidence: 0.8, x: 0, y: 0, length: 99, confidence: 1 },
          { color: 'red', hpPercent: 90, level: 7, levelConfidence: 0.8, x: 0, y: 0, length: 99, confidence: 1 },
          // Уровня нет — чья полоска, неизвестно: не сравниваем
          { color: 'red', hpPercent: 10, level: null, levelConfidence: 0, x: 0, y: 0, length: 99, confidence: 1 },
        ],
      },
    });
    t.addScreen(frame, 1000);
    expect(t.report()).toEqual({});
    t.addSpectator(spectator(), 1000);
    t.addScreen(frame, 1100);
    const r = t.report();
    expect(r.topBarHero).toMatchObject({ samples: 2, agreePct: 50, lastMismatch: { gsi: 'h1', screen: 'wrong' } });
    expect(r.topBarAlive).toMatchObject({ samples: 2, agreePct: 50 });
    expect(r.minimapPosition).toMatchObject({ samples: 2, agreePct: 50 });
    expect(r.healthBarHp).toMatchObject({ samples: 2, agreePct: 50, lastMismatch: { gsi: 50, screen: 90 } });
    // Старое чтение GSI (> 1 с) уже не годится
    t.addScreen(frame, 2500);
    expect(t.report().topBarHero!.samples).toBe(2);
  });
});
