// «Золотой» снимок обычных режимов: вся выдача движка подсказок (подсказки, ошибки, разборы, журнал), факты для ИИ
// и драфт на записях GSI и наборе ситуаций драфта. Снят до правок под Турбо (0.13.2); после правок обязан совпасть
// побайтно. Обновлять снимок (vitest -u) — только когда поведение обычных режимов меняется намеренно.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapGsi, type GsiReading } from '../../src/core/gsi/index.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import { CoachEngine, type CoachUpdate } from '../../src/core/coach/index.ts';
import { buildAiContext } from '../../src/core/ai/context.ts';
import { DraftService } from '../../src/main/coach/draft.ts';
import type { DraftRequest } from '../../src/shared/types/draft.ts';
import { realData, sim } from './coach-sim.ts';

const ROOT = join(import.meta.dirname, '../..');
const GOLDEN = join(ROOT, 'tests/fixtures/golden');

/** Тик без времени работы правил (оно зависит от машины) и без входа фильтра внимания (offered — сырые подсказки) */
function tickOut(u: CoachUpdate) {
  const { rulesMs: _ms, offered: _offered, visible, ...rest } = u;
  return { ...rest, visible: visible.map((h) => h.id) };
}

/** Прогон записи GSI {"t","body"} через модель матча и движок; часы движка — время записи */
function replay(file: string): string {
  const lines = readFileSync(join(ROOT, file), 'utf8').split(/\r?\n/).filter(Boolean);
  const model = new MatchStateModel();
  let now = 0;
  const engine = new CoachEngine({ data: realData(), now: () => now });
  const out: unknown[] = [];
  let last: GsiReading | null = null;
  let lastMs: number | null = null;
  let lastCtxMs = -Infinity;
  for (const l of lines) {
    const e = JSON.parse(l) as { t: number; body: unknown };
    now = e.t;
    const r = mapGsi(e.body);
    if (r) {
      model.ingestGsi(r, e.t);
      last = r;
      lastMs = e.t;
    }
    const s = model.snapshot(e.t);
    const u = engine.tick(s, last, lastMs);
    if (u.shown.length || u.expired.length || u.changed.length || u.mistakes.length) out.push({ t: e.t, tick: tickOut(u) });
    if (e.t - lastCtxMs >= 60_000) {
      lastCtxMs = e.t;
      out.push({ t: e.t, aiContext: buildAiContext(s, realData().mechanics) });
    }
  }
  out.push({ journal: engine.journal, deathReview: engine.deathReviewNow, matchReview: engine.matchReviewNow });
  return JSON.stringify(out, null, 1) + '\n';
}

/** Тот же синтетический 30-минутный матч, что в coach-replay.test.ts */
function synthetic(): string {
  const T0 = 5_000_000;
  let now = T0;
  const engine = new CoachEngine({ data: realData(), now: () => now });
  const out: unknown[] = [];
  for (let t = 0; t < 30 * 60; t++) {
    const clock = 300 + t;
    now = T0 + t * 1000;
    const phase = Math.floor(t / 40) % 4;
    const enemyPos = (slot: number) => (phase === 0 ? { x: -3800 + slot * 50, y: -3900 } : phase === 1 ? null : { x: 5000, y: 5000 });
    const s = sim({
      wallMs: now,
      clock,
      hp: phase === 1 ? 250 : 900,
      gold: phase === 2 ? 3500 : 600,
      pos: phase === 3 ? { x: 2500, y: 3000 } : { x: -4000 + (t % 20) * 100, y: -4000 },
      night: Math.floor(clock / 300) % 2 === 1,
      commands: t,
      items: phase === 1 ? [{ slot: 'inv1', key: 'boots' }, { slot: 'tp', key: null }] : undefined,
      allies: [{ slot: 1, hero: 'lion', pos: { x: 3000, y: 3000 } }],
      enemies: [5, 6, 7, 8, 9].map((slot) => ({ slot, hero: ['axe', 'riki', 'lion', 'pudge', 'zuus'][slot - 5]!, pos: enemyPos(slot), missingForSec: phase === 1 ? t % 40 : 0, hpPercent: 50, barLevel: 9 })),
      buildings: [{ key: 'tower1_mid', health: Math.max(100, 1800 - (t % 120) * 20), maxHealth: 1800 }],
    });
    const u = engine.tick(s.state, s.gsi, now);
    if (u.shown.length || u.expired.length || u.changed.length || u.mistakes.length) out.push({ t, tick: tickOut(u) });
    if (t % 60 === 0) out.push({ t, aiContext: buildAiContext(s.state, realData().mechanics) });
  }
  out.push({ journal: engine.journal, deathReview: engine.deathReviewNow, matchReview: engine.matchReviewNow });
  return JSON.stringify(out, null, 1) + '\n';
}

function draftCases(): string {
  const d = realData();
  const service = new DraftService({ get: () => ({ meta: { patch: d.patch, verification: 'imported-unverified' }, heroes: d.heroes, items: d.items, mechanics: d.mechanics }) as never, stats: () => d.stats });
  const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/draft/cases.json'), 'utf8')) as { cases: { id: string; input: DraftRequest }[] };
  // Поля 0.13.3 «режим статистики» (mode, statsMatches) — вне снимка: снимок сверяет подбор, угрозы и проценты
  const out = fixture.cases
    .filter((c) => !c.input.bans.includes('@top3'))
    .map((c) => {
      const { mode, statsMatches: _n, ...result } = service.suggest(c.input);
      if (mode !== 'normal') throw new Error(`${c.id}: режим статистики ${mode}, ждали normal`);
      return { id: c.id, result };
    });
  return JSON.stringify(out, null, 1) + '\n';
}

describe('золотой снимок обычных режимов (совпадает побайтно)', () => {
  it('настоящая запись Hero Demo', async () => {
    await expect(replay('tests/fixtures/gsi/recorded/demo-antimage.jsonl')).toMatchFileSnapshot(join(GOLDEN, 'demo-antimage.json'));
  });
  it('запись сессии session.jsonl', async () => {
    await expect(replay('tests/fixtures/gsi/session.jsonl')).toMatchFileSnapshot(join(GOLDEN, 'session.json'));
  });
  it('синтетический матч 30 минут', async () => {
    await expect(synthetic()).toMatchFileSnapshot(join(GOLDEN, 'synthetic-30min.json'));
  });
  it('драфт: ситуации cases.json', async () => {
    await expect(draftCases()).toMatchFileSnapshot(join(GOLDEN, 'draft-cases.json'));
  });
});
