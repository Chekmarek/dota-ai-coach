import { describe, expect, it } from 'vitest';
import { CORRECTION_MS, EVENT_LIMIT, MatchStateModel, type MatchEventType } from '../../src/core/match-state/index.ts';
import type { HudReading } from '../../src/core/vision/recognize-hud.ts';
import type { AbilitySlot } from '../../src/core/vision/abilities.ts';
import type { ItemSlot } from '../../src/core/vision/items.ts';
import type { Observed, Validity } from '../../src/shared/types/observation.ts';

// ---------- построитель синтетических чтений HUD ----------

const CONF = 0.8; // ниже 0.9: значение принимается только после 2 из 3 чтений
const KEZ = { id: 145, name: 'Kez' };
const SF = { id: 11, name: 'Shadow Fiend' };
const AXE = { id: 2, name: 'Axe' };

function obs<T>(value: T | null | undefined, confidence = CONF, validity?: Validity): Observed<T> {
  const v = value ?? null;
  return {
    value: v,
    confidence: v === null ? 0 : confidence,
    observedAt: 0,
    sourceRegion: { layoutId: 'test', regionId: 'test', rect: { x: 0, y: 0, w: 0, h: 0 }, frameSize: { w: 1920, h: 1080 } },
    validity: validity ?? (v === null ? 'absent' : 'valid'),
    schemaVersion: '1',
    raw: '',
  };
}

interface Spec {
  conf?: number;
  clock?: number | null;
  scoreRadiant?: number;
  scoreDire?: number;
  gold?: number;
  health?: [number, number];
  mana?: [number, number];
  level?: number;
  kda?: [number, number, number];
  farm?: [number, number];
  unit?: 'ally' | 'enemy' | null;
  hero?: { id: number; name: string } | null;
  dayNight?: 'day' | 'night' | null;
  abilities?: AbilitySlot[] | null;
  items?: ItemSlot[] | null;
}

function reading(s: Spec = {}): HudReading {
  const c = s.conf ?? CONF;
  return {
    layoutId: 'test',
    frameSize: { w: 1920, h: 1080 },
    supported: true,
    fields: {
      gameClock: obs(s.clock, c),
      scoreRadiant: obs(s.scoreRadiant, c),
      scoreDire: obs(s.scoreDire, c),
      gold: obs(s.gold, c),
      health: obs(s.health && { current: s.health[0], max: s.health[1] }, c),
      mana: obs(s.mana && { current: s.mana[0], max: s.mana[1] }, c),
      level: obs(s.level, c),
      kda: obs(s.kda && { kills: s.kda[0], deaths: s.kda[1], assists: s.kda[2] }, c),
      farm: obs(s.farm && { lastHits: s.farm[0], denies: s.farm[1] }, c),
    },
    selectedUnit: obs(s.unit, 0.95),
    heroName: obs(s.hero, 0.9),
    dayNight: obs(s.dayNight, 0.9),
    abilities: s.abilities ?? null,
    items: s.items ?? null,
    heroNameCandidates: [],
    durationMs: 0,
  };
}

/** Своя панель: выбран свой герой (Kez) */
const me = (s: Spec = {}) => reading({ unit: 'ally', hero: KEZ, ...s });

const ability = (index: number, state: AbilitySlot['state'], level: number, cooldown: number | null = null): AbilitySlot => ({
  index,
  state,
  level,
  cooldown,
  confidence: 0.9,
});

function inventory(keys: (string | null)[]): ItemSlot[] {
  return keys.map((key, i) => ({
    slot: i < 6 ? `inv${i + 1}` : `bp${i - 5}`,
    item: key ? { key, name: key.toUpperCase() } : null,
    empty: key === null,
    distance: 0.1,
    confidence: 0.9,
  }));
}

/** Кормит модель одинаковыми чтениями каждые stepMs, возвращает время после последнего */
function feed(m: MatchStateModel, t: number, n: number, make: (i: number) => HudReading, stepMs = 100): number {
  for (let i = 0; i < n; i++) m.ingest(make(i), t + i * stepMs);
  return t + n * stepMs;
}

/** Определяет героя игрока: 8 чтений своей панели с именем Kez */
function lockKez(m: MatchStateModel, t = 0, extra: Spec = {}): number {
  return feed(m, t, 8, () => me(extra));
}

const types = (m: MatchStateModel, t: number) => m.snapshot(t).events.map((e) => e.type);

// ---------- тесты ----------

describe('стабилизация значений', () => {
  it('одно ошибочное чтение (мерцание) игнорируется', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    t = feed(m, t, 3, () => me({ gold: 500 }));
    expect(m.snapshot(t).hero.gold.value).toBe(500);
    m.ingest(me({ gold: 800 }), t);
    m.ingest(me({ gold: 500 }), t + 100);
    m.ingest(me({ gold: 900 }), t + 200);
    expect(m.snapshot(t + 200).hero.gold.value).toBe(500);
  });

  it('новое значение принимается по 2 из 3 последних чтений или сразу при уверенности ≥ 0.9', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    m.ingest(me({ gold: 600 }), t);
    expect(m.snapshot(t).hero.gold.value).toBeNull();
    m.ingest(me({ gold: 600 }), t + 100);
    expect(m.snapshot(t + 100).hero.gold.value).toBe(600);
    m.ingest(me({ gold: 650, conf: 0.95 }), t + 200);
    expect(m.snapshot(t + 200).hero.gold.value).toBe(650);
  });

  it('нераспознанное или неверное чтение не затирает принятое значение', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    t = feed(m, t, 3, () => me({ gold: 500 }));
    const bad = me();
    bad.fields.gold = obs(999, 0.95, 'out-of-range');
    t = feed(m, t, 5, () => bad);
    t = feed(m, t, 5, () => me()); // gold = null
    expect(m.snapshot(t).hero.gold.value).toBe(500);
  });

  it('уровень не уменьшается от мерцания; стойкая поправка принимается через 10 с', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    t = feed(m, t, 3, () => me({ level: 7 }));
    // Мерцание и даже несколько подряд — меньше 10 с: уровень остаётся 7
    t = feed(m, t, 30, () => me({ level: 6 }), 200);
    expect(m.snapshot(t).hero.level.value).toBe(7);
    // Свой уровень снова виден — ожидание поправки сбрасывается
    t = feed(m, t, 1, () => me({ level: 7 }));
    t = feed(m, t, 40, () => me({ level: 6 }), 200); // 8 с
    expect(m.snapshot(t).hero.level.value).toBe(7);
    t = feed(m, t, 15, () => me({ level: 6 }), 200); // > 10 с подряд
    expect(t).toBeGreaterThan(CORRECTION_MS);
    expect(m.snapshot(t).hero.level.value).toBe(6);
  });

  it('счёт и У/С/П тоже не уменьшаются от одного чтения', () => {
    const m = new MatchStateModel();
    let t = feed(m, 0, 3, () => reading({ scoreRadiant: 12, kda: [3, 1, 4] }));
    t = feed(m, t, 3, () => reading({ scoreRadiant: 2, kda: [3, 0, 4] }));
    const s = m.snapshot(t);
    expect(s.match.scoreRadiant.value).toBe(12);
    expect(s.hero.kda.value).toEqual({ kills: 3, deaths: 1, assists: 4 });
  });
});

describe('свой герой и выбранный юнит', () => {
  it('героя определяет 8 чтений своей панели с одним именем за 30 с', () => {
    const m = new MatchStateModel();
    let t = feed(m, 0, 7, () => me({ level: 3 }));
    expect(m.snapshot(t).hero.locked).toBe(false);
    expect(m.snapshot(t).hero.level.value).toBeNull(); // до определения героя поля героя не трогаем
    t = feed(m, t, 1, () => me({ level: 3 }));
    const s = m.snapshot(t);
    expect(s.hero.locked).toBe(true);
    expect(s.hero.identity.value).toEqual(KEZ);
  });

  it('чтения, разнесённые больше чем на 30 с, героя не определяют', () => {
    const m = new MatchStateModel();
    feed(m, 0, 8, () => me(), 5000);
    expect(m.snapshot(40_000).hero.locked).toBe(false);
  });

  it('выбранный враг или союзник не меняют здоровье, ману и предметы игрока', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    const mine = inventory(['tango', 'boots', null, null, null, null, null, null, null]);
    t = feed(m, t, 3, () => me({ health: [800, 1000], mana: [300, 400], level: 5, items: mine }));
    const theirs = inventory(['blink', 'bkb', 'daedalus', null, null, null, null, null, null]);
    // Враг выбран (имя не прочиталось)
    t = feed(m, t, 20, () => reading({ unit: 'enemy', hero: null, health: [100, 2000], mana: [50, 900], level: 5, items: theirs }));
    // Враг выбран и имя прочиталось
    t = feed(m, t, 20, () => reading({ unit: 'enemy', hero: AXE, health: [150, 2000], mana: [60, 900], level: 5, items: theirs }));
    // Выбран союзник
    t = feed(m, t, 20, () => reading({ unit: 'ally', hero: SF, health: [200, 1500], mana: [70, 800], level: 5, items: theirs }));
    const s = m.snapshot(t);
    expect(s.hero.identity.value).toEqual(KEZ);
    expect(s.hero.health.value).toEqual({ current: 800, max: 1000 });
    expect(s.hero.mana.value).toEqual({ current: 300, max: 400 });
    expect(s.hero.items.slice(0, 3).map((x) => x.value?.item?.key ?? null)).toEqual(['tango', 'boots', null]);
    expect(s.events.filter((e) => e.type === 'item-gained' || e.type === 'item-lost')).toEqual([]);
  });

  it('чтение без имени — своё, только если своё было < 3 с назад и уровень тот же', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    t = feed(m, t, 3, () => me({ level: 6, health: [500, 1000] }));
    // Имя не прочиталось, свой юнит, тот же уровень — принимаем
    t = feed(m, t, 3, () => reading({ unit: 'ally', hero: null, level: 6, health: [450, 1000] }));
    expect(m.snapshot(t).hero.health.value).toEqual({ current: 450, max: 1000 });
    // Другой уровень — это не мы
    t = feed(m, t, 3, () => reading({ unit: 'ally', hero: null, level: 9, health: [100, 1000] }));
    expect(m.snapshot(t).hero.health.value).toEqual({ current: 450, max: 1000 });
    // Своё чтение было больше 3 с назад — тоже не верим
    t += 4000;
    t = feed(m, t, 3, () => reading({ unit: 'ally', hero: null, level: 6, health: [200, 1000] }));
    expect(m.snapshot(t).hero.health.value).toEqual({ current: 450, max: 1000 });
  });
});

describe('игровое время', () => {
  it('между чтениями время экстраполируется и помечается как вывод', () => {
    const m = new MatchStateModel();
    m.ingest(reading({ clock: 100 }), 0);
    m.ingest(reading({ clock: 100 }), 500);
    const now = m.snapshot(600).match.clock;
    expect(now.tag).toBe('visible');
    const later = m.snapshot(5500).match.clock;
    expect(later.tag).toBe('inferred');
    expect(later.value!).toBeCloseTo(105, 1); // опора — второе (подтверждающее) чтение в 500 мс
  });

  it('одно далёкое чтение игнорируется; скачок принимается после 3 согласованных чтений', () => {
    const m = new MatchStateModel();
    m.ingest(reading({ clock: 600, conf: 0.95 }), 0);
    m.ingest(reading({ clock: 900 }), 1000);
    expect(m.snapshot(1000).match.clock.value!).toBeCloseTo(601, 0);
    m.ingest(reading({ clock: 602 }), 2000);
    m.ingest(reading({ clock: 900 }), 3000);
    m.ingest(reading({ clock: 901 }), 4000);
    expect(m.snapshot(4000).match.clock.value!).toBeCloseTo(604, 0);
    m.ingest(reading({ clock: 902 }), 5000);
    expect(m.snapshot(5000).match.clock.value).toBe(902);
    expect(types(m, 5000)).not.toContain('match-reset');
  });

  it('время стоит дольше 3 с — пауза (без экстраполяции); пошло — снятие паузы', () => {
    const m = new MatchStateModel();
    let t = feed(m, 0, 2, () => reading({ clock: 300 }), 500);
    t = feed(m, t, 8, () => reading({ clock: 300 }), 500); // 4 с одно и то же время
    let s = m.snapshot(t);
    expect(s.match.paused).toBe(true);
    expect(types(m, t)).toEqual(['pause']);
    // На паузе время не идёт
    expect(m.snapshot(t + 60_000).match.clock.value).toBe(300);
    m.ingest(reading({ clock: 301 }), t + 60_000);
    s = m.snapshot(t + 62_000);
    expect(s.match.paused).toBe(false);
    expect(s.match.clock.value!).toBeCloseTo(303, 0);
    expect(types(m, t)).toEqual(['pause', 'unpause']);
  });
});

describe('метки во времени', () => {
  it('visible → remembered → unknown по срокам полей', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    t = feed(m, t, 3, () => me({ health: [700, 1000], gold: 1200, level: 8, items: inventory(['tango', null, null, null, null, null, null, null, null]) }));
    const at = (dt: number) => m.snapshot(t + dt).hero;
    expect(at(1000).health.tag).toBe('visible');
    expect(at(5000).health.tag).toBe('remembered');
    expect(at(5000).health.value).toEqual({ current: 700, max: 1000 });
    expect(at(11_000).health.tag).toBe('unknown');
    expect(at(11_000).health.value).toBeNull();
    expect(at(30_000).gold.tag).toBe('remembered');
    expect(at(61_000).gold.tag).toBe('unknown');
    expect(at(5 * 60_000).items[0]!.tag).toBe('remembered');
    expect(at(11 * 60_000).items[0]!.tag).toBe('unknown');
    // Уровень и личность героя помнятся весь матч
    expect(at(3_600_000).level.tag).toBe('remembered');
    expect(at(3_600_000).identity.value).toEqual(KEZ);
  });

  it('остаток перезарядки убывает и помечается как вывод, не ниже 0', () => {
    const m = new MatchStateModel();
    let t = lockKez(m);
    t = feed(m, t, 2, () => me({ abilities: [ability(0, 'cooldown', 1, 10)] }), 0);
    const fresh = m.snapshot(t).hero.abilities[0]!;
    expect(fresh.cooldown.tag).toBe('visible');
    expect(fresh.cooldown.value!).toBeCloseTo(10, 1);
    const later = m.snapshot(t + 4000).hero.abilities[0]!;
    expect(later.cooldown.tag).toBe('inferred');
    expect(later.cooldown.value!).toBeCloseTo(6, 1);
    expect(m.snapshot(t + 20_000).hero.abilities[0]!.cooldown.value).toBe(0);
  });
});

describe('новый матч', () => {
  it('время ушло назад > 120 с и это подтвердили 3 чтения — сброс и событие', () => {
    const m = new MatchStateModel();
    let t = lockKez(m, 0, { clock: 1500, level: 18, conf: 0.95 });
    expect(m.snapshot(t).hero.level.value).toBe(18);
    // Одно чтение назад — не сброс
    m.ingest(reading({ clock: 10 }), t);
    expect(types(m, t)).not.toContain('match-reset');
    t = feed(m, t + 1000, 3, (i) => reading({ clock: 20 + i }), 1000);
    const s = m.snapshot(t);
    expect(s.events.map((e) => e.type)).toEqual(['match-reset']);
    expect(s.hero.locked).toBe(false);
    expect(s.hero.level.value).toBeNull();
    expect(s.match.clock.value!).toBeGreaterThanOrEqual(22);
  });

  it('reset() вручную очищает состояние и пишет событие', () => {
    const m = new MatchStateModel();
    const t = lockKez(m, 0, { level: 4, conf: 0.95 });
    m.reset(t);
    const s = m.snapshot(t);
    expect(s.hero.locked).toBe(false);
    expect(s.hero.level.value).toBeNull();
    expect(s.events).toEqual([{ type: 'match-reset', wallMs: t, clock: null, data: { reason: 'manual' } }]);
  });
});

describe('события', () => {
  it('все типы событий', () => {
    const m = new MatchStateModel();
    const inv = (keys: (string | null)[]) => inventory([...keys, ...Array<null>(9 - keys.length).fill(null)]);
    const base: Spec = { clock: 600, level: 5, kda: [1, 1, 1], dayNight: 'day', items: inv(['tango']), abilities: [ability(0, 'unlearned', 0)] };
    let t = lockKez(m, 0, { ...base, conf: 0.95 });
    const step = (s: Spec, n = 2) => {
      t = feed(m, t, n, () => me({ ...base, ...s }));
    };
    step({ level: 6 });
    step({ kda: [2, 1, 1] });
    step({ kda: [2, 2, 1] });
    step({ kda: [2, 2, 2] });
    // Предмет появился: одно чтение — ещё нет, два — да
    step({ items: inv(['tango', 'boots']) }, 1);
    expect(types(m, t)).not.toContain('item-gained');
    step({ items: inv(['tango', 'boots']) }, 1);
    // Перекладывание между ячейками — не покупка и не потеря
    step({ items: inv(['boots', 'tango']) });
    step({ items: inv(['boots']) });
    base.items = inv(['boots']);
    step({ abilities: [ability(0, 'ready', 1)] });
    base.abilities = [ability(0, 'ready', 1)];
    step({ dayNight: 'night' });
    // Время скачком стало 700 (3 чтения) и стоит больше 3 с — пауза; пошло — снятие паузы
    t = feed(m, t, 12, () => me({ ...base, clock: 700, dayNight: 'night' }), 500);
    t = feed(m, t, 2, (i) => me({ ...base, clock: 701 + i, dayNight: 'night' }), 1000);

    const all: MatchEventType[] = ['level-up', 'kill', 'death', 'assist', 'item-gained', 'item-lost', 'ability-learned', 'day-night', 'pause', 'unpause'];
    const evs = m.snapshot(t).events;
    expect(evs.map((e) => e.type)).toEqual(all);
    expect(evs.find((e) => e.type === 'item-gained')!.data).toEqual({ key: 'boots', name: 'BOOTS' });
    expect(evs.find((e) => e.type === 'item-lost')!.data).toEqual({ key: 'tango', name: 'TANGO' });
    expect(evs.find((e) => e.type === 'level-up')!.data).toEqual({ from: 5, to: 6 });
    expect(evs.find((e) => e.type === 'ability-learned')!.data).toEqual({ index: 0, from: 0, to: 1 });
    expect(evs.find((e) => e.type === 'day-night')!.data).toEqual({ from: 'day', to: 'night' });
    // У события есть игровое время
    expect(evs[0]!.clock).not.toBeNull();
    // match-reset — последний тип; сброс очищает и журнал
    m.reset(t);
    expect(types(m, t)).toEqual(['match-reset']);
  });

  it('журнал хранит только последние 100 событий', () => {
    const m = new MatchStateModel();
    let t = 0;
    for (let i = 0; i < 130; i++) {
      t = feed(m, t, 1, () => reading({ dayNight: i % 2 ? 'night' : 'day' }));
    }
    const evs = m.snapshot(t).events;
    expect(evs).toHaveLength(EVENT_LIMIT);
    expect(evs.every((e) => e.type === 'day-night')).toBe(true);
    expect(evs.at(-1)!.wallMs).toBe(t - 100);
  });
});

describe('скорость', () => {
  it('ingest() быстрее 0.5 мс на чтение (1000 чтений)', () => {
    const m = new MatchStateModel();
    const inv = inventory(['tango', 'boots', 'wand', null, null, null, 'ward', null, null]);
    const abilities = [ability(0, 'ready', 1), ability(1, 'cooldown', 2, 8), ability(2, 'ready', 1), ability(3, 'unlearned', 0)];
    const rs = Array.from({ length: 1000 }, (_, i) =>
      me({
        clock: 600 + Math.floor(i / 10),
        scoreRadiant: 10,
        scoreDire: 12,
        gold: 1000 + (i % 7),
        health: [900 - (i % 5), 1200],
        mana: [400, 500],
        level: 9,
        kda: [3, 2, 5],
        farm: [80, 4],
        dayNight: 'day',
        abilities,
        items: inv,
      }),
    );
    const t0 = performance.now();
    rs.forEach((r, i) => m.ingest(r, i * 100));
    const perReading = (performance.now() - t0) / rs.length;
    expect(perReading).toBeLessThan(0.5);
    expect(m.snapshot(100_000).hero.level.value).toBe(9);
  });
});
