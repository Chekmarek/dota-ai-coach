// Ночная задача, этап 4: профиль игрока по истории коуча, напоминания в нужный момент, разбор после матча.
import { describe, expect, it } from 'vitest';
import { buildPlayerProfile, personalNote, type PlayerProfile } from '../../src/core/coach/profile.ts';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory } from '../../src/core/coach/memory.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { personalStartRule } from '../../src/core/coach/rules/macro.ts';
import { missingRule } from '../../src/core/coach/rules/danger.ts';
import type { HistoryMatch } from '../../src/shared/types/history.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const T0 = 1_000_000;
function match(i: number, p: { deaths?: { clock: number; why: string[] }[]; mistakes?: { type: string; clock: number }[]; turbo?: boolean } = {}): HistoryMatch {
  return {
    id: `m${i}`, startedAt: `2026-10-1${i}T10:00:00Z`, matchId: String(i), heroName: 'Bristleback', result: 'loss', durationSec: 2000,
    gameMode: p.turbo ? { mode: 'turbo', source: 'clock', raw: null } : undefined,
    entries: [], mistakes: (p.mistakes ?? []).map((m) => ({ type: m.type, titleRu: '', clock: m.clock, text: '', instead: '', aiText: null })),
    deathReviews: (p.deaths ?? []).map((d) => ({ clock: d.clock, why: d.why, tips: [], buyback: '', aiText: null })), matchReview: null,
  };
}

describe('профиль игрока из истории', () => {
  it('меньше трёх матчей — без повторов', () => {
    expect(buildPlayerProfile([match(1, { deaths: [{ clock: 900, why: ['Вы были в меньшинстве: 4 врага против вас одного'] }] })]).patterns).toEqual([]);
  });
  it('смерти в меньшинстве в 3 из 4 матчей — повтор; в 1 из 4 — нет', () => {
    const outn = { deaths: [{ clock: 900, why: ['Вы были в меньшинстве: 4 врага против вас одного'] }] };
    const p = buildPlayerProfile([match(1, outn), match(2, outn), match(3, outn), match(4, { mistakes: [{ type: 'unspent-gold', clock: 900 }] })]);
    expect(p.patterns.map((x) => [x.id, x.inMatches, x.of])).toEqual([['outnumbered', 3, 4]]);
  });
  it('старый формат разбора («Вас поймали 4 врага») тоже считается; «Tango не использован» — не ошибка игрока', () => {
    const old = { deaths: [{ clock: 600, why: ['Tango был готов, но не использован', 'Вас поймали 4 врага'] }] };
    const p = buildPlayerProfile([match(1, old), match(2, old), match(3, old)]);
    expect(p.patterns.map((x) => x.id)).toContain('outnumbered');
    expect(p.patterns.map((x) => x.id)).not.toContain('unused');
  });
  it('смерть в лайнинге: в Турбо — до 5:00, в обычной — до 10:00', () => {
    const d = (clock: number, turbo: boolean) => match(clock, { turbo, deaths: [{ clock, why: ['Вас убил один враг'] }] });
    expect(buildPlayerProfile([d(400, true), d(410, true), d(420, true)]).patterns).toEqual([]);
    expect(buildPlayerProfile([d(400, false), d(410, false), d(420, false)]).patterns.map((x) => x.id)).toEqual(['laning-deaths']);
  });
  it('пометка к подсказке: «в 3 из 4 последних матчей»', () => {
    const p: PlayerProfile = { matches: 4, patterns: [{ id: 'position', inMatches: 3, of: 4, titleRu: 'смерти на стороне врага без обзора', adviceRu: '' }] };
    expect(personalNote(p, 'position')).toBe(' Из прошлых игр: смерти на стороне врага без обзора — в 3 из 4 последних матчей.');
    expect(personalNote(p, 'outnumbered')).toBe('');
  });
});

describe('напоминания в матче', () => {
  const profile: PlayerProfile = { matches: 5, patterns: [{ id: 'position', inMatches: 4, of: 5, titleRu: 'смерти на стороне врага без обзора', adviceRu: 'Без обзора не заходите на половину врага, когда враги пропали с карты.' }] };
  const ctx = (i: Partial<SimInput>) => {
    const s = sim({ wallMs: T0, clock: 60, ...i });
    const v = buildView(s.state, s.gsi, T0);
    const mem = new CoachMemory();
    return { v, mem, ev: mem.ingest(v, 1800), look: new CoachLookup({ ...realData(), profile }), settings: defaultCoachSettings(), now: T0 } as never;
  };
  it('в начале матча — один раз: главная повторяющаяся ошибка с числами', () => {
    const c = ctx({ clock: 30 });
    const h = personalStartRule(c) as { short: string } | null;
    expect(h?.short).toBe('Из прошлых игр: смерти на стороне врага без обзора (4 из 5)');
    expect(personalStartRule(c)).toBeNull();
  });
  it('ситуация повторяется (на стороне врага, трое пропали) — к «назад» дописано «из прошлых игр»', () => {
    const enemies = [5, 6, 7].map((slot) => ({ slot, hero: 'axe', pos: null, missingForSec: 20 }));
    const h = missingRule(ctx({ clock: 1500, level: 18, team: 'radiant', pos: { x: 3000, y: 2500 }, enemies })) as { detail: { normal: string } } | null;
    expect(h?.detail.normal).toContain('Из прошлых игр: смерти на стороне врага без обзора — в 4 из 5 последних матчей.');
  });
});

describe('разбор после матча', () => {
  it('три главные ошибки с тем, что сделал бы сильный игрок; 1–2 цели на следующую игру', () => {
    let now = T0;
    const e = new CoachEngine({ data: realData(), now: () => now, settings: { ...defaultCoachSettings(), position: '1' } });
    const near = (slot: number) => ({ slot, hero: 'axe', pos: { x: 2900, y: 2500 } });
    for (let t = 0; t < 90; t++) {
      now = T0 + t * 1000;
      const f: Partial<SimInput> =
        t < 8 ? { pos: { x: 3000, y: 2500 }, level: 12, hp: 1000 - t * 120, enemies: [near(5), near(6), { slot: 7, hero: 'lion', pos: null, missingForSec: 20 }, { slot: 8, hero: 'pudge', pos: null, missingForSec: 20 }] }
        : t < 40 ? { pos: { x: 3000, y: 2500 }, level: 12, alive: false, respawnSec: 40 - t, enemies: [near(5), near(6)] }
        : t < 85 ? { level: 12 } : { level: 12, phase: 'post-game', winTeam: 'dire' };
      const s = sim({ wallMs: now, clock: 600 + t, ...f });
      e.tick(s.state, s.gsi, now);
    }
    const r = e.matchReviewNow!;
    expect(r).not.toBeNull();
    expect(r.why.some((w) => /^Ошибка 1.*Сильный игрок: /.test(w))).toBe(true);
    expect(r.goals.length).toBeGreaterThanOrEqual(1);
    expect(r.goals.length).toBeLessThanOrEqual(2);
  });
});
