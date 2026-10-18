// Ошибки, замеченные владельцем в живом матче Турбо 2026-10-18 (Bristleback, tests/fixtures/gsi/recorded/turbo-bristleback.jsonl):
// число врагов рядом, процент «вступать», разбор смерти (готовый предмет, пассивная ульта), текст про выкуп.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildView } from '../../src/core/coach/view.ts';
import { CoachLookup } from '../../src/core/coach/data.ts';
import { CoachMemory, nearEnemyCount, readyActives } from '../../src/core/coach/memory.ts';
import { engagePercent } from '../../src/core/coach/prob.ts';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { GameModeTracker, mapGsi, type GsiReading } from '../../src/core/gsi/index.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

const data = realData();
const look = new CoachLookup(data);
const T0 = 1_000_000;

/** Снимок с полосками на экране: своя (камера у героя) и вражеские без привязки к герою */
function withBars(i: Partial<SimInput>, enemyBars: { hp: number; level: number | null }[], meOnScreen = true) {
  const s = sim({ wallMs: T0, clock: 98, ...i });
  const mySlot = s.gsi!.slot!;
  s.state.healthBars = [
    ...(meOnScreen ? [{ team: 'radiant' as const, side: 'ally' as const, hpPercent: 80, level: 6, slot: mySlot, x: 900, y: 500, confidence: 0.9 }] : []),
    ...enemyBars.map((b, n) => ({ team: 'dire' as const, side: 'enemy' as const, hpPercent: b.hp, level: b.level, slot: null, x: 1000 + n * 120, y: 480, confidence: 0.8 })),
  ];
  return buildView(s.state, s.gsi, T0);
}

describe('1. подсчёт врагов рядом', () => {
  it('2 врага рядом: на мини-карте один значок (слились), на экране 2 полоски → коуч видит 2', () => {
    const v = withBars({ pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }, [{ hp: 90, level: 6 }, { hp: 80, level: 5 }]);
    expect(v.enemies.filter((e) => e.pos.value).length).toBe(1);
    expect(nearEnemyCount(v)).toBe(2);
  });
  it('камера не у героя (своей полоски на кадре нет) — полоски врагов не считаются «рядом»', () => {
    const v = withBars({ pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }, [{ hp: 90, level: 6 }, { hp: 80, level: 5 }], false);
    expect(nearEnemyCount(v)).toBe(1);
  });
  it('подсказка «Вступать» называет 2 врагов', () => {
    const e = new CoachEngine({ data, now: () => T0 });
    const s = sim({ wallMs: T0, clock: 98, pos: { x: 0, y: 0 }, level: 6, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] });
    s.state.healthBars = [
      { team: 'radiant', side: 'ally', hpPercent: 100, level: 6, slot: s.gsi!.slot!, x: 900, y: 500, confidence: 0.9 },
      { team: 'dire', side: 'enemy', hpPercent: 30, level: 4, slot: null, x: 1000, y: 480, confidence: 0.8 },
      { team: 'dire', side: 'enemy', hpPercent: 30, level: 4, slot: null, x: 1150, y: 480, confidence: 0.8 },
    ];
    const u = e.tick(s.state, s.gsi, T0);
    const h = u.shown.find((x) => x.id === 'fight.engage');
    expect(h, 'подсказка «Вступать» показана').toBeDefined();
    expect(JSON.stringify(h)).toContain('2 врага рядом');
  });
});

describe('2. процент победы в драке', () => {
  const pct = (v: ReturnType<typeof withBars>) => engagePercent(v, new CoachMemory(), look, 0);
  it('у врага больше здоровья и уровень (1×1) → шанс ниже 50%', () => {
    const v = withBars({ pos: { x: 0, y: 0 }, level: 6, hp: 500, maxHp: 1000, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }, [{ hp: 95, level: 9 }]);
    const e = pct(v);
    expect(e.value).toBeLessThan(50);
    expect(e.factors.find((f) => f.id === 'level')!.effect).toBeLessThan(0);
  });
  it('вы сильнее (больше здоровья и уровень) → шанс выше 50%', () => {
    const v = withBars({ pos: { x: 0, y: 0 }, level: 9, hp: 950, maxHp: 1000, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }, [{ hp: 40, level: 6 }]);
    expect(pct(v).value).toBeGreaterThan(50);
  });
  it('2 врага против одного — шанс ниже, чем против одного', () => {
    const one = withBars({ pos: { x: 0, y: 0 }, level: 8, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }, [{ hp: 80, level: 8 }]);
    const two = withBars({ pos: { x: 0, y: 0 }, level: 8, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }, [{ hp: 80, level: 8 }, { hp: 80, level: 8 }]);
    expect(pct(two).value).toBeLessThan(pct(one).value);
  });
  it('враг рядом, а его здоровья и уровня не видно — процент не показывается (а не «80%» по своим факторам)', () => {
    const v = withBars({ pos: { x: 0, y: 0 }, level: 9, hp: 1000, maxHp: 1000, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] }, [], false);
    expect(pct(v).showable).toBe(false);
  });
});

describe('3. разбор смерти: готовое и не нажатое', () => {
  const BB = { slot: 'inv2', key: 'blade_mail', cooldownSec: 0, passive: false, canCast: true };
  const passiveUlt = [
    { key: 'bristleback_viscous_nasal_goo', level: 4, maxCooldownSec: 2 },
    { key: 'bristleback_bristleback', level: 4, passive: true },
    { key: 'bristleback_warpath', level: 3, ultimate: true, passive: true },
  ];
  /** Матч: 5 с здоровье падает, затем смерть; предметы и способности — в момент перед смертью */
  function dieWith(items: SimInput['items'], abilities: SimInput['abilities']) {
    const e = new CoachEngine({ data, now: () => 0 });
    for (let t = 0; t < 8; t++) {
      const w = T0 + t * 1000;
      const s = sim({ wallMs: w, clock: 1660 + t, heroKey: 'bristleback', level: 25, hp: Math.max(0, 5000 - t * 700), maxHp: 5034, alive: t < 7, items, abilities, enemies: [{ slot: 5, hero: 'lina', pos: { x: 200, y: 0 } }], pos: { x: 0, y: 0 } });
      e.tick(s.state, s.gsi, w);
    }
    return e;
  }
  it('умер, Blade Mail готов и не нажат → в разборе смерти он назван первым; пассивная ульта не упоминается', () => {
    const e = dieWith([BB, { slot: 'inv1', key: 'heart', passive: true }], passiveUlt);
    const r = e.deathReviewNow!;
    expect(r).not.toBeNull();
    expect(r.why[0]).toBe('Blade Mail был готов, но не использован');
    const m = e.mistakes.list.find((x) => x.type === 'died-unused')!;
    expect(m.text).toContain('Blade Mail');
    expect(m.text).not.toContain('ульта');
    expect(JSON.stringify(r)).not.toMatch(/Warpath|ульта/);
  });
  it('Blade Mail на перезарядке (нажат раньше) — «не использован» не пишется', () => {
    const e = dieWith([{ ...BB, cooldownSec: 13, canCast: false }], passiveUlt);
    expect(e.deathReviewNow!.why.join(' ')).not.toContain('Blade Mail');
    expect(e.mistakes.list.some((x) => x.type === 'died-unused')).toBe(false);
  });
  it('готовность — по данным игры: пассивные предметы, Power Treads и короткие способности не считаются', () => {
    const s = sim({ wallMs: T0, clock: 600, heroKey: 'bristleback', items: [BB, { slot: 'inv1', key: 'heart', passive: true }, { slot: 'inv3', key: 'power_treads', passive: false, canCast: true }], abilities: passiveUlt });
    expect(readyActives(buildView(s.state, s.gsi, T0))).toEqual([{ kind: 'item', key: 'blade_mail' }]);
  });
});

describe('3. на настоящей записи матча', () => {
  // В настоящем матче (27:54) Blade Mail был нажат ~27:28 и всю финальную драку стоял на перезарядке:
  // простая проверка «готов и не нажат» его не называет — и не должна. А «не применив: ульта» (Warpath — пассивная) пропало.
  it('ни в одном разборе смерти нет «ульты» у Bristleback', () => {
    const entries = readFileSync(join(import.meta.dirname, '../fixtures/gsi/recorded/turbo-bristleback.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { t: number; body: unknown });
    const tracker = new GameModeTracker();
    const model = new MatchStateModel();
    let now = 0;
    const engine = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), gameMode: 'auto' } });
    let last: GsiReading | null = null;
    let lastMs: number | null = null;
    for (const e of entries) {
      now = e.t;
      const mode = tracker.feed(e.body, e.t);
      const r = mapGsi(e.body);
      if (r) {
        model.ingestGsi({ ...r, gameMode: mode }, e.t);
        last = r;
        lastMs = e.t;
      }
      engine.tick(model.snapshot(e.t), last, lastMs);
    }
    const unused = engine.mistakes.list.filter((m) => m.type === 'died-unused').map((m) => m.text);
    expect(unused.join(' | ')).not.toContain('ульта');
  });
});

describe('4. выкуп: цена выкупа и золото, а не одна недостача', () => {
  it('подсказка в драке: «Выкуп 4370, у вас 79» (числа из настоящего матча, 25:00)', () => {
    const e = new CoachEngine({ data, now: () => T0 });
    const s = sim({ wallMs: T0, clock: 1500, gold: 79, pos: { x: 0, y: 0 }, enemies: [{ slot: 5, hero: 'lina', pos: { x: 300, y: 0 } }] });
    s.gsi!.extra!.buybackCost = 4370;
    const u = e.tick(s.state, s.gsi, T0);
    const h = u.shown.find((x) => x.id === 'fight.no-buyback');
    expect(h).toBeDefined();
    expect(JSON.stringify(h)).toContain('Выкуп 4370, у вас 79');
  });
});

describe('5. язык: всё по-русски, предметы — как в клиенте Dota', () => {
  it('английская фраза в ответе ИИ — непроверенный текст (покажется шаблон по-русски)', async () => {
    const { checkGrounding } = await import('../../src/core/ai/grounding.ts');
    expect(checkGrounding('Farm the jungle now', ['Свой герой: Bristleback']).ok).toBe(false);
    expect(checkGrounding('Фармите лес Сил Тьмы', ['Свой герой: Bristleback']).ok).toBe(true);
    // название предмета из фактов — как в клиенте, это не «английский ответ»
    expect(checkGrounding('Купите Smoke of Deceit', ['Предмет: Smoke of Deceit']).ok).toBe(true);
  });
  it('в текстах подсказок нет сленга вместо названий предметов (ТП, фласка, танго, смок, BKB)', async () => {
    const { readdirSync, readFileSync: read } = await import('node:fs');
    const dir = join(import.meta.dirname, '../../src/core/coach');
    const files = [...readdirSync(dir).filter((f) => f.endsWith('.ts')).map((f) => join(dir, f)), ...readdirSync(join(dir, 'rules')).map((f) => join(dir, 'rules', f))];
    const bad: string[] = [];
    for (const f of files) {
      for (const line of read(f, 'utf8').split(/\r?\n/)) {
        const strings = line.match(/(['`])(?:(?!\1).)*\1/g) ?? [];
        for (const s of strings) if (/\bТП\b|[Фф]ласк|[Тт]анго|[Сс]мок\b|\bBKB\b|кларити|манго/.test(s)) bad.push(`${f.split(/[\\/]/).pop()}: ${s}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('8. подсказки только в своём матче и только когда Дота активна', () => {
  const kb = {
    get: () => ({ meta: { patch: '7.41f', verification: 'imported-unverified' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics }) as never,
    stats: () => data.stats,
  };
  async function service() {
    const { CoachService } = await import('../../src/main/coach/service');
    const { defaultSettings } = await import('../../src/shared/schemas/settings');
    let now = T0;
    const out: { n: number; inMatch: boolean }[] = [];
    const svc = new CoachService({ settings: { get: () => defaultSettings() }, kb, aiProvider: () => null, history: { save() {} }, onHints: (h, inMatch) => out.push({ n: h.length, inMatch }), now: () => now });
    return { svc, out, at: (t: number) => (now = t) };
  }
  it('Дота открыта, матча нет (GSI молчит, часы на экране давно не видны) → подсказок нет', async () => {
    const { svc, out, at } = await service();
    // минуту назад был матч (часы 17:46), теперь меню: часы последний раз видели 60 с назад
    for (let t = 0; t < 20; t++) {
      const w = T0 + 60_000 + t * 1000;
      at(w);
      const s = sim({ wallMs: w, clock: 1066 + 60 + t, noGsi: true });
      s.state.match.clock = { ...s.state.match.clock, lastSeenWallMs: T0, tag: 'inferred' };
      s.state.sources = { gsi: false, screen: false };
      svc.ingest({ state: s.state, gsi: null, gsiWallMs: null });
    }
    expect(out.every((o) => o.n === 0 && !o.inMatch)).toBe(true);
  });
  it('после конца матча (последнее чтение GSI — POST_GAME) → подсказок о рунах нет', async () => {
    const { svc, out, at } = await service();
    const ended = sim({ wallMs: T0, clock: 1784, phase: 'post-game', winTeam: 'radiant' });
    for (let t = 0; t < 30; t++) {
      const w = T0 + 10_000 + t * 1000;
      at(w);
      const s = sim({ wallMs: w, clock: 1794 + t, noGsi: true });
      s.state.sources = { gsi: false, screen: true };
      svc.ingest({ state: s.state, gsi: ended.gsi, gsiWallMs: T0 });
    }
    expect(out.filter((o) => o.inMatch)).toEqual([]);
  });
  it('чужой матч (GSI наблюдателя, своего героя нет) → подсказок нет', async () => {
    const { svc, out, at } = await service();
    for (let t = 0; t < 10; t++) {
      const w = T0 + t * 1000;
      at(w);
      const s = sim({ wallMs: w, clock: 100 + t, noGsi: true });
      svc.ingest({ state: s.state, gsi: null, gsiWallMs: null, notOwnMatch: true });
    }
    expect(out.every((o) => o.n === 0 && !o.inMatch)).toBe(true);
  });
  it('матч идёт, но активно другое окно (или Дота свёрнута) → оверлей не показывается; вернулись — показывается', async () => {
    const { hudShouldShow } = await import('../../src/main/live/window-rect');
    const dota = { x: 0, y: 0, width: 1920, height: 1080, minimized: false };
    const base = { enabled: true, hasContent: true, demo: false };
    expect(hudShouldShow({ ...base, rect: { ...dota, active: false } })).toBe(false);
    expect(hudShouldShow({ ...base, rect: { ...dota, minimized: true, active: false } })).toBe(false);
    expect(hudShouldShow({ ...base, rect: { ...dota, active: true } })).toBe(true);
    // положение окна не известно (не Windows / PowerShell запрещён) — как раньше, показываем
    expect(hudShouldShow({ ...base, rect: null })).toBe(true);
    // демо из «Предпросмотра» включают из окна коуча — показывается, хотя Дота не активна
    expect(hudShouldShow({ ...base, demo: true, rect: { ...dota, active: false } })).toBe(true);
    expect(hudShouldShow({ ...base, hasContent: false, rect: { ...dota, active: true } })).toBe(false);
  });
  it('таймеры — от часов матча: Руна богатства в настоящем матче — за 15 с до 0:00 и каждые 4 мин игрового времени', () => {
    const entries = readFileSync(join(import.meta.dirname, '../fixtures/gsi/recorded/turbo-bristleback.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l) as { t: number; body: unknown });
    const tracker = new GameModeTracker();
    const model = new MatchStateModel();
    let now = 0;
    const engine = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), gameMode: 'auto' } });
    let last: GsiReading | null = null;
    let lastMs: number | null = null;
    for (const e of entries) {
      now = e.t;
      const mode = tracker.feed(e.body, e.t);
      const r = mapGsi(e.body);
      if (r) {
        model.ingestGsi({ ...r, gameMode: mode }, e.t);
        last = r;
        lastMs = e.t;
      }
      engine.tick(model.snapshot(e.t), last, lastMs);
    }
    const runes = engine.journal.filter((j) => j.id === 'timing.rune-bounty').map((j) => j.clock!);
    expect(runes.length).toBeGreaterThan(3);
    for (const c of runes) expect(Math.ceil(c / 240) * 240 - c, `подсказка в ${c} с`).toBeLessThanOrEqual(16);
  });
});

describe('7. предметы: что купить дальше и что лишнее', () => {
  const ctx = async (i: Partial<SimInput>, turbo = false) => {
    const { CoachLookup: L } = await import('../../src/core/coach/data.ts');
    const s = sim({ wallMs: T0, ...i } as SimInput);
    const v = buildView(s.state, s.gsi, T0);
    const look = new L(data);
    if (turbo) look.setMode({ mode: 'turbo', source: 'clock', raw: 'start -1:00' });
    const mem = new CoachMemory();
    return { v, mem, ev: mem.ingest(v, 1800), look, settings: defaultCoachSettings(), now: T0 };
  };
  it('ранний дешёвый предмет, время которого прошло, не советуется (Soul Ring на 18-й минуте Турбо)', async () => {
    const { nextItem } = await import('../../src/core/coach/rules/economy.ts');
    const c = await ctx({ clock: 18 * 60, heroKey: 'bristleback', heroId: 99, items: [{ slot: 'inv1', key: 'power_treads' }, { slot: 'inv2', key: 'blade_mail' }] }, true);
    const n = nextItem(c as never);
    expect(n?.key).not.toBe('soul_ring');
    if (n) expect((c.look.itemCost(n.key) ?? 0) >= 1500 || n.medianMin * 0.5 + 6 >= 18).toBe(true);
  });
  it('после покупки не из сборки профи тоже есть совет «Дальше: …»', () => {
    let now = T0;
    const e = new CoachEngine({ data, now: () => now });
    const base = { heroKey: 'bristleback', heroId: 99 } as const;
    // «Нет Town Portal Scroll» (0 с) и «Простой» (20 с) занимают очередь экономики — совет ждёт и выходит в 40 с
    for (let t = 0; t < 50; t++) {
      now = T0 + t * 1000;
      // Consecrated Wraps — не из сборки профи Bristleback (там Bracer, Soul Ring, Raindrop, Power Treads);
      // Bracer (к 2,5 мин) на 10-й минуте уже не советуется — следующий Soul Ring
      const items = t < 2 ? [{ slot: 'inv1', key: 'power_treads' }] : [{ slot: 'inv1', key: 'power_treads' }, { slot: 'inv2', key: 'consecrated_wraps' }];
      const s = sim({ wallMs: T0 + t * 1000, ...base, clock: 600 + t, items });
      e.tick(s.state, s.gsi, T0 + t * 1000);
    }
    expect(e.journal.find((j) => j.id.startsWith('economy.next:'))?.text, JSON.stringify(e.journal.map((j) => `${Math.round(j.clock ?? -1)} ${j.id}`)) + JSON.stringify(e.queue.dropped)).toBe('Дальше: Soul Ring');
  });
  it('лишнее в полном инвентаре: Bracer к 27-й минуте Турбо — «продайте»; в начале игры — молчит', async () => {
    const { sellRule } = await import('../../src/core/coach/rules/economy.ts');
    const full = [{ slot: 'inv1', key: 'consecrated_wraps' }, { slot: 'inv2', key: 'blade_mail' }, { slot: 'inv3', key: 'heart' }, { slot: 'inv4', key: 'power_treads' }, { slot: 'inv5', key: 'assault' }, { slot: 'inv6', key: 'bracer' }];
    const late = sellRule((await ctx({ clock: 27 * 60, heroKey: 'bristleback', items: full }, true)) as never);
    expect((late as { short?: string } | null)?.short).toBe('Лишнее: Bracer — продайте');
    expect(sellRule((await ctx({ clock: 5 * 60, heroKey: 'bristleback', items: full }, true)) as never)).toBeNull();
    // инвентарь не полон — ячейка не нужна, не советуем
    expect(sellRule((await ctx({ clock: 27 * 60, heroKey: 'bristleback', items: full.slice(3) }, true)) as never)).toBeNull();
  });
});

describe('6. аванпост', () => {
  it('координаты из файлов карты: два аванпоста, в пределах карты', async () => {
    const { OUTPOSTS } = await import('../../src/core/coach/rules/macro.ts');
    expect(OUTPOSTS.map((o) => o.id).sort()).toEqual(['npc_dota_watch_tower_bottom', 'npc_dota_watch_tower_top']);
    for (const o of OUTPOSTS) expect(Math.abs(o.x) < 8800 && Math.abs(o.y) < 8800).toBe(true);
  });
  it('Силы Тьмы у аванпоста на половине Сил Света, врагов рядом нет → «захватите»; враг рядом — молчит', async () => {
    const { outpostRule } = await import('../../src/core/coach/rules/macro.ts');
    const ctx = (enemies: SimInput['enemies'], team: 'radiant' | 'dire' = 'dire', pos = { x: -4000, y: -500 }) => {
      const s = sim({ wallMs: T0, clock: 900, team, pos, enemies });
      const v = buildView(s.state, s.gsi, T0);
      const mem = new CoachMemory();
      return { v, mem, ev: mem.ingest(v, 1800), look, settings: defaultCoachSettings(), now: T0 } as never;
    };
    const h = outpostRule(ctx([])) as { short: string; detail: { normal: string } } | null;
    expect(h?.short).toBe('Аванпост врага рядом — захватите');
    expect(h?.detail.normal).toContain('6 с');
    expect(outpostRule(ctx([{ slot: 0, hero: 'lina', pos: { x: -3900, y: -500 } }]))).toBeNull();
  });
  it('свой аванпост (на своей половине) — не зовёт захватывать (матч 9051402480: Силы Тьмы у аванпоста Сил Тьмы)', async () => {
    const { outpostRule } = await import('../../src/core/coach/rules/macro.ts');
    const at = (team: 'radiant' | 'dire', pos: { x: number; y: number }) => {
      const s = sim({ wallMs: T0, clock: 900, team, pos, enemies: [] });
      const v = buildView(s.state, s.gsi, T0);
      const mem = new CoachMemory();
      return outpostRule({ v, mem, ev: mem.ingest(v, 1800), look, settings: defaultCoachSettings(), now: T0 } as never);
    };
    expect(at('dire', { x: 2884, y: -542 })).toBeNull(); // как в 8:43 того матча
    expect(at('radiant', { x: -4000, y: -500 })).toBeNull();
    expect(at('radiant', { x: 3300, y: -450 })).not.toBeNull();
  });
  it('далеко от аванпостов — молчит', async () => {
    const { outpostRule } = await import('../../src/core/coach/rules/macro.ts');
    const s = sim({ wallMs: T0, clock: 900, pos: { x: 0, y: -6000 }, enemies: [] });
    const v = buildView(s.state, s.gsi, T0);
    const mem = new CoachMemory();
    expect(outpostRule({ v, mem, ev: mem.ingest(v, 1800), look, settings: defaultCoachSettings(), now: T0 } as never)).toBeNull();
  });
});
