// Статистика патча, новые поля GSI и прогон записанного GSI через модель состояния и движок подсказок:
// без падений, правила быстрые, подсказок в минуту не больше лимита.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapGsi } from '../../src/core/gsi/index.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import { CoachEngine } from '../../src/core/coach/engine.ts';
import { DEFAULT_QUEUE_CONFIG } from '../../src/core/coach/queue.ts';
import { parseKbStats } from '../../src/shared/types/stats.ts';
import { realData, sim } from './coach-sim.ts';

const KB = join(import.meta.dirname, '../../resources/data/kb');
const stats = JSON.parse(readFileSync(join(KB, '7.41f/stats.json'), 'utf8'));

describe('статистика патча (stats.json)', () => {
  it('того же патча, что база знаний; матчапы и сборки есть', () => {
    const current = JSON.parse(readFileSync(join(KB, 'current.json'), 'utf8')).patch;
    const s = parseKbStats(stats, current)!;
    expect(s).not.toBeNull();
    expect(s.patch).toBe(current);
    expect(s.heroes.length).toBeGreaterThanOrEqual(120);
    expect(s.heroes.filter((h) => Object.keys(h.matchups).length >= 100).length).toBeGreaterThanOrEqual(120);
    expect(s.heroes.filter((h) => h.pro && h.pro.build.length > 0).length).toBeGreaterThanOrEqual(100);
    // сборка только текущего патча: дата начала выборки не раньше выхода патча
    expect(new Date(s.patchStart).getTime()).toBeGreaterThanOrEqual(new Date('2026-09-15').getTime() - 86400_000);
  });
  it('другой патч — не используется', () => {
    expect(parseKbStats(stats, '7.40')).toBeNull();
  });
});

describe('GSI: поля для подсказок', () => {
  it('выкуп, статусы, таланты, GPM/XPM, счётчик приказов', () => {
    const body = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/gsi/laning.json'), 'utf8'));
    const r = mapGsi(body)!;
    expect(r.extra).toMatchObject({ buybackCost: 231, buybackCooldown: 0, smoked: false, magicImmune: false, talentsTaken: 0, gpm: 0, commandsIssued: 0, buildings: null });
  });
  it('здания своей команды и события', () => {
    const body = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/gsi/laning.json'), 'utf8'));
    body.buildings = { radiant: { dota_goodguys_tower1_top: { health: 1300, max_health: 1800 }, dota_goodguys_rax_melee_mid: { health: 2200, max_health: 2200 } } };
    body.events = [{ game_time: 1500, event_type: 'roshan_killed', team: 'dire' }, 'мусор'];
    const r = mapGsi(body)!;
    expect(r.extra!.buildings).toEqual([
      { key: 'tower1_top', health: 1300, maxHealth: 1800 },
      { key: 'rax_melee_mid', health: 2200, maxHealth: 2200 },
    ]);
    expect(r.extra!.events).toEqual([{ type: 'roshan_killed', gameTime: 1500, team: 'dire' }]);
  });
});

describe('прогон матча', () => {
  it('записанный GSI (Hero Demo): без ошибок, правила < 50 мс', () => {
    const lines = readFileSync(join(import.meta.dirname, '../fixtures/gsi/recorded/demo-antimage.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    const model = new MatchStateModel();
    const engine = new CoachEngine({ data: realData() });
    let last = null;
    let lastMs: number | null = null;
    const ms: number[] = [];
    for (const l of lines) {
      const e = JSON.parse(l) as { t: number; body: unknown };
      const r = mapGsi(e.body);
      if (r) {
        model.ingestGsi(r, e.t);
        last = r;
        lastMs = e.t;
      }
      ms.push(engine.tick(model.snapshot(e.t), last, lastMs).rulesMs);
    }
    ms.sort((a, b) => a - b);
    expect(ms[Math.floor(ms.length * 0.95)]!).toBeLessThan(50);
  });

  it('30 минут насыщенной игры: некритичных подсказок в минуту не больше лимита', () => {
    const engine = new CoachEngine({ data: realData() });
    const T0 = 5_000_000;
    const perMinute = new Map<number, { all: number; nonCritical: number }>();
    for (let t = 0; t < 30 * 60; t++) {
      const clock = 300 + t;
      const phase = Math.floor(t / 40) % 4; // меняем обстановку каждые 40 с
      const enemyPos = (slot: number) => (phase === 0 ? { x: -3800 + slot * 50, y: -3900 } : phase === 1 ? null : { x: 5000, y: 5000 });
      const s = sim({
        wallMs: T0 + t * 1000,
        clock,
        hp: phase === 1 ? 250 : 900,
        gold: phase === 2 ? 3500 : 600,
        pos: phase === 3 ? { x: 2500, y: 3000 } : { x: -4000 + (t % 20) * 100, y: -4000 },
        night: Math.floor(clock / 300) % 2 === 1,
        commands: t,
        items: phase === 1 ? [{ slot: 'inv1', key: 'boots' }, { slot: 'tp', key: null }] : undefined,
        allies: [{ slot: 1, hero: 'lion', pos: { x: 3000, y: 3000 } }],
        enemies: [5, 6, 7, 8, 9].map((slot) => ({ slot, hero: ['axe', 'riki', 'lion', 'pudge', 'zuus'][slot - 5]!, pos: enemyPos(slot), missingForSec: phase === 1 ? (t % 40) : 0, hpPercent: 50, barLevel: 9 })),
        buildings: [{ key: 'tower1_mid', health: Math.max(100, 1800 - (t % 120) * 20), maxHealth: 1800 }],
      });
      const u = engine.tick(s.state, s.gsi, T0 + t * 1000);
      const m = Math.floor(t / 60);
      const cur = perMinute.get(m) ?? { all: 0, nonCritical: 0 };
      for (const h of u.shown) {
        cur.all++;
        if (h.priority !== 'critical' && h.category !== 'review') cur.nonCritical++;
      }
      perMinute.set(m, cur);
    }
    const counts = [...perMinute.values()];
    expect(Math.max(...counts.map((c) => c.nonCritical))).toBeLessThanOrEqual(DEFAULT_QUEUE_CONFIG.maxPerMinute);
    expect(Math.max(...counts.map((c) => c.all))).toBeLessThanOrEqual(DEFAULT_QUEUE_CONFIG.maxPerMinute + 6);
    expect(counts.reduce((s, c) => s + c.all, 0)).toBeGreaterThan(30);
  });
});
