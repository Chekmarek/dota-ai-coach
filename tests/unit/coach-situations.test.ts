// Этап 6 «понимания игры»: набор настоящих ситуаций — из матчей владельца (2026-10-18) и про-матчей OpenDota.
// В каждой: что сказал бы сильный игрок → коуч говорит то же или молчит. Обязательные проверки задачи — первыми.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { CoachMemory, nearEnemyCount } from '../../src/core/coach/memory.ts';
import { engagePercent } from '../../src/core/coach/prob.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { deathCauses } from '../../src/core/coach/reviews.ts';
import { benchRule } from '../../src/core/coach/rules/laning.ts';
import { helpRule, outpostRule } from '../../src/core/coach/rules/macro.ts';
import { buybackRule } from '../../src/core/coach/rules/fight.ts';
import { parseStatsRanked } from '../../src/shared/types/stats-ranked.ts';
import type { DeathRecord } from '../../src/core/coach/memory.ts';
import type { GameModeInfo } from '../../src/core/gsi/mode.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const T0 = 1_000_000;
const TURBO: GameModeInfo = { mode: 'turbo', source: 'clock', raw: 'start -1:00' };
const ranked = parseStatsRanked(JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/data/kb/7.41f/stats-ranked.json'), 'utf8')), '7.41f');
const data: CoachData = { ...realData(), statsRanked: ranked };

function ctxOf(i: Partial<SimInput>, opts: { turbo?: boolean; position?: '1' | '2' | '3' | '4' | '5' } = {}) {
  const s = sim({ wallMs: T0, clock: 600, ...i });
  const v = buildView(s.state, s.gsi, T0);
  const mem = new CoachMemory();
  const look = new CoachLookup(data);
  if (opts.turbo) look.setMode(TURBO);
  return { v, mem, ev: mem.ingest(v, 1800), look, settings: { ...defaultCoachSettings(), position: opts.position ?? 'auto' }, now: T0 } as never;
}
const death = (p: Partial<DeathRecord>): DeathRecord => ({
  clock: 1500, wallMs: 0, zone: 'mid-lane', side: 'own', night: false, hpBefore: 90, dropSec: 6, enemiesNear: 1, alliesNear: 0, enemiesMissing: 0,
  ultReady: null, keyItemsReady: [], readyActives: [], tpReady: false, hadRegen: false, buybackReady: null, gold: 1000, buybackCost: 2000, respawnSec: 40,
  engageAtEntry: null, myLevel: 20, enemyLevels: [20], regenItems: [], ...p,
});

describe('обязательные проверки задачи', () => {
  it('1-я минута, позиция 1 → коуч не советует лес', () => {
    let now = T0;
    const e = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), position: '1' } });
    const said: string[] = [];
    for (let t = 0; t < 120; t++) {
      now = T0 + t * 1000;
      const s = sim({ wallMs: now, clock: t, team: 'dire', level: 1 + Math.floor(t / 40), pos: { x: 3000, y: 3000 } });
      said.push(...e.tick(s.state, s.gsi, now).shown.map((h) => h.short));
    }
    expect(said.filter((x) => /лес/i.test(x))).toEqual([]);
  });
  it('смерть в лейте → причина не Tango', () => {
    const causes = deathCauses(death({ clock: 1900, regenItems: ['tango'], dropSec: 15, enemiesNear: 3 }), 'late', new CoachLookup(data));
    expect(causes.map((c) => c.why).join(' ')).not.toMatch(/Tango/);
  });
  it('2 врага рядом → видит 2', () => {
    const s = sim({ wallMs: T0, clock: 600, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] });
    s.state.healthBars = [
      { team: 'radiant', side: 'ally', hpPercent: 90, level: 8, slot: s.gsi!.slot!, x: 900, y: 500, confidence: 0.9 },
      { team: 'dire', side: 'enemy', hpPercent: 80, level: 8, slot: null, x: 1000, y: 480, confidence: 0.8 },
      { team: 'dire', side: 'enemy', hpPercent: 70, level: 7, slot: null, x: 1150, y: 480, confidence: 0.8 },
    ];
    expect(nearEnemyCount(buildView(s.state, s.gsi, T0))).toBe(2);
  });
  it('у врага больше HP и уровень → шанс победы ниже 50%', () => {
    const s = sim({ wallMs: T0, clock: 600, level: 6, hp: 500, maxHp: 1000, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] });
    s.state.healthBars = [
      { team: 'radiant', side: 'ally', hpPercent: 50, level: 6, slot: s.gsi!.slot!, x: 900, y: 500, confidence: 0.9 },
      { team: 'dire', side: 'enemy', hpPercent: 95, level: 9, slot: null, x: 1000, y: 480, confidence: 0.8 },
    ];
    expect(engagePercent(buildView(s.state, s.gsi, T0), new CoachMemory(), new CoachLookup(data), 0).value).toBeLessThan(50);
  });
  it('Дота открыта без матча → подсказок нет', () => {
    let now = T0;
    const e = new CoachEngine({ data, now: () => now });
    const shown: string[] = [];
    for (let t = 0; t < 60; t++) {
      now = T0 + t * 1000;
      // меню Доты: данных игры нет, на экране — нет часов матча
      const s = sim({ wallMs: now, clock: 0, noGsi: true });
      s.state.match.clock = { value: null, confidence: 0, tag: 'unknown', lastSeenWallMs: null, firstSeenWallMs: null, source: 'screen' } as never;
      shown.push(...e.tick(s.state, null, null).shown.map((h) => h.id));
    }
    expect(shown).toEqual([]);
  });
});

describe('обязательные проверки ночной задачи', () => {
  it('другое окно активно → оверлея нет (и Дота свёрнута → нет); вернулись в Доту → есть', async () => {
    const { hudShouldShow } = await import('../../src/main/live/window-rect');
    const dota = { x: 0, y: 0, width: 1920, height: 1080, minimized: false };
    const base = { enabled: true, hasContent: true, demo: false };
    expect(hudShouldShow({ ...base, rect: { ...dota, active: false, foreground: 'Telegram' } })).toBe(false);
    expect(hudShouldShow({ ...base, rect: { ...dota, minimized: true, active: false } })).toBe(false);
    expect(hudShouldShow({ ...base, rect: { ...dota, active: true, foreground: 'dota2' } })).toBe(true);
  });
  it('в драке → нет советов про фарм, предметы и линию', () => {
    let now = T0;
    const e = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), position: '1' } });
    const said: { id: string; short: string; category: string; inFight: boolean }[] = [];
    const enemies = [5, 6].map((slot) => ({ slot, hero: slot === 5 ? 'lina' : 'axe', pos: { x: 200 + slot * 20, y: 0 }, hpPercent: 60, barLevel: 14 }));
    for (let t = 0; t < 40; t++) {
      now = T0 + t * 1000;
      // 10 с спокойно, потом драка: враги рядом, здоровье падает; золота много, простой — всё, что звало бы фармить
      const fight = t >= 10;
      const s = sim({ wallMs: now, clock: 900 + t, level: 15, hp: fight ? Math.max(400, 2000 - (t - 10) * 60) : 2000, maxHp: 2000, gold: 4000, pos: { x: 0, y: 0 }, enemies: fight ? enemies : [], items: [{ slot: 'inv0', key: 'power_treads' }] });
      const u = e.tick(s.state, s.gsi, now);
      for (const h of u.shown) said.push({ id: h.id, short: h.short, category: h.category, inFight: u.inFight });
    }
    const duringFight = said.filter((x) => x.inFight);
    expect(duringFight.length).toBeGreaterThan(0);
    expect(duringFight.filter((x) => ['economy', 'laning'].includes(x.category) || /фарм|лес|купите|дальше/i.test(x.short))).toEqual([]);
  });
});

describe('ситуации из матчей владельца 18.10 (что сказал бы сильный игрок → коуч)', () => {
  it('0:30, оффлейнер на линии, у союзников драка на другой линии → «стой на линии» → без «телепорт»', () => {
    const c = ctxOf({ clock: 30, level: 1, team: 'dire', pos: { x: 6000, y: -5000 }, allies: [{ slot: 6, hero: 'lion', pos: { x: -6000, y: 5000 } }], enemies: [0, 1].map((slot) => ({ slot, hero: slot ? 'axe' : 'lina', pos: { x: -6000 + slot * 200, y: 5100 } })) }, { position: '3' });
    expect(helpRule(c)).toBeNull();
  });
  it('8:43, Силы Тьмы у аванпоста на своей половине → «он свой» → молчит', () => {
    expect(outpostRule(ctxOf({ clock: 523, team: 'dire', pos: { x: 2884, y: -542 }, enemies: [] }))).toBeNull();
  });
  it('32:10, только что выкупились → «выкуп на перезарядке, не о чем говорить» → молчит', () => {
    expect(buybackRule(ctxOf({ clock: 1931, level: 30, gold: 4826, buybackCost: 7534, buybackCooldown: 2582, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }))).toBeNull();
  });
  it('24:03, смерть на стороне врага в одиночку, телепорт был → «плохая позиция» — главная причина', () => {
    const c = deathCauses(death({ clock: 1443, side: 'enemy', zone: 'mid-lane', alliesNear: 0, enemiesMissing: 2, tpReady: true, dropSec: 8, enemiesNear: 2 }), 'late', new CoachLookup(data));
    expect(c[0]!.id).toBe('position');
  });
  it('Турбо → сравнения с сильными игроками рейтинга нет (данных Турбо нет) — молчит', () => {
    expect(benchRule(ctxOf({ clock: 605, heroKey: 'antimage', lastHits: 5, gpm: 200, xpm: 200 }, { turbo: true, position: '1' }))).toBeNull();
  });
});

describe('настоящие сильные игроки (про-матчи OpenDota) — коуч их не ругает', () => {
  const sample = JSON.parse(readFileSync(join(import.meta.dirname, '../fixtures/pro-players-sample.json'), 'utf8')) as { players: { hero_id: number; position: number; lh_t: number[]; gold_t: number[]; xp_t: number[] }[] };
  const look = new CoachLookup(data);
  it('профи на 10, 15, 20, 25-й минуте: «вы отстаёте от сильных игроков» — у меньшинства (< 20% проверок)', () => {
    let checks = 0;
    let lagging = 0;
    for (const p of sample.players) {
      const key = look.heroById.get(p.hero_id)?.key;
      if (!key) continue;
      for (const m of [10, 15, 20, 25]) {
        const c = ctxOf({ clock: m * 60 + 5, heroKey: key, lastHits: p.lh_t[m]!, gpm: Math.round(p.gold_t[m]! / m), xpm: Math.round(p.xp_t[m]! / m), level: 10 }, { position: String(p.position) as '1' });
        const h = benchRule(c) as { short: string } | null;
        if (look.rankedAt(key, p.position, m) === null && look.proAt(key, p.position, m) === null) continue;
        checks++;
        if (h && /у сильных игроков|у профи/.test(h.short)) lagging++;
      }
    }
    expect(checks).toBeGreaterThan(500);
    expect(lagging / checks).toBeLessThan(0.2);
  });
});
