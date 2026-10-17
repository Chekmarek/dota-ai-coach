// Проверка правил драфта на наборе ситуаций (tests/fixtures/draft/cases.json) и настоящей статистике патча:
// взятые и забаненные не предлагаются, позиция соблюдается, вклады складываются (добавить врага = прибавить его
// вклад), пары меньше 100 игр не влияют, нет статистики — честно сказано. Три случая посчитаны вручную.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { counterDelta, counterItems, enemyThreats, suggestHeroes, synergyDelta, THREATS, HERO_THREATS } from '../../src/core/draft/index.ts';
import { DraftService } from '../../src/main/coach/draft.ts';
import type { DraftRequest } from '../../src/shared/types/draft.ts';
import { realData } from './coach-sim.ts';

const ROOT = join(import.meta.dirname, '../..');
interface Case {
  id: string;
  input: DraftRequest;
  removeStats?: string[];
  noStatsFile?: boolean;
  expect: {
    candidates?: number;
    scoreIsMetaOnly?: boolean;
    reasonsVs?: string[];
    threats?: string[];
    meRole?: 'core' | 'support';
    meWorstOrBest?: string[];
    zeroPairs?: [string, string][];
    noStats?: string[];
    notSuggested?: string[];
    error?: string;
  };
}
const fixture = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/draft/cases.json'), 'utf8')) as { cases: Case[]; handChecked: { id: string; expected: unknown }[] };
const real = realData();

/** Данные с удалёнными записями статистики (герой «без статистики») */
function dataWithout(keys: readonly string[] = [], noStats = false): CoachData {
  if (noStats) return { ...real, stats: null };
  if (!keys.length) return real;
  const ids = new Set(real.heroes.filter((h) => keys.includes(h.key)).map((h) => h.id));
  return { ...real, stats: { ...real.stats!, heroes: real.stats!.heroes.filter((h) => !ids.has(h.id)) } };
}
const service = (d: CoachData) =>
  new DraftService({ get: () => ({ meta: { patch: d.patch, verification: 'imported-unverified' }, heroes: d.heroes, items: d.items, mechanics: d.mechanics }) as never, stats: () => d.stats });

/** «@top3» в банах — три лучших кандидата того же драфта без банов */
function resolve(c: Case, look: CoachLookup): DraftRequest {
  if (!c.input.bans.includes('@top3')) return c.input;
  const top = suggestHeroes(look, { ...c.input, bans: [], limit: 3 }).map((x) => x.hero);
  return { ...c.input, bans: [...c.input.bans.filter((b) => b !== '@top3'), ...top] };
}

describe('драфт: набор ситуаций', () => {
  it('в наборе не меньше 12 ситуаций', () => expect(fixture.cases.length).toBeGreaterThanOrEqual(12));

  for (const c of fixture.cases) {
    it(c.id, () => {
      const d = dataWithout(c.removeStats, c.noStatsFile);
      const look = new CoachLookup(d);
      const req = resolve(c, look);
      const r = service(d).suggest(req);
      const e = c.expect;

      if (e.error) {
        expect(r.error).toMatch(new RegExp(e.error));
        expect(r.candidates).toEqual([]);
        return;
      }
      expect(r.error).toBeNull();
      if (e.candidates !== undefined) expect(r.candidates).toHaveLength(e.candidates);

      // Никто из взятых и забаненных
      const taken = new Set([...req.allies, ...req.enemies, ...req.bans, ...(req.me ? [req.me] : [])]);
      for (const x of r.candidates) expect(taken.has(x.hero), x.hero).toBe(false);
      // Позиция
      if (req.position) for (const x of r.candidates) expect(x.positions, x.hero).toContain(req.position);
      // Оценка = сумма вкладов (то, что показано игроку, складывается в итог)
      for (const x of r.candidates) {
        const sum = x.meta + x.vsEnemies.reduce((s, v) => s + v.delta, 0) + x.withAllies.reduce((s, v) => s + v.delta, 0);
        expect(x.score, x.hero).toBeCloseTo(sum, 3);
        for (const v of x.vsEnemies) expect(v.delta, `${x.hero} против ${v.hero}`).toBe(counterDelta(look, x.hero, v.hero)!.delta);
        for (const v of x.withAllies) expect(v.delta, `${x.hero} с ${v.hero}`).toBe(synergyDelta(look, x.hero, v.hero)!.delta);
      }
      if (e.scoreIsMetaOnly) for (const x of r.candidates) expect(x.score).toBe(x.meta);
      if (e.reasonsVs) for (const x of r.candidates) expect(x.vsEnemies.map((v) => v.hero)).toEqual(e.reasonsVs);
      if (e.threats) expect(new Set(r.threats.map((t) => t.id))).toEqual(new Set(e.threats));
      if (e.meRole) {
        expect(r.me?.role).toBe(e.meRole);
        // Что видит игрок (Draft.tsx при выбранном герое показывает только предметы своей роли и общие):
        // первым в каждой угрозе — предмет, который советуют подсказки в матче (counterItems)
        const advice = counterItems(enemyThreats(req.enemies, look.invisHeroes), e.meRole);
        for (const t of r.threats) {
          const shown = t.items.filter((i) => i.role === 'any' || i.role === e.meRole);
          const a = advice.find((s) => s.threat === t.id);
          if (a) expect(shown[0]?.key, t.id).toBe(a.key);
          else expect(shown, `${t.id}: для роли ${e.meRole} предметов нет`).toEqual([]);
        }
      }
      if (e.meWorstOrBest) for (const v of [...r.me!.worst, ...r.me!.best]) expect(e.meWorstOrBest).toContain(v.hero);
      if (e.zeroPairs) for (const [a, b] of e.zeroPairs) {
        const cd = counterDelta(look, a, b)!;
        expect(cd.games, `${a}–${b}`).toBeLessThan(100);
        expect(cd.delta, `${a}–${b}`).toBe(0);
      }
      if (e.noStats) expect(r.noStats).toEqual(e.noStats.map((k) => look.heroName(k)));
      if (e.notSuggested) {
        const all = suggestHeroes(look, { ...req, limit: 500 }).map((x) => x.hero);
        for (const k of e.notSuggested) expect(all).not.toContain(k);
      }
    });
  }
});

describe('драфт: вклады складываются (монотонность)', () => {
  const look = new CoachLookup(real);
  const all = (enemies: string[], allies: string[] = []) => new Map(suggestHeroes(look, { allies, enemies, limit: 500 }).map((x) => [x.hero, x.score]));
  const base = all(['invoker'], ['lion']);

  it('добавить врага = прибавить ровно его вклад; контрпик врага не теряет очков, проигрывающий — не получает', () => {
    const withBb = all(['invoker', 'bristleback'], ['lion']);
    let checked = 0;
    for (const [h, s] of withBb) {
      const d = counterDelta(look, h, 'bristleback')!.delta;
      expect(s - base.get(h)!, h).toBeCloseTo(d, 3);
      if (d > 0) expect(s, h).toBeGreaterThanOrEqual(base.get(h)!);
      if (d < 0) expect(s, h).toBeLessThanOrEqual(base.get(h)!);
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('убрать врага = вычесть ровно его вклад', () => {
    const without = all([], ['lion']);
    for (const [h, s] of base) expect(s - without.get(h)!, h).toBeCloseTo(counterDelta(look, h, 'invoker')!.delta, 3);
  });

  it('матчапы симметричны: доля побед a против b и b против a в сумме ≈ 1, игр одинаково', () => {
    const byId = new Map(real.stats!.heroes.map((h) => [h.id, h]));
    let n = 0;
    for (const a of real.stats!.heroes)
      for (const [b, [g, w]] of Object.entries(a.matchups)) {
        const o = byId.get(Number(b))!.matchups[String(a.id)]!;
        expect(Math.abs(w + o[1] - 1)).toBeLessThanOrEqual(0.0011);
        expect(o[0]).toBe(g);
        n++;
      }
    expect(n).toBeGreaterThan(15_000);
  });
});

describe('драфт: посчитано вручную по сырым числам stats.json', () => {
  const look = new CoachLookup(real);
  const exp = Object.fromEntries(fixture.handChecked.map((h) => [h.id, h.expected])) as Record<string, unknown>;
  it('Viper против Bristleback: +4,95 п.п.', () => expect(counterDelta(look, 'viper', 'bristleback')!.delta).toBe(exp['viper-vs-bristleback']));
  it('Lion в связке с Viper: −0,3 п.п.', () => expect(synergyDelta(look, 'lion', 'viper')!.delta).toBe(exp['lion-with-viper']));
  it('Axe: сила в патче +0,14 п.п., против Chen +1,25 п.п.', () => {
    const e = exp['axe-meta-and-vs-chen'] as { meta: number; vsChen: number };
    const ax = suggestHeroes(look, { allies: [], enemies: ['chen'], limit: 500 }).find((c) => c.hero === 'axe')!;
    expect(ax.meta).toBe(e.meta);
    expect(counterDelta(look, 'axe', 'chen')!.delta).toBe(e.vsChen);
    expect(ax.score).toBe(Math.round((e.meta + e.vsChen) * 10000) / 10000);
  });
});

describe('угрозы: предметы по роли и невидимость из базы знаний', () => {
  const look = new CoachLookup(real);
  it('каждый совет — предмет своей роли (или общий)', () => {
    for (const id of Object.keys(THREATS)) {
      const t = enemyThreats(Object.keys(HERO_THREATS).filter((h) => HERO_THREATS[h]!.includes(id as never)));
      for (const role of ['core', 'support'] as const) for (const s of counterItems(t, role)) {
        const it = THREATS[s.threat].items.find((i) => i.key === s.key)!;
        expect([role, 'any'], `${id}/${role}: ${s.key}`).toContain(it.role);
      }
    }
  });

  it('герои, которые по описанию способности «становятся невидимыми», отмечены невидимостью', () => {
    for (const k of ['riki', 'mirana', 'sand_king', 'nyx_assassin', 'templar_assassin', 'clinkz', 'bounty_hunter', 'invoker', 'hoodwink', 'kez'])
      expect(look.invisHeroes.has(k), k).toBe(true);
    // раскрывают невидимость, а не дают её
    for (const k of ['zuus', 'slardar', 'drow_ranger', 'bloodseeker', 'ringmaster']) expect(look.invisHeroes.has(k), k).toBe(false);
    expect(enemyThreats(['kez'], look.invisHeroes).map((t) => t.threat.id)).toContain('invis');
  });
});
