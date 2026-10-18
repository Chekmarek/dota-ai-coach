// ИИ и режим игры: в фактах есть строка о режиме, в Турбо — тайминги Турбо; ответ, назвавший чужой режим, не проходит
// проверку (draft-check); проверка чисел и героев не ослаблена.
import { describe, expect, it } from 'vitest';
import { assembleFacts } from '../../src/core/ai/facts.ts';
import { checkDraftAnswer, factsAreTurbo, wrongModeWords } from '../../src/core/ai/draft-check.ts';
import { draftFacts } from '../../src/core/draft/index.ts';
import { realData, sim } from './coach-sim.ts';

const data = realData();
const kb = { meta: { patch: data.patch, verification: 'imported-unverified', generatedAt: '' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics } as never;
const TURBO = { mode: 'turbo', source: 'clock', raw: 'start -1:00' } as const;
// ИИ получает 6 ближайших событий: Святилище мудрости в Турбо — каждые 3:30 (10:30), в обычной игре — каждые 7:00 (14:00)
const at = (clock: number) => sim({ wallMs: 1_000_000, clock }).state;
const match = at(9 * 60 + 30);
const late = at(13 * 60 + 30);
const timers = (lines: string[]) => lines.find((l) => l.startsWith('Ближайшие события карты')) ?? '';

describe('факты для ИИ', () => {
  it('Турбо: строка о режиме первой, Святилище — в 10:30 (справочник Турбо)', () => {
    const f = assembleFacts({ page: 'live', question: 'когда мучитель?', match, kb, mode: TURBO, turbo: data.turbo });
    expect(f.lines[0]).toBe('Режим игры: Турбо — тайминги и награды Турбо (справочник Турбо)');
    expect(timers(f.lines)).toContain('Святилище мудрости — в 10:30');
    // факт механики по вопросу — тоже из справочника Турбо
    expect(f.lines.some((l) => /Мучитель/.test(l) && /Турбо/.test(l))).toBe(true);
  });
  it('обычный режим — Святилище в 14:00; режим неизвестен — так и сказано', () => {
    const n = assembleFacts({ page: 'live', match: late, kb, mode: { mode: 'all-pick', source: 'clock', raw: 'start -1:30' }, turbo: data.turbo });
    expect(timers(assembleFacts({ page: 'live', match, kb, mode: { mode: 'all-pick', source: 'clock', raw: 'start -1:30' } }).lines)).not.toContain('Святилище мудрости — в 10:30');
    expect(n.lines[0]).toBe('Режим игры: Обычный режим');
    expect(timers(n.lines)).toContain('Святилище мудрости — в 14:00');
    const u = assembleFacts({ page: 'live', match, kb, mode: { mode: 'unknown', source: 'none', raw: null }, turbo: data.turbo });
    expect(u.lines[0]).toBe('Режим игры: режим неизвестен — тайминги как в обычной игре');
  });
  it('без режима (запись, старые вызовы) — факты как раньше, без строки о режиме', () => {
    const f = assembleFacts({ page: 'replay', match: late, kb, replay: true });
    expect(f.lines.some((l) => l.startsWith('Режим игры'))).toBe(false);
    expect(timers(f.lines)).toContain('Святилище мудрости — в 14:00');
  });
});

describe('проверка ответа ИИ о драфте: режим', () => {
  const heroes = data.heroes.map((h) => ({ key: h.key, name: h.name }));
  const facts = (mode: 'normal' | 'turbo') =>
    draftFacts({
      candidates: [{ hero: 'slark', name: 'Slark', score: 0.057, vsEnemies: [{ hero: 'bristleback', delta: 0.057, games: 18702 }], withAllies: [], meta: 0, positions: [1], covered: 1 }],
      name: (k) => heroes.find((h) => h.key === k)?.name ?? k,
      enemies: ['bristleback'],
      allies: [],
      position: null,
      patch: '7.41f',
      statsAt: '2026-10-18T00:00:00Z',
      mode,
    });
  it('факты Турбо так и подписаны; обычные — как раньше', () => {
    expect(facts('turbo')[0]).toMatch(/^Источник: статистика публичных матчей Турбо/);
    expect(facts('normal')[0]).toMatch(/^Источник: статистика публичных матчей OpenDota, патч 7\.41f/);
    expect(factsAreTurbo(facts('turbo'))).toBe(true);
    expect(factsAreTurbo(facts('normal'))).toBe(false);
  });
  it('в Турбо «рейтинг» / «All Pick» / «обычная игра» — ошибка; в обычной — «Турбо»', () => {
    expect(wrongModeWords('В рейтинге Slark хорош', true)).toEqual(['рейтинге']);
    expect(wrongModeWords('В обычной игре и в All Pick', true)).toEqual(['обычной игре', 'All Pick']);
    expect(wrongModeWords('В Турбо берите Slark', false)).toEqual(['Турбо']);
    expect(wrongModeWords('В Турбо берите Slark', true)).toEqual([]);
  });
  it('годный ответ проходит, тот же с чужим режимом — нет; числа по-прежнему проверяются', () => {
    const ok = 'Берите Slark: против Bristleback +5,7% (18 702 игры).';
    const base = { heroes, allowedHeroes: ['slark', 'bristleback'], topHero: 'slark' };
    expect(checkDraftAnswer({ ...base, answer: ok, facts: facts('turbo') }).ok).toBe(true);
    const bad = checkDraftAnswer({ ...base, answer: 'В рейтинге берите Slark: против Bristleback +5,7% (18 702 игры).', facts: facts('turbo') });
    expect(bad.ok).toBe(false);
    expect(bad.wrongMode).toEqual(['рейтинге']);
    expect(checkDraftAnswer({ ...base, answer: 'В Турбо берите Slark: против Bristleback +5,7%.', facts: facts('normal') }).ok).toBe(false);
    expect(checkDraftAnswer({ ...base, answer: 'Берите Slark: против Bristleback +9,9%.', facts: facts('turbo') }).ok).toBe(false);
  });
});
