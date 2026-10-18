// Настоящий матч Турбо (2026-10-18, Bristleback, победа, 29:44; tests/fixtures/gsi/recorded/turbo-bristleback.jsonl)
// через определение режима, модель матча и движок подсказок — как в коуче. В 0.13.2 (без режима) коуч в этом матче
// говорил «Мучитель через 30 с» в 19:30 и оценивал GPM 1048 против медианы обычной игры. Теперь — по справочнику Турбо.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameModeTracker, mapGsi, type GsiReading } from '../../src/core/gsi/index.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import { CoachEngine, defaultCoachSettings, type CoachSettings, type JournalEntry } from '../../src/core/coach/index.ts';
import type { MatchReview } from '../../src/core/coach/reviews.ts';
import { realData } from './coach-sim.ts';

const FILE = join(import.meta.dirname, '../fixtures/gsi/recorded/turbo-bristleback.jsonl');
const entries = readFileSync(FILE, 'utf8')
  .split(/\r?\n/)
  .filter(Boolean)
  .map((l) => JSON.parse(l) as { t: number; body: unknown });

function replay(gameMode: CoachSettings['gameMode']): { journal: JournalEntry[]; review: MatchReview | null; modes: Set<string>; ids: Set<string> } {
  const tracker = new GameModeTracker();
  const model = new MatchStateModel();
  let now = 0;
  const engine = new CoachEngine({ data: realData(), now: () => now, settings: { ...defaultCoachSettings(), gameMode } });
  let last: GsiReading | null = null;
  let lastMs: number | null = null;
  const modes = new Set<string>();
  const ids = new Set<string>();
  for (const e of entries) {
    now = e.t;
    const mode = tracker.feed(e.body, e.t);
    const r = mapGsi(e.body);
    if (r) {
      model.ingestGsi({ ...r, gameMode: mode }, e.t);
      last = r;
      lastMs = e.t;
    }
    const u = engine.tick(model.snapshot(e.t), last, lastMs);
    modes.add(engine.look.mode.mode);
    for (const h of u.shown) ids.add(h.id.split(':')[0]!);
  }
  return { journal: engine.journal, review: engine.matchReviewNow, modes, ids };
}

const turbo = replay('auto');
const normal = replay('normal');
const at = (j: JournalEntry[], id: string) => j.filter((x) => x.id === id).map((x) => Math.round(x.clock ?? -1));

describe('настоящий матч Турбо через коуча', () => {
  it('режим — Турбо по часам подготовки; в записи нет чата и настоящего matchid', () => {
    expect(turbo.modes).toContain('turbo');
    const text = readFileSync(FILE, 'utf8');
    expect(text).not.toMatch(/chat_message|"message"/);
    expect(text).not.toContain('9050466932');
  });
  it('Мучитель: в Турбо подсказка до 10:00, а не в 19:30 (как было в 0.13.2)', () => {
    const t = at(turbo.journal, 'timing.tormentor');
    expect(t.length).toBeGreaterThan(0);
    expect(Math.min(...t)).toBeLessThan(600);
    expect(t.every((c) => c < 600)).toBe(true);
    // в обычном режиме — по таймингам обычной игры (20:00)
    expect(at(normal.journal, 'timing.tormentor').every((c) => c >= 1140 && c < 1200)).toBe(true);
  });
  it('Святилище мудрости: в Турбо — перед каждым 3:30', () => {
    const t = at(turbo.journal, 'timing.shrine-of-wisdom');
    expect(t.length).toBeGreaterThanOrEqual(3);
    for (const c of t) {
      const next = Math.ceil(c / 210) * 210;
      expect(next - c, `подсказка в ${c} с`).toBeLessThanOrEqual(30);
    }
    expect(t.some((c) => Math.ceil(c / 420) * 420 - c > 30)).toBe(true);
  });
  it('нормы обычных матчей в Турбо не используются: GPM, добивания, «предмет запаздывает»', () => {
    for (const id of ['economy.gpm', 'laning.cs', 'economy.late']) expect(turbo.ids.has(id), id).toBe(false);
    expect(turbo.journal.some((x) => x.kind === 'mistake' && /добиваний|запаздыва/i.test(x.text))).toBe(false);
  });
  it('разбор матча: победа; GPM и XPM — без медианы обычной игры и без оценки', () => {
    const r = turbo.review!;
    expect(r).not.toBeNull();
    expect(r.result).toBe('win');
    for (const label of ['GPM', 'XPM', 'Добивания к 10:00']) {
      const s = r.stats.find((x) => x.label === label)!;
      expect(s.ref, label).toBeNull();
      expect(s.verdict, label).toBeNull();
      expect(s.refLabel, label).toBe('норм для Турбо нет');
    }
    // тот же матч «как обычный» — оценка против медианы (так было в 0.13.2)
    expect(normal.review!.stats.find((x) => x.label === 'GPM')!.ref).not.toBeNull();
  });
});
