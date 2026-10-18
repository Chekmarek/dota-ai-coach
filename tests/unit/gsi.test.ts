import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AgreementTracker, labelFromGsi, mapGsi, parseGsiBody, type GsiReading } from '../../src/core/gsi/index.ts';
import { COURIER_SEC, CROSS_SOURCE_WINDOW_SEC, GSI_LIVE_MS, MatchStateModel, SourceEventGate } from '../../src/core/match-state/index.ts';
import type { HudReading } from '../../src/core/vision/recognize-hud.ts';
import type { AbilitySlot } from '../../src/core/vision/abilities.ts';
import type { ItemSlot } from '../../src/core/vision/items.ts';
import type { Observed, Validity } from '../../src/shared/types/observation.ts';

// ---------- синтетические тела GSI ----------

const FIX = join(import.meta.dirname, '../fixtures/gsi');
const body = (name: string) => JSON.parse(readFileSync(join(FIX, `${name}.json`), 'utf8')) as Record<string, any>;
const read = (name: string, patch?: (b: Record<string, any>) => void): GsiReading => {
  const b = body(name);
  patch?.(b);
  const r = mapGsi(b, (k) => ({ bottle: 'Bottle', boots: 'Boots of Speed' })[k]);
  if (!r) throw new Error(`${name}: mapGsi вернул null`);
  return r;
};

// ---------- построитель чтений с экрана (как в match-state.test.ts) ----------

const CONF = 0.8;
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

function screen(s: Spec = {}): HudReading {
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

/** Своя панель: выбран свой герой (Shadow Fiend, как в синтетических телах GSI) */
const mine = (s: Spec = {}) => screen({ unit: 'ally', hero: SF, ...s });

function inventory(keys: (string | null)[]): ItemSlot[] {
  return keys.map((key, i) => ({
    slot: i < 6 ? `inv${i + 1}` : `bp${i - 5}`,
    item: key ? { key, name: key.toUpperCase() } : null,
    empty: key === null,
    distance: 0.1,
    confidence: 0.9,
  }));
}

function feed(m: MatchStateModel, t: number, n: number, make: (i: number) => HudReading, stepMs = 100): number {
  for (let i = 0; i < n; i++) m.ingest(make(i), t + i * stepMs);
  return t + n * stepMs;
}

const types = (m: MatchStateModel, t: number) => m.snapshot(t).events.map((e) => e.type);

// ---------- схема ----------

describe('GSI: схема', () => {
  it('все синтетические тела в формате Valve принимаются', () => {
    const names = readdirSync(FIX).filter((f) => f.endsWith('.json'));
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const f of names) {
      const r = parseGsiBody(JSON.parse(readFileSync(join(FIX, f), 'utf8')));
      expect(r.ok, f).toBe(true);
    }
  });

  it('мусор отклоняется без исключения', () => {
    for (const junk of [null, undefined, 42, 'не json', '[1,2]', [], true, '{"map":']) {
      expect(() => parseGsiBody(junk)).not.toThrow();
      expect(parseGsiBody(junk).ok).toBe(false);
    }
    expect(() => mapGsi('мусор')).not.toThrow();
    expect(mapGsi('мусор')).toBeNull();
  });

  it('поле неверного типа становится undefined, остальное сохраняется; лишние ключи допустимы', () => {
    const b = body('laning');
    b.hero.level = 'семь';
    b.map.unknown_new_field = { x: 1 };
    b.items.slot0 = 17; // испорченная ячейка
    const r = parseGsiBody(b);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.body.hero?.level).toBeUndefined();
    expect(r.body.hero?.health).toBe(812);
    expect(r.body.items?.slot0).toBeNull();
    expect(r.body.items?.slot1?.name).toBe('item_boots');
    expect(r.body.auth?.token).toBe('dotacoach-test-token');
  });

  it('JSON-строка разбирается так же, как объект', () => {
    expect(parseGsiBody(readFileSync(join(FIX, 'laning.json'), 'utf8')).ok).toBe(true);
  });
});

// ---------- перевод в чтение ----------

describe('GSI: mapGsi', () => {
  it('меню и наблюдение за чужой игрой → null', () => {
    expect(mapGsi(body('menu'))).toBeNull();
    const spectator = body('laning');
    spectator.hero = { team2: { player0: { id: 11, name: 'npc_dota_hero_nevermore' } } };
    expect(mapGsi(spectator)).toBeNull();
    const noMap = body('laning');
    delete noMap.map;
    expect(mapGsi(noMap)).toBeNull();
  });

  it('лайнинг: каждое поле', () => {
    const r = read('laning');
    expect(r.matchId).toBe('8123456789');
    expect(r.gameState).toBe('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS');
    expect(r.phase).toBe('in-progress');
    expect(r.clock).toBe(485);
    expect(r.gameTime).toBe(575);
    expect(r.paused).toBe(false);
    expect(r.dayNight).toBe('day');
    expect(r.scoreRadiant).toBe(3);
    expect(r.scoreDire).toBe(2);
    expect(r.team).toBe('radiant');
    expect(r.hero).toEqual({
      key: 'nevermore',
      id: 11,
      name: null,
      level: 7,
      alive: true,
      respawnSec: 0,
      x: -6700,
      y: -6200,
      health: { current: 812, max: 980 },
      mana: { current: 230, max: 411 },
    });
    // team_slot в синтетическом теле нет — своя ячейка неизвестна
    expect(r.slot).toBeNull();
    expect(r.gold).toBe(1335);
    expect(r.goldReliable).toBe(402);
    expect(r.goldUnreliable).toBe(933);
    expect(r.kda).toEqual({ kills: 2, deaths: 1, assists: 1 });
    expect(r.farm).toEqual({ lastHits: 48, denies: 9 });
    expect(r.timestamp).toBe(1760340000);
  });

  it('способности: ключ, уровень, состояние, перезарядка; служебные — не на панели', () => {
    const r = read('laning');
    const by = (k: string) => r.abilities.find((a) => a.key === k)!;
    expect(by('nevermore_shadowraze1')).toEqual({ index: 0, slot: 0, key: 'nevermore_shadowraze1', level: 3, state: 'cooldown', cooldownSec: 6.4, ultimate: false, passive: false, maxCooldownSec: null });
    expect(by('nevermore_shadowraze2').state).toBe('ready');
    expect(by('nevermore_necromastery').state).toBe('ready'); // пассивная
    expect(by('nevermore_dark_lord').state).toBe('unlearned');
    expect(by('nevermore_requiem')).toMatchObject({ slot: 5, level: 0, state: 'unlearned', ultimate: true });
    expect(by('plus_high_five').slot).toBeNull();
    expect(r.abilities.some((a) => a.key === 'attributes')).toBe(false);
  });

  it('нехватка маны — вывод только у живого героя без контроля', () => {
    const r = read('laning', (b) => {
      b.abilities.ability1.can_cast = false;
    });
    expect(r.abilities[1]!.state).toBe('no-mana');
    const stunned = read('laning', (b) => {
      b.abilities.ability1.can_cast = false;
      b.hero.stunned = true;
    });
    expect(stunned.abilities[1]!.state).toBeNull();
    const dead = read('dead-respawn');
    expect(dead.abilities.filter((a) => a.slot !== null && a.level! > 0 && !a.passive).every((a) => a.state === null)).toBe(true);
  });

  it('ячейки: slot0..5 → inv1..6, slot6..8 → bp1..3, «empty» — пусто, «item_» снимается', () => {
    const r = read('laning');
    const slot = (s: string) => r.items!.find((x) => x.slot === s);
    expect(r.items!.slice(0, 9).map((x) => x.slot)).toEqual(['inv1', 'inv2', 'inv3', 'inv4', 'inv5', 'inv6', 'bp1', 'bp2', 'bp3']);
    expect(slot('inv1')).toEqual({ slot: 'inv1', key: 'bottle', name: 'Bottle', charges: 2, cooldownSec: null, passive: false, canCast: true });
    expect(slot('inv2')!.name).toBe('Boots of Speed');
    expect(slot('inv3')!.name).toBe('wraith_band'); // справочник не знает — имя = ключ, не выдумываем
    expect(slot('inv5')).toEqual({ slot: 'inv5', key: null, name: null, charges: null, cooldownSec: null });
    expect(slot('bp1')!.key).toBeNull();
    expect(slot('bp2')!.key).toBe('branches');
    expect(slot('stash1')!.key).toBe('blades_of_attack');
    expect(slot('tp')!.key).toBe('tpscroll');
    expect(slot('neutral')!.key).toBe('occult_bracelet');
  });

  it('отсутствующие значения → null, ничего не выдумывается', () => {
    const r = read('laning', (b) => {
      delete b.player;
      delete b.items;
      delete b.abilities;
      delete b.hero.max_mana;
      delete b.map.paused;
      delete b.map.daytime;
      delete b.map.nightstalker_night;
    });
    expect(r.kda).toBeNull();
    expect(r.farm).toBeNull();
    expect(r.gold).toBeNull();
    expect(r.team).toBeNull();
    expect(r.items).toBeNull();
    expect(r.abilities).toEqual([]);
    expect(r.hero.mana).toBeNull();
    expect(r.paused).toBeNull();
    expect(r.dayNight).toBeNull();
  });

  it('до горна, смерть, пауза, ночь Найт Сталкера', () => {
    const pre = read('pre-game');
    expect(pre.phase).toBe('pre-game');
    expect(pre.clock).toBe(-78);
    expect(pre.dayNight).toBe('night');
    const dead = read('dead-respawn');
    expect(dead.hero.alive).toBe(false);
    expect(dead.hero.respawnSec).toBe(37);
    expect(dead.hero.health).toEqual({ current: 0, max: 1610 });
    expect(read('paused').paused).toBe(true);
    expect(read('laning', (b) => (b.map.nightstalker_night = true)).dayNight).toBe('night');
  });

  it('справочник героя даёт имя и id, если GSI id не прислал', () => {
    const r = mapGsi(
      (() => {
        const b = body('laning');
        delete b.hero.id;
        return b;
      })(),
      undefined,
      (k) => (k === 'nevermore' ? SF : undefined),
    )!;
    expect(r.hero.id).toBe(11);
    expect(r.hero.name).toBe('Shadow Fiend');
  });
});

// ---------- модель состояния с GSI ----------

describe('GSI в модели состояния', () => {
  it('значения принимаются сразу: уверенность 1, «видно сейчас», источник gsi; герой фиксируется с первого чтения', () => {
    const m = new MatchStateModel();
    m.ingestGsi(read('laning'), 1000);
    const s = m.snapshot(1000);
    expect(s.hero.locked).toBe(true);
    expect(s.hero.identity.value).toEqual({ id: 11, name: 'nevermore' });
    for (const t of [s.hero.gold, s.hero.level, s.hero.health, s.hero.mana, s.hero.kda, s.hero.farm, s.match.clock, s.match.scoreRadiant, s.match.dayNight]) {
      expect(t).toMatchObject({ confidence: 1, tag: 'visible', source: 'gsi' });
    }
    expect(s.hero.gold.value).toBe(1335);
    expect(s.hero.level.value).toBe(7);
    expect(s.match.clock.value).toBe(485);
    expect(s.hero.items.slice(0, 3).map((x) => x.value?.item?.key ?? null)).toEqual(['bottle', 'boots', 'wraith_band']);
    expect(s.hero.abilities[0]).toMatchObject({ index: 0, key: 'nevermore_shadowraze1' });
    expect(s.hero.abilities[0]!.cooldown.value).toBeCloseTo(6.4);
    expect(s.hero.abilities.map((a) => a.index)).toEqual([0, 1, 2, 3, 4, 5]); // plus_high_five не на панели
    expect(s.sources).toEqual({ gsi: true, screen: false });
    expect(s.events).toEqual([]); // первое знакомство — не события
  });

  it('пока GSI живое, экран не перезаписывает поля GSI, но дополняет недостающие', () => {
    const m = new MatchStateModel();
    m.ingestGsi(
      read('laning', (b) => {
        delete b.items; // предметы GSI не прислал
      }),
      0,
    );
    // Экран уверенно читает другое золото, уровень и время — 20 кадров подряд
    const t = feed(m, 100, 20, () => mine({ conf: 0.95, gold: 9999, level: 12, clock: 900, health: [100, 980], items: inventory(['tango', null, null, null, null, null, null, null, null]) }));
    const s = m.snapshot(t);
    expect(s.hero.gold.value).toBe(1335);
    expect(s.hero.level.value).toBe(7);
    expect(s.hero.health.value).toEqual({ current: 812, max: 980 });
    expect(Math.floor(s.match.clock.value!)).toBe(487);
    expect(s.hero.items[0]!.value?.item?.key).toBe('tango'); // дополнено зрением
    expect(s.hero.items[0]!.source).toBe('screen');
    expect(s.sources).toEqual({ gsi: true, screen: true });
  });

  it('GSI молчит дольше 5 с — экран снова ведёт поля, как на этапе D', () => {
    const m = new MatchStateModel();
    m.ingestGsi(read('laning'), 0);
    let t = feed(m, 1000, 3, () => mine({ gold: 2000 }));
    expect(m.snapshot(t).hero.gold.value).toBe(1335);
    t = feed(m, GSI_LIVE_MS + 1, 3, () => mine({ gold: 2000 }));
    const s = m.snapshot(t);
    expect(s.sources.gsi).toBe(false);
    expect(s.hero.gold.value).toBe(2000);
    expect(s.hero.gold.source).toBe('screen');
    expect(s.hero.gold.confidence).toBe(0.8);
  });

  it('кадр с выбранным врагом или чужим героем не трогает поля героя', () => {
    const m = new MatchStateModel();
    m.ingestGsi(
      read('laning', (b) => {
        delete b.hero.health; // здоровье GSI не прислал — экран мог бы дополнить
      }),
      0,
    );
    let t = feed(m, 100, 10, () => screen({ unit: 'enemy', hero: AXE, health: [300, 2000], gold: 50 }));
    t = feed(m, t, 10, () => screen({ unit: 'ally', hero: AXE, health: [300, 2000] })); // союзник, но не свой герой
    const s = m.snapshot(t);
    expect(s.hero.health.value).toBeNull();
    expect(s.hero.identity.value?.id).toBe(11);
    // А свой герой на панели — дополняет
    t = feed(m, t, 3, () => mine({ health: [700, 980] }));
    expect(m.snapshot(t).hero.health.value).toEqual({ current: 700, max: 980 });
  });

  it('сброс при смене matchid', () => {
    const m = new MatchStateModel();
    m.ingestGsi(read('laning'), 0);
    m.ingestGsi(read('new-match'), 1000);
    const s = m.snapshot(1000);
    expect(types(m, 1000)).toEqual(['match-reset']);
    expect(s.events[0]!.data).toMatchObject({ reason: 'gsi-match-id', from: '8123456789', to: '8123499999' });
    expect(s.hero.identity.value?.id).toBe(145);
    expect(s.hero.level.value).toBe(1);
    expect(s.match.scoreRadiant.value).toBe(0);
  });

  it('сброс при возврате из игры в подготовку', () => {
    const m = new MatchStateModel();
    m.ingestGsi(read('laning'), 0);
    m.ingestGsi(
      read('pre-game', (b) => {
        b.map.matchid = '0'; // id ещё не выдан — сброс по стадии
      }),
      1000,
    );
    expect(types(m, 1000)).toEqual(['match-reset']);
    expect(m.snapshot(1000).events[0]!.data).toMatchObject({ reason: 'gsi-pre-game' });
  });

  it('другой герой по GSI без нового matchid (Hero Demo, matchid "0") — новый матч, старые события и способности не остаются', () => {
    const m = new MatchStateModel();
    const demo = (patch?: (b: Record<string, any>) => void) =>
      read('laning', (b) => {
        b.map.matchid = '0';
        patch?.(b);
      });
    m.ingestGsi(demo(), 0);
    m.ingestGsi(demo((b) => (b.hero.level = 8)), 500);
    expect(types(m, 500)).toEqual(['level-up']);
    // Вышел из демо и зашёл другим героем (Kez, 1 уровень, одна способность)
    const kez = read('new-match', (b) => {
      b.map.matchid = '0';
      b.abilities = { ability0: b.abilities.ability0 };
    });
    m.ingestGsi(kez, 1000);
    const s = m.snapshot(1000);
    expect(s.events.map((e) => e.type)).toEqual(['match-reset']);
    expect(s.events[0]!.data).toMatchObject({ reason: 'gsi-hero', from: 11, to: 145 });
    expect(s.hero.identity.value?.id).toBe(145);
    expect(s.hero.abilities).toHaveLength(1);
    // Тот же герой дальше — без сбросов
    m.ingestGsi(kez, 1500);
    expect(types(m, 1500)).toEqual(['match-reset']);
  });

  it('события — по одному на настоящее изменение, даже если оба источника его видят', () => {
    const m = new MatchStateModel();
    m.ingestGsi(read('laning'), 0);
    // Экран видит ту же картину
    let t = feed(m, 50, 5, () => mine({ conf: 0.95, level: 7, kda: [2, 1, 1], items: inventory(['bottle', 'boots', 'wraith_band', 'wraith_band', null, 'magic_wand', null, 'branches', null]) }));
    // Повышение уровня, убийство и покупка — и в GSI, и на экране
    const next = read('laning', (b) => {
      b.hero.level = 8;
      b.player.kills = 3;
      b.items.slot4 = { name: 'item_ogre_axe' };
      b.abilities.ability5.level = 1;
    });
    m.ingestGsi(next, t);
    t = feed(m, t + 50, 10, () => mine({ conf: 0.95, level: 8, kda: [3, 1, 1], items: inventory(['bottle', 'boots', 'wraith_band', 'wraith_band', 'ogre_axe', 'magic_wand', null, 'branches', null]) }));
    m.ingestGsi(next, t); // повтор того же состояния
    t += 1000;
    // GSI замолкает, экран продолжает показывать то же — новых событий нет
    t = feed(m, t + GSI_LIVE_MS, 10, () => mine({ conf: 0.95, level: 8, kda: [3, 1, 1], items: inventory(['bottle', 'boots', 'wraith_band', 'wraith_band', 'ogre_axe', 'magic_wand', null, 'branches', null]) }));
    expect(types(m, t).sort()).toEqual(['ability-learned', 'item-gained', 'kill', 'level-up']);
  });

  it('пауза и её снятие — по флагу GSI', () => {
    const m = new MatchStateModel();
    m.ingestGsi(read('laning'), 0);
    expect(read('paused').paused).toBe(true);
    m.ingestGsi(read('laning', (b) => (b.map.paused = true)), 1000);
    expect(m.snapshot(1000).match.paused).toBe(true);
    expect(m.snapshot(4000).match.clock.value).toBe(485);
    m.ingestGsi(read('laning', (b) => (b.map.paused = false)), 4000);
    expect(types(m, 4000)).toEqual(['pause', 'unpause']);
    expect(m.snapshot(6000).match.clock.value).toBeCloseTo(487);
  });

  it('сверка после тишины GSI исправляет без событий', () => {
    const m = new MatchStateModel();
    // Экран определил героя и ошибочно прочитал уровень 6
    let t = feed(m, 0, 8, () => mine({ conf: 0.95, level: 6 }));
    expect(m.snapshot(t).hero.level.value).toBe(6);
    m.ingestGsi(read('laning'), t); // GSI: 7
    expect(m.snapshot(t).hero.level.value).toBe(7);
    expect(types(m, t)).toEqual([]);
  });

  it('mapGsi + ingestGsi — меньше 0.5 мс на тело запроса', () => {
    const m = new MatchStateModel();
    const raw = body('laning');
    for (let i = 0; i < 200; i++) m.ingestGsi(mapGsi(raw)!, i * 100); // прогрев
    const N = 2000;
    const t0 = performance.now();
    for (let i = 0; i < N; i++) m.ingestGsi(mapGsi(raw)!, 20_000 + i * 100);
    const perCall = (performance.now() - t0) / N;
    console.log(`perf-gsi: ${(perCall * 1000).toFixed(1)} мкс на тело`);
    expect(perCall).toBeLessThan(0.5);
  });
});

// ---------- события по источникам (день/ночь после проверки на Доте 2026-10-13) ----------

describe('события по источникам: день и ночь', () => {
  const dn = (m: MatchStateModel, t: number) => m.snapshot(t).events.filter((e) => e.type === 'day-night');
  const gsiDay = (day: boolean, clock = 300) =>
    read('laning', (b) => {
      b.map.daytime = day;
      b.map.clock_time = clock;
    });

  it('причина ложного «Наступил день»: луна до горна и значок в меню — не ночь', () => {
    const m = new MatchStateModel();
    // Меню/загрузка: часов нет, на месте значка что-то «лунное»
    let t = feed(m, 0, 10, () => screen({ conf: 0.95, clock: null, dayNight: 'night' }));
    // До горна: часы идут обратным отсчётом (зрение ставит минус), значок — луна
    t = feed(m, t, 10, (i) => screen({ conf: 0.95, clock: -30 + Math.floor(i / 10), dayNight: 'night' }));
    // Горн: 0:00, солнце
    t = feed(m, t, 20, (i) => screen({ conf: 0.95, clock: Math.floor(i / 10), dayNight: 'day' }));
    expect(dn(m, t)).toEqual([]);
    expect(m.snapshot(t).match.dayNight.value).toBe('day');
  });

  it('экран первым, потом GSI с другим значением — события нет', () => {
    const m = new MatchStateModel();
    let t = feed(m, 0, 10, (i) => screen({ conf: 0.95, clock: 300 + Math.floor(i / 10), dayNight: 'night' }));
    expect(m.snapshot(t).match.dayNight.value).toBe('night');
    for (let k = 0; k < 5; k++) m.ingestGsi(gsiDay(true, 301 + k), t + k * 500);
    t = feed(m, t + 2500, 10, (i) => screen({ conf: 0.95, clock: 303 + Math.floor(i / 10), dayNight: 'night' }));
    expect(m.snapshot(t).match.dayNight).toMatchObject({ value: 'day', source: 'gsi' });
    expect(dn(m, t)).toEqual([]);
  });

  it('GSI первым, потом экран с другим значением — события нет, и после тишины GSI тоже', () => {
    const m = new MatchStateModel();
    m.ingestGsi(gsiDay(true, 300), 0);
    m.ingestGsi(gsiDay(true, 300), 500);
    // Пока GSI живое, экран поле не трогает
    let t = feed(m, 600, 10, (i) => screen({ conf: 0.95, clock: 300 + Math.floor(i / 10), dayNight: 'night' }));
    // GSI замолчало — экран снова ведёт поле, но его первое значение (расхождение с GSI) — не событие
    t = feed(m, 500 + GSI_LIVE_MS + 1, 10, (i) => screen({ conf: 0.95, clock: 305 + Math.floor(i / 10), dayNight: 'night' }));
    expect(m.snapshot(t).match.dayNight).toMatchObject({ value: 'night', source: 'screen' });
    expect(dn(m, t)).toEqual([]);
  });

  it('оба источника видят один настоящий переход — ровно одно событие (GSI первым)', () => {
    const m = new MatchStateModel();
    m.ingestGsi(gsiDay(true, 300), 0);
    m.ingestGsi(gsiDay(false, 301), 1000);
    expect(dn(m, 1000)).toHaveLength(1);
    // GSI замолкает, экран видит ту же ночь
    const t = feed(m, 1000 + GSI_LIVE_MS + 1, 20, (i) => screen({ conf: 0.95, clock: 306 + Math.floor(i / 10), dayNight: 'night' }));
    expect(dn(m, t).map((e) => e.data)).toEqual([{ from: 'day', to: 'night' }]);
  });

  it('оба источника видят один настоящий переход — ровно одно событие (экран первым)', () => {
    const m = new MatchStateModel();
    let t = feed(m, 0, 10, (i) => screen({ conf: 0.95, clock: 300 + Math.floor(i / 10), dayNight: 'day' }));
    t = feed(m, t, 10, (i) => screen({ conf: 0.95, clock: 301 + Math.floor(i / 10), dayNight: 'night' }));
    expect(dn(m, t)).toHaveLength(1);
    m.ingestGsi(gsiDay(false, 302), t);
    m.ingestGsi(gsiDay(false, 303), t + 1000);
    expect(dn(m, t + 1000).map((e) => e.data)).toEqual([{ from: 'day', to: 'night' }]);
  });

  it('повтор того же перехода вторым источником в пределах 5 с игрового времени отбрасывается', () => {
    const g = new SourceEventGate();
    expect(g.observe('gsi', 'dayNight', 'day')).toBe(false); // первое значение — не событие
    expect(g.observe('gsi', 'dayNight', 'night')).toBe(true);
    expect(g.allow('gsi', 'dayNight', 'night', 100, 0)).toBe(true);
    expect(g.allow('screen', 'dayNight', 'night', 100 + CROSS_SOURCE_WINDOW_SEC - 1, 4000)).toBe(false);
    expect(g.allow('screen', 'dayNight', 'night', 100 + CROSS_SOURCE_WINDOW_SEC + 1, 6000)).toBe(true);
    // Порядок ключей объекта не важен
    expect(g.allow('gsi', 'kda', { kills: 1, deaths: 0, assists: 0 }, 200, 100_000)).toBe(true);
    expect(g.allow('screen', 'kda', { assists: 0, deaths: 0, kills: 1 }, 201, 101_000)).toBe(false);
    // Свой источник может повторить переход (например, ночь → день → ночь)
    expect(g.allow('gsi', 'dayNight', 'night', 102, 2000)).toBe(true);
  });
});

// ---------- тайник, телепорт, нейтральные (только GSI) ----------

describe('GSI: тайник, телепорт, нейтральный предмет', () => {
  /** Модель после первого чтения laning (знакомство — без событий) и шаг GSI: +step мс и +step/1000 с игрового времени */
  function setup() {
    const m = new MatchStateModel();
    let t = 0;
    m.ingestGsi(read('laning'), t);
    const step = (patch: (b: Record<string, any>) => void = () => undefined, ms = 500) => {
      t += ms;
      m.ingestGsi(
        read('laning', (b) => {
          b.map.clock_time = 485 + Math.floor(t / 1000);
          patch(b);
        }),
        t,
      );
    };
    const evs = () => m.snapshot(t).events.map((e) => ({ type: e.type, key: e.data.key }));
    return { m, step, evs, now: () => t };
  }
  const empty = { name: 'empty' };

  it('ячейки GSI в состоянии: тайник, телепорт, нейтральный предмет', () => {
    const { m, step, now } = setup();
    const x = m.snapshot(now()).hero.extraItems!;
    expect(x.map((s) => s.slot)).toEqual(['stash1', 'stash2', 'stash3', 'stash4', 'stash5', 'stash6', 'tp', 'neutral']);
    expect(x.find((s) => s.slot === 'stash1')!.value?.item?.key).toBe('blades_of_attack');
    expect(x.find((s) => s.slot === 'tp')!).toMatchObject({ source: 'gsi', tag: 'visible', value: { item: { key: 'tpscroll' } } });
    expect(x.find((s) => s.slot === 'neutral')!.value?.item?.key).toBe('occult_bracelet');
    // Зачарование (neutral1 → neutral2) впервые — знакомство, а не событие
    step((b) => (b.items.neutral1 = { name: 'item_enchantment_alert' }));
    expect(m.snapshot(now()).hero.extraItems!.at(-1)).toMatchObject({ slot: 'neutral2', value: { item: { key: 'enchantment_alert' } } });
    expect(m.snapshot(now()).events).toEqual([]);
    // Только экран — ячеек GSI нет
    expect(new MatchStateModel().snapshot(0).hero.extraItems).toBeUndefined();
  });

  it('тайник → инвентарь в одном запросе — не событие', () => {
    const { step, evs } = setup();
    step((b) => {
      b.items.stash0 = empty;
      b.items.slot4 = { name: 'item_blades_of_attack' };
    });
    expect(evs()).toEqual([]);
  });

  it('тайник → курьер → инвентарь в пределах 120 с — не событие; позже — новый предмет', () => {
    const { step, evs } = setup();
    step((b) => (b.items.stash0 = empty)); // уехал на курьере — не потеря
    expect(evs()).toEqual([]);
    for (let i = 0; i < 6; i++) step((b) => (b.items.stash0 = empty), 10_000); // ~60 с в пути
    step((b) => {
      b.items.stash0 = empty;
      b.items.slot4 = { name: 'item_blades_of_attack' };
    });
    expect(evs()).toEqual([]);

    // Второй раз курьер «едет» дольше COURIER_SEC — появление считается новым предметом
    const s2 = setup();
    s2.step((b) => (b.items.stash0 = empty));
    s2.step((b) => (b.items.stash0 = empty), (COURIER_SEC + 10) * 1000);
    s2.step((b) => {
      b.items.stash0 = empty;
      b.items.slot4 = { name: 'item_blades_of_attack' };
    });
    expect(s2.evs()).toEqual([{ type: 'item-gained', key: 'blades_of_attack' }]);
  });

  it('настоящая покупка в инвентарь и настоящая продажа', () => {
    const { step, evs } = setup();
    step((b) => (b.items.slot4 = { name: 'item_ogre_axe' }));
    expect(evs()).toEqual([{ type: 'item-gained', key: 'ogre_axe' }]);
    step((b) => {
      b.items.slot4 = { name: 'item_ogre_axe' };
      b.items.slot5 = empty; // продал палочку
    });
    expect(evs()).toEqual([
      { type: 'item-gained', key: 'ogre_axe' },
      { type: 'item-lost', key: 'magic_wand' },
    ]);
  });

  it('покупка в тайник — новый предмет', () => {
    const { step, evs } = setup();
    step((b) => (b.items.stash1 = { name: 'item_quelling_blade' }));
    expect(evs()).toEqual([{ type: 'item-gained', key: 'quelling_blade' }]);
  });

  it('телепорт израсходован и куплен снова — без событий', () => {
    const { step, evs } = setup();
    step((b) => (b.items.teleport0 = empty));
    step((b) => (b.items.teleport0 = { name: 'item_tpscroll', charges: 1 }));
    step((b) => (b.items.teleport0 = { name: 'item_tpscroll', charges: 3 }));
    step((b) => (b.items.teleport0 = empty));
    expect(evs()).toEqual([]);
  });

  it('сборка: пропали компоненты, появился новый предмет — одно item-gained, без item-lost', () => {
    const { step, evs } = setup();
    // Ботинки (ячейка 2) и клинки (тайник) → Phase Boots
    step((b) => {
      b.items.slot1 = { name: 'item_phase_boots' };
      b.items.stash0 = empty;
    });
    expect(evs()).toEqual([{ type: 'item-gained', key: 'phase_boots' }]);
    // Компонент из тайника ушёл в сборку, а не на курьер: такая же покупка потом — новый предмет
    step((b) => {
      b.items.slot1 = { name: 'item_phase_boots' };
      b.items.stash0 = empty;
      b.items.slot4 = { name: 'item_blades_of_attack' };
    });
    expect(evs()).toEqual([
      { type: 'item-gained', key: 'phase_boots' },
      { type: 'item-gained', key: 'blades_of_attack' },
    ]);
  });

  it('перекладывание между инвентарём, рюкзаком и тайником — не событие', () => {
    const { step, evs } = setup();
    step((b) => {
      b.items.slot0 = { name: 'item_branches' };
      b.items.slot7 = { name: 'item_bottle', charges: 2 };
    });
    step((b) => {
      b.items.slot0 = { name: 'item_branches' };
      b.items.slot7 = empty;
      b.items.stash2 = { name: 'item_bottle' };
    });
    expect(evs()).toEqual([]);
  });
});

// ---------- сверка зрения с GSI ----------

describe('AgreementTracker', () => {
  it('считает совпадения и расхождения по полям', () => {
    const a = new AgreementTracker();
    const g = read('laning');
    a.addGsi(g, 1000);
    a.addScreen(mine({ gold: 1335, level: 7, kda: [2, 1, 1], clock: 485 }), 1100);
    a.addScreen(mine({ gold: 1336, level: 7, kda: [2, 1, 1], clock: 486 }), 1900);
    a.addGsi(g, 2000);
    const r = a.report();
    expect(r.gold).toEqual({ samples: 2, agreePct: 50, lastMismatch: { gsi: 1335, screen: 1336, wallMs: 1900 } });
    expect(r.level).toMatchObject({ samples: 2, agreePct: 100, lastMismatch: null });
    expect(r.kda).toMatchObject({ samples: 2, agreePct: 100 });
    expect(r.clock).toMatchObject({ samples: 2, agreePct: 100 }); // время экстраполируется на момент кадра
  });

  it('здоровье и мана — с допуском 2 %', () => {
    const a = new AgreementTracker();
    a.addGsi(read('laning'), 0); // 812/980, 230/411
    a.addScreen(mine({ health: [831, 980], mana: [238, 411] }), 100); // +19 ≤ 19.6, +8 ≤ 8.2
    a.addScreen(mine({ health: [833, 980], mana: [239, 411] }), 200); // +21, +9 — уже нет
    const r = a.report();
    expect(r.health).toMatchObject({ samples: 2, agreePct: 50 });
    expect(r.mana).toMatchObject({ samples: 2, agreePct: 50 });
  });

  it('сравниваются только чтения в окне 1.5 с', () => {
    const a = new AgreementTracker();
    a.addGsi(read('laning'), 0);
    a.addScreen(mine({ gold: 1335 }), 1400);
    a.addScreen(mine({ gold: 1 }), 3000); // GSI рядом нет
    expect(a.report().gold?.samples).toBe(1);
  });

  it('значение сменилось между кадром и GSI — совпадение с любым чтением GSI в окне засчитывается', () => {
    const a = new AgreementTracker();
    a.addGsi(read('laning'), 0); // 1335
    a.addScreen(mine({ gold: 1360 }), 500);
    a.addGsi(read('laning', (b) => (b.player.gold = 1360)), 600);
    expect(a.report().gold).toMatchObject({ samples: 1, agreePct: 100 });
  });

  it('предметы — по ключу; способности — по ячейке; чужая панель не сравнивается', () => {
    const a = new AgreementTracker();
    a.addGsi(read('laning'), 0);
    a.addScreen(mine({ items: inventory(['bottle', 'boots', 'wraith_band', 'tango', null, 'magic_wand', null, 'branches', null]) }), 100);
    const abil: AbilitySlot[] = [
      { index: 0, state: 'cooldown', cooldown: 6, level: 3, confidence: 0.9 },
      { index: 1, state: 'ready', cooldown: null, level: 2, confidence: 0.9 },
    ];
    a.addScreen(mine({ abilities: abil }), 200);
    a.addScreen(screen({ unit: 'enemy', hero: AXE, gold: 5, level: 25 }), 300);
    const r = a.report();
    expect(r.items).toMatchObject({ samples: 9, agreePct: 88.9, lastMismatch: { gsi: 'inv4:wraith_band', screen: 'inv4:tango' } });
    expect(r.abilityState).toMatchObject({ samples: 2, agreePct: 100 });
    expect(r.abilityLevel).toMatchObject({ samples: 2, agreePct: 50 });
    expect(r.level?.samples ?? 0).toBe(0);
    expect(r.heroName).toMatchObject({ samples: 2, agreePct: 100 });
  });
});

// ---------- разметка ----------

describe('labelFromGsi', () => {
  it('тот же вид, что ручная разметка кадров (tests/fixtures/hud/labels.json)', () => {
    const l = labelFromGsi(read('laning'), { file: 'live/f-0001.png', split: 'test' });
    expect(l).toEqual({
      file: 'live/f-0001.png',
      split: 'test',
      selectedUnit: 'ally',
      fields: {
        gameClock: '8:05',
        scoreRadiant: '3',
        scoreDire: '2',
        gold: '1335',
        health: '812/980',
        mana: '230/411',
        level: '7',
        kda: '2/1/1',
        farm: '48/9',
      },
    });
  });

  it('до горна — preHorn и отрицательное время; отсутствующие поля не размечаются', () => {
    const l = labelFromGsi(read('pre-game', (b) => delete b.player));
    expect(l.preHorn).toBe(true);
    expect(l.fields.gameClock).toBe('-1:18');
    expect(l.fields.gold).toBeUndefined();
    expect(l.fields.kda).toBeUndefined();
  });
});
