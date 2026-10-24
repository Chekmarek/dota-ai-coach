// Движок подсказок в main: настройки (выключено, категории, подробность), карточки для окна поверх игры,
// «История советов» (файл на матч, разборы, ошибки, обрезка старых).
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CoachService } from '../../src/main/coach/service';
import { HistoryStore, MAX_FILES } from '../../src/main/coach/history';
import { defaultSettings, applySettingsPatch, type Settings } from '../../src/shared/schemas/settings';
import { hudHintSchema, type HudFocus, type HudHint } from '../../src/shared/types/hud';
import type { HistoryMatch } from '../../src/shared/types/history';
import { parseCoachInput } from '../../src/shared/types/coach-input';
import { realData, sim, type SimInput } from './coach-sim';

const data = realData();
const kb = {
  get: () => ({ meta: { patch: '7.41f', verification: 'imported-unverified' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics }) as never,
  stats: () => data.stats,
};

function make(settings: Settings, history = { saved: [] as HistoryMatch[], save(m: HistoryMatch) { this.saved.push(structuredClone(m)); } }) {
  let now = 0;
  const out: { hints: HudHint[]; inMatch: boolean }[] = [];
  const svc = new CoachService({ settings: { get: () => settings }, kb, aiProvider: () => null, history, onHints: (hints, inMatch) => out.push({ hints, inMatch }), now: () => now });
  const feed = (t: number, i: Partial<SimInput>) => {
    now = 1_000_000 + t * 1000;
    const s = sim({ wallMs: now, clock: 600 + t, ...i });
    svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
  };
  return { svc, out, feed, history };
}

// Опасность, о которой предупреждает и модель опасности (она заменила правила о риске): мало здоровья, двое врагов
// вплотную, третий пропал. Раньше было «трое пропали» — на такой обстановке модель риска смерти за 15 с не видит
const danger = (t: number): Partial<SimInput> => ({
  pos: { x: 3000, y: 2500 },
  hp: 200,
  items: [{ slot: 'inv1', key: 'boots' }],
  enemies: [...[5, 6].map((slot) => ({ slot, hero: 'axe', pos: { x: 3400, y: 2600 } })), { slot: 7, hero: 'axe', pos: null, missingForSec: 10 + t }],
});

describe('CoachService', () => {
  it('подсказки → карточки окна поверх игры (проходят схему), матч идёт', () => {
    const { out, feed } = make(defaultSettings());
    for (let t = 0; t < 5; t++) feed(t, danger(t));
    const last = out[out.length - 1]!;
    expect(last.inMatch).toBe(true);
    expect(last.hints.length).toBeGreaterThan(0);
    for (const h of last.hints) expect(hudHintSchema.safeParse(h).success).toBe(true);
    expect(last.hints.some((h) => h.priority === 'critical' && h.zone === 'alert')).toBe(true);
  });

  it('подсказки выключены — пусто', () => {
    const { out, feed } = make(applySettingsPatch(defaultSettings(), { hints: { enabled: false } }));
    for (let t = 0; t < 5; t++) feed(t, danger(t));
    expect(out.every((o) => o.hints.length === 0)).toBe(true);
  });

  it('категория выключена — её подсказок нет', () => {
    const s = defaultSettings();
    const { out, feed } = make(applySettingsPatch(s, { hints: { categories: { ...s.hints.categories, danger: false } } }));
    for (let t = 0; t < 5; t++) feed(t, danger(t));
    expect(out.flatMap((o) => o.hints).some((h) => h.category === 'danger')).toBe(false);
  });

  // Подробность в старой подаче (фильтр внимания выключен); с фильтром — тесты ниже
  it('подробность «Минимум» — только короткая фраза, без текста и факторов', () => {
    const { out, feed } = make(applySettingsPatch(defaultSettings(), { hints: { detail: 'min' }, gate: { enabled: false } }));
    for (let t = 0; t < 5; t++) feed(t, { enemies: [{ slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 }, hpPercent: 30, barLevel: 6 }] });
    const all = out.flatMap((o) => o.hints);
    expect(all.length).toBeGreaterThan(0);
    for (const h of all) {
      expect(h.text).toBe('');
      expect(h.percent?.factors ?? []).toEqual([]);
    }
  });

  it('«Подробно» — у процентов есть факторы', () => {
    const { out, feed } = make(applySettingsPatch(defaultSettings(), { hints: { detail: 'detailed' }, gate: { enabled: false } }));
    for (let t = 0; t < 5; t++) feed(t, { enemies: [{ slot: 5, hero: 'axe', pos: { x: -3800, y: -3900 }, hpPercent: 30, barLevel: 6 }] });
    const pct = out.flatMap((o) => o.hints).find((h) => h.percent);
    expect(pct?.percent?.factors.length).toBeGreaterThan(0);
  });

  it('фокус матча: объявление на выборе героев, счётчик в матче, итог первым в разборе и в истории', () => {
    let now = 0;
    const out: HudHint[][] = [];
    const counters: (HudFocus | null)[] = [];
    const cues: string[] = [];
    const history = { saved: [] as HistoryMatch[], save(m: HistoryMatch) { this.saved.push(structuredClone(m)); }, recent: () => [] };
    const svc = new CoachService({ settings: { get: () => defaultSettings() }, kb, aiProvider: () => null, history, onHints: (h) => out.push(h), onFocus: (f) => counters.push(f), onSound: (c) => cues.push(c), now: () => now });
    const feed = (t: number, i: Partial<SimInput>) => {
      now = 1_000_000 + t * 1000;
      const s = sim({ wallMs: now, clock: 0, ...i });
      svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
    };
    for (let t = 0; t < 5; t++) feed(t, { clock: -60 + t, phase: 'pre-game' });
    expect(out.flat().some((h) => h.title === 'Фокус: меньше смертей до 10 мин')).toBe(true);
    expect(cues).toContain('focus');
    for (let t = 5; t < 90; t++) feed(t, { clock: t - 5, level: 3 });
    expect(counters.at(-1)).toEqual({ label: 'Смерти', progress: '0/1', state: 'pending' });
    // другой фокус — одной клавишей
    expect(svc.nextFocus()!.def.id).toBe('last-hits');
    expect(out.at(-1)!.some((h) => h.title === 'Фокус: добивания к 10:00')).toBe(true);
    for (let t = 90; t < 95; t++) feed(t, { clock: t - 5, level: 3, phase: 'post-game', winTeam: 'radiant' });
    const review = out.at(-1)!.find((h) => h.review?.kind === 'match')!;
    expect(review.review!.focusOnly).toBe(true);
    expect(review.review!.focus).toMatchObject({ title: 'Фокус: добивания к 10:00', achieved: false });
    expect(review.review!.why).toEqual([]);
    // через 10 с — обычный разбор под итогом фокуса
    now += 11_000;
    svc.refreshHud();
    const full = out.at(-1)!.find((h) => h.review?.kind === 'match')!;
    expect(full.review!.focusOnly).toBe(false);
    expect(full.review!.why.length).toBeGreaterThan(0);
    expect(counters.at(-1)).toBeNull();
    const m = history.saved.at(-1)!;
    expect(m.focus).toMatchObject({ id: 'last-hits', achieved: false });
    expect(m.focusMetrics!['deaths-early']).toBe(0);
  });

  it('фильтр внимания: срочное — коротко (≤ 3 слов) с причиной; «Минимум» — без строки; «не нужно» убирает тип', () => {
    const { svc, out, feed } = make(defaultSettings());
    for (let t = 0; t < 5; t++) feed(t, danger(t));
    const last = out[out.length - 1]!.hints;
    const crit = last.find((h) => h.priority === 'critical')!;
    expect(crit).toBeTruthy();
    expect(crit.title.split(/\s+/).length).toBeLessThanOrEqual(3);
    for (const h of last) expect(hudHintSchema.safeParse(h).success).toBe(true);
    const r = svc.muteLast();
    expect(r).not.toBeNull();
    expect(out[out.length - 1]!.hints.some((h) => h.title === r!.short)).toBe(false);
    expect(svc.gateDebug()!.muted).toContain(r!.type);
    const min = make(applySettingsPatch(defaultSettings(), { hints: { detail: 'min' } }));
    for (let t = 0; t < 5; t++) min.feed(t, danger(t));
    for (const h of min.out.flatMap((o) => o.hints)) if (!h.review) expect(h.text).toBe('');
  });

  it('история: смерть с разбором, ошибки, итог матча — в одном файле матча', () => {
    const { feed, history } = make(defaultSettings());
    const near = (slot: number) => ({ slot, hero: 'axe', pos: { x: 2900, y: 2500 } });
    for (let t = 0; t < 80; t++) {
      if (t < 8) feed(t, { pos: { x: 3000, y: 2500 }, level: 12, hp: 1000 - t * 120, enemies: [near(5), near(6), { slot: 7, hero: 'lion', pos: null, missingForSec: 20 }, { slot: 8, hero: 'pudge', pos: null, missingForSec: 20 }] });
      else if (t < 40) feed(t, { pos: { x: 3000, y: 2500 }, level: 12, alive: false, respawnSec: 40 - t, enemies: [near(5), near(6)] });
      else if (t < 75) feed(t, { level: 12 });
      else feed(t, { level: 12, phase: 'post-game', winTeam: 'radiant' });
    }
    const m = history.saved[history.saved.length - 1]!;
    expect(m.matchId).toBe('123');
    expect(m.deathReviews.length).toBe(1);
    expect(m.mistakes.some((x) => x.type === 'died-unused')).toBe(true);
    expect(m.matchReview?.result).toBe('win');
    expect(m.result).toBe('win');
    expect(m.entries.some((e) => e.kind === 'hint')).toBe(true);
    expect(/^[0-9A-Za-z_-]+$/.test(m.id)).toBe(true);
  });

  it('история: обмен героем в начале матча — записан герой, которым играли (было: Kez вместо Ogre Magi)', () => {
    const history = { saved: [] as HistoryMatch[], save(m: HistoryMatch) { this.saved.push(structuredClone(m)); } };
    let now = 0;
    const svc = new CoachService({ settings: { get: () => defaultSettings() }, kb, aiProvider: () => null, history, onHints: () => {}, now: () => now });
    for (let t = 0; t < 40; t++) {
      now = 1_000_000 + t * 1000;
      // до −0:45 — Kez (выбран первым), потом обмен с другом — Ogre Magi
      const s = sim({ wallMs: now, clock: -55 + t, phase: t < 30 ? 'pre-game' : 'in-progress', heroKey: t < 10 ? 'kez' : 'ogre_magi' });
      s.gsi!.hero.name = t < 10 ? 'Kez' : 'Ogre Magi';
      s.gsi!.gameState = t < 30 ? 'DOTA_GAMERULES_STATE_PRE_GAME' : 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS';
      svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
    }
    svc.flush();
    expect(history.saved[history.saved.length - 1]!.heroName).toBe('Ogre Magi');
  });

  it('история: режим игры записывается; «неизвестен» не затирает известный; ручной выбор важнее', () => {
    const turbo = { mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' } as const;
    const a = make(defaultSettings());
    for (let t = 0; t < 40; t++) a.feed(t, { level: 5, mode: t < 20 ? turbo : undefined });
    a.svc.flush();
    expect(a.history.saved.at(-1)!.gameMode).toEqual(turbo);
    const manual = make(applySettingsPatch(defaultSettings(), { hints: { gameMode: 'normal' } }));
    for (let t = 0; t < 5; t++) manual.feed(t, { level: 5, mode: turbo });
    manual.svc.flush();
    expect(manual.history.saved.at(-1)!.gameMode).toEqual({ mode: 'all-pick', source: 'manual', raw: 'DOTA_GAMEMODE_TURBO' });
    // мусор вместо режима от окна движка — «неизвестен»
    const junk = make(defaultSettings());
    for (let t = 0; t < 5; t++) junk.feed(t, { level: 5, mode: { mode: 'hyper', source: 'gsi', raw: null } as never });
    junk.svc.flush();
    expect(junk.history.saved.at(-1)!.gameMode).toEqual({ mode: 'unknown', source: 'none', raw: null });
  });

  it('индикатор режима: в начале матча один раз; смена режима — после 1,5 с без мигания; ручной выбор — новый показ', () => {
    const turbo = { mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' } as const;
    let settings = defaultSettings();
    const banners: { title: string; mode: string; source: string; seq: number }[] = [];
    let now = 0;
    const history = { save() {} };
    const svc = new CoachService({ settings: { get: () => settings }, kb, aiProvider: () => null, history, onHints: () => {}, onModeBanner: (b) => banners.push(b), now: () => now });
    const feed = (t: number, i: Partial<SimInput>) => {
      now = 1_000_000 + t * 500;
      const s = sim({ wallMs: now, clock: 600 + t, level: 5, ...i });
      svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
    };
    for (let t = 0; t < 10; t++) feed(t, { mode: turbo });
    expect(banners.map((b) => [b.title, b.source])).toEqual([['Турбо', 'gsi']]);
    // одно чтение «неизвестен» (мигание) — не объявляется
    feed(10, {});
    for (let t = 11; t < 14; t++) feed(t, { mode: turbo });
    expect(banners.length).toBe(1);
    // ручной выбор «обычный» — держится 1,5 с → новый показ
    settings = applySettingsPatch(settings, { hints: { gameMode: 'normal' } });
    for (let t = 14; t < 20; t++) feed(t, { mode: turbo });
    expect(banners.map((b) => b.title)).toEqual(['Турбо', 'Обычный режим']);
    expect(banners[1]!.seq).toBeGreaterThan(banners[0]!.seq);
  });

  it('индикатор режима: без матча (меню) не показывается; неизвестный режим — «Режим не определён»', () => {
    const banners: string[] = [];
    let now = 0;
    const svc = new CoachService({ settings: { get: () => defaultSettings() }, kb, aiProvider: () => null, history: { save() {} }, onHints: () => {}, onModeBanner: (b) => banners.push(b.title), now: () => now });
    // меню: нет GSI, часов матча на экране нет (до −1:30 — тоже не матч)
    const s0 = sim({ wallMs: 1, clock: -200, noGsi: true });
    svc.ingest({ state: s0.state, gsi: s0.gsi, gsiWallMs: null });
    expect(banners).toEqual([]);
    now = 1000;
    const s1 = sim({ wallMs: 1000, clock: 600, level: 5 });
    svc.ingest({ state: s1.state, gsi: s1.gsi, gsiWallMs: 1000 });
    expect(banners).toEqual(['Режим не определён']);
  });

  it('режим не определён 2 минуты — подсказка выбрать его вручную (один раз за матч)', () => {
    const banners: { title: string; text: string }[] = [];
    let now = 0;
    const svc = new CoachService({ settings: { get: () => defaultSettings() }, kb, aiProvider: () => null, history: { save() {} }, onHints: () => {}, onModeBanner: (b) => banners.push(b), now: () => now });
    for (let t = 0; t <= 260; t += 2) {
      now = 1_000_000 + t * 1000;
      const s = sim({ wallMs: now, clock: 300 + t, level: 5 });
      svc.ingest({ state: s.state, gsi: s.gsi, gsiWallMs: now });
      if (t === 100) expect(banners.length).toBe(1);
    }
    expect(banners.length).toBe(2);
    expect(banners[1]!.text).toMatch(/настройках коуча/);
  });

  it('вход движка: мусор и чужая форма отклоняются', () => {
    expect(parseCoachInput(null)).toBeNull();
    expect(parseCoachInput({ state: { wallMs: 'x' } })).toBeNull();
    const s = sim({ wallMs: 1, clock: 1 });
    expect(parseCoachInput(JSON.parse(JSON.stringify({ state: s.state, gsi: s.gsi, gsiWallMs: 1 })))).not.toBeNull();
  });
});

describe('HistoryStore', () => {
  const match = (id: string): HistoryMatch => ({ id, startedAt: '2026-10-16T10:00:00.000Z', matchId: '1', heroName: 'Anti-Mage', result: 'win', durationSec: 2000, entries: [{ wallMs: 1, clock: 5, kind: 'hint', id: 'x', text: 'Руна силы через 15 с', source: 'template' }], mistakes: [], deathReviews: [], matchReview: null });

  it('сохраняет, читает список и матч; опасные id не принимает', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-hist-'));
    const h = new HistoryStore(dir);
    h.save(match('2026-10-16T10-00-00-000Z-1'));
    h.save(match('../evil'));
    expect(h.list().map((x) => x.id)).toEqual(['2026-10-16T10-00-00-000Z-1']);
    expect(h.list()[0]!.hints).toBe(1);
    expect(h.get('2026-10-16T10-00-00-000Z-1')?.heroName).toBe('Anti-Mage');
    expect(h.get('../evil')).toBeNull();
  });
  it('старый файл матча без режима читается; в списке режим — null', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-hist-'));
    const h = new HistoryStore(dir);
    h.save(match('old'));
    h.save({ ...match('new'), startedAt: '2026-10-17T10:00:00.000Z', gameMode: { mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' } });
    const byId = Object.fromEntries(h.list().map((x) => [x.id, x.gameMode]));
    expect(byId).toEqual({ old: null, new: { mode: 'turbo', source: 'gsi', raw: 'DOTA_GAMEMODE_TURBO' } });
    expect(h.get('old')?.gameMode).toBeUndefined();
  });

  it(`хранит не больше ${MAX_FILES} матчей`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-hist-'));
    const h = new HistoryStore(dir);
    for (let i = 0; i < MAX_FILES + 5; i++) h.save(match(`m${String(i).padStart(3, '0')}`));
    expect(readdirSync(join(dir, 'history')).length).toBe(MAX_FILES);
    expect(h.list()[0]!.id).toBe(`m${String(MAX_FILES + 4).padStart(3, '0')}`);
  });
});
