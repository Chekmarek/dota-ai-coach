// Этап 5: имитация матча через движок подсказок в main (CoachService) — записанный GSI и синтетический 40-минутный
// матч с ботами (только данные игры и с «экраном»). Проверяем: подсказки появляются, карточки проходят схему окна,
// некритичных — не больше лимита в минуту, ИИ выключен или падает — работают шаблоны, ИИ работает — бюджет соблюдён.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoachService } from '../../src/main/coach/service';
import { defaultSettings } from '../../src/shared/schemas/settings';
import { hudHintSchema, type HudHint } from '../../src/shared/types/hud';
import type { HistoryMatch } from '../../src/shared/types/history';
import type { AiProvider, AiRequest } from '../../src/core/ai/provider';
import { mapGsi } from '../../src/core/gsi/index';
import { MatchStateModel } from '../../src/core/match-state/index';
import { DEFAULT_QUEUE_CONFIG } from '../../src/core/coach/queue';
import { realData, sim, type SimInput } from './coach-sim';

const data = realData();
/** Имитация 40 минут матча — несколько тысяч тиков: на медленной машине CI дольше стандартных 5 с */
const SIM_TIMEOUT_MS = 120_000;
const kb = {
  get: () => ({ meta: { patch: '7.41f', verification: 'imported-unverified' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics }) as never,
  stats: () => data.stats,
};

interface Run {
  shown: { t: number; h: HudHint }[];
  saved: HistoryMatch[];
  calls: number;
}

function service(provider: AiProvider | null, clockRef: { now: number }, run: Run) {
  let prev = new Set<number>();
  return new CoachService({
    settings: { get: () => defaultSettings() },
    kb,
    aiProvider: () => provider,
    history: { save: (m) => void run.saved.push(structuredClone(m)) },
    now: () => clockRef.now,
    onHints: (hints) => {
      for (const h of hints) {
        expect(hudHintSchema.safeParse(h).success).toBe(true);
        if (!prev.has(h.seq)) run.shown.push({ t: clockRef.now, h });
      }
      prev = new Set(hints.map((h) => h.seq));
    },
  });
}

/** Синтетический матч с ботами: лайн, драки, смерть, башни, Рошан, поздняя игра, конец */
function botMatch(t: number, screen: boolean): Partial<SimInput> {
  const clock = -85 + t;
  const phase = clock < 600 ? 'lane' : clock < 1500 ? 'mid' : 'late';
  const fight = clock % 240 > 200 && clock % 240 < 215;
  const dead = clock > 1210 && clock < 1245;
  const enemies = screen
    ? [5, 6, 7, 8, 9].map((slot) => ({
        slot,
        hero: ['axe', 'riki', 'lion', 'pudge', 'zuus'][slot - 5]!,
        pos: fight ? { x: -3900 + slot * 40, y: -3900 } : clock % 300 > 150 && slot < 8 ? null : { x: 4000 + slot * 100, y: 4000 },
        missingForSec: clock % 300 > 150 ? (clock % 300) - 150 : 0,
        hpPercent: fight ? 40 + slot * 5 : null,
        barLevel: fight ? Math.min(25, 3 + Math.floor(clock / 120)) : null,
        alive: !(clock > 1600 && clock < 1640 && slot < 7),
        respawnAt: 1660,
      }))
    : [];
  return {
    clock,
    phase: clock >= 2400 ? 'post-game' : 'in-progress',
    winTeam: clock >= 2400 ? 'radiant' : null,
    level: Math.min(25, 1 + Math.floor(Math.max(0, clock) / 100)),
    gold: phase === 'late' && clock % 200 < 80 ? 3200 : 400 + (clock % 300),
    hp: fight ? 1000 - (clock % 240 - 200) * 45 : dead ? 0 : 900,
    alive: !dead,
    respawnSec: dead ? 1245 - clock : 0,
    pos: phase === 'lane' ? { x: -6000 + (t % 30) * 120, y: -5800 } : { x: -3000 + (t % 60) * 100, y: -3500 + (t % 40) * 60 },
    commands: t,
    gpm: 300 + Math.floor(Math.max(0, clock) / 10),
    xpm: 400 + Math.floor(Math.max(0, clock) / 8),
    lastHits: Math.floor(Math.max(0, clock) / 18),
    buildings: [{ key: 'tower1_mid', health: clock > 900 && clock < 960 ? 1800 - (clock - 900) * 20 : 1800, maxHealth: 1800 }],
    events: clock > 1700 ? [{ type: 'roshan_killed', gameTime: 1790, team: 'dire' }] : [],
    enemies,
  };
}

function runBotMatch(provider: AiProvider | null, screen: boolean): Run {
  const run: Run = { shown: [], saved: [], calls: 0 };
  const clockRef = { now: 0 };
  const svc = service(provider, clockRef, run);
  for (let t = 0; t < 2490; t++) {
    clockRef.now = 10_000_000 + t * 1000;
    const s = sim({ wallMs: clockRef.now, clock: 0, ...botMatch(t, screen) });
    svc.ingest({ state: s.state, gsi: { ...s.gsi!, gameState: t < 85 ? 'DOTA_GAMERULES_STATE_PRE_GAME' : 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', phase: t < 85 ? 'pre-game' : s.gsi!.phase }, gsiWallMs: clockRef.now });
  }
  return run;
}

function perMinute(run: Run): { all: number[]; nonCritical: number[] } {
  const minutes = new Map<number, { all: number; nc: number }>();
  for (const { t, h } of run.shown) {
    const m = Math.floor((t - 10_000_000) / 60_000);
    const c = minutes.get(m) ?? { all: 0, nc: 0 };
    c.all++;
    if (h.priority !== 'critical' && h.category !== 'review') c.nc++;
    minutes.set(m, c);
  }
  return { all: [...minutes.values()].map((c) => c.all), nonCritical: [...minutes.values()].map((c) => c.nc) };
}

const fakeAi = (counter: { n: number }, fail = false): AiProvider => ({
  id: 'mock',
  async *generate(req: AiRequest) {
    counter.n++;
    if (fail) throw new Error('server');
    const m = /ОДНО действие из: (\w+)[\s\S]*?ОДНО место из: ([\w-]+)/.exec(req.system);
    yield m ? `{"action":"${m[1]}","where":"${m[2]}","say":"Делай по плану коуча"}` : 'Коротко по делу';
  },
});

describe('имитация матча с ботами', () => {
  for (const screen of [false, true]) {
    it(`ИИ выключен, ${screen ? 'с захватом экрана' : 'только данные игры'}: подсказки есть, шаблоны, лимит в минуту`, () => {
      const run = runBotMatch(null, screen);
      expect(run.shown.length).toBeGreaterThan(20);
      expect(run.shown.every((x) => x.h.source === 'template')).toBe(true);
      const pm = perMinute(run);
      expect(Math.max(...pm.nonCritical)).toBeLessThanOrEqual(DEFAULT_QUEUE_CONFIG.maxPerMinute);
      // до горна уже есть подсказка (руны в 0:00)
      expect(run.shown.some((x) => x.t < 10_000_000 + 85_000)).toBe(true);
      const cats = new Set(run.shown.map((x) => x.h.category));
      for (const c of ['timing', 'economy', 'review']) expect(cats.has(c as never), c).toBe(true);
      if (screen) for (const c of ['fight', 'danger']) expect(cats.has(c as never), c).toBe(true);
      // разбор смерти и итог матча — в истории
      const last = run.saved[run.saved.length - 1]!;
      expect(last.deathReviews.length).toBeGreaterThanOrEqual(1);
      expect(last.matchReview?.result).toBe('win');
    }, SIM_TIMEOUT_MS);
  }

  it('ИИ падает на каждом запросе — подсказки идут шаблонами, движок не ломается', () => {
    const c = { n: 0 };
    const run = runBotMatch(fakeAi(c, true), true);
    expect(run.shown.length).toBeGreaterThan(20);
    expect(run.shown.every((x) => x.h.source === 'template')).toBe(true);
  }, SIM_TIMEOUT_MS);

  it('ИИ работает — советы ИИ есть, обращений к модели немного (по событиям, с бюджетом)', async () => {
    const c = { n: 0 };
    const run: Run = { shown: [], saved: [], calls: 0 };
    const clockRef = { now: 0 };
    const svc = service(fakeAi(c), clockRef, run);
    for (let t = 0; t < 2490; t++) {
      clockRef.now = 10_000_000 + t * 1000;
      const s = sim({ wallMs: clockRef.now, clock: 0, ...botMatch(t, true) });
      svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: clockRef.now });
      await new Promise((r) => setImmediate(r));
    }
    expect(run.shown.some((x) => x.h.source === 'ai')).toBe(true);
    // ~40 минут: обращений к модели — десятки, не сотни
    expect(c.n).toBeLessThan(200);
    expect(c.n / 41).toBeLessThanOrEqual(6);
  }, SIM_TIMEOUT_MS);
});

describe('имитация по настоящей записи GSI (Hero Demo)', () => {
  it('без ошибок, карточки валидны, лимит в минуту соблюдён', () => {
    const lines = readFileSync(join(import.meta.dirname, '../fixtures/gsi/recorded/demo-antimage.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    const run: Run = { shown: [], saved: [], calls: 0 };
    const clockRef = { now: 0 };
    const svc = service(null, clockRef, run);
    const model = new MatchStateModel();
    let reading = null;
    let at: number | null = null;
    for (const l of lines) {
      const e = JSON.parse(l) as { t: number; body: unknown };
      clockRef.now = e.t;
      const r = mapGsi(e.body);
      if (r) {
        model.ingestGsi(r, e.t);
        reading = r;
        at = e.t;
      }
      svc.ingest({ state: model.snapshot(e.t), gsi: reading, gsiWallMs: at });
    }
    const pm = perMinute(run);
    if (pm.nonCritical.length) expect(Math.max(...pm.nonCritical)).toBeLessThanOrEqual(DEFAULT_QUEUE_CONFIG.maxPerMinute);
  }, SIM_TIMEOUT_MS);
});
