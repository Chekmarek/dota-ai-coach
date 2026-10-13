// Модель состояния матча: собирает шумные покадровые чтения HUD в устойчивое состояние с метками и событиями.
// С этапа «GSI» второй источник — Valve Game State Integration (ingestGsi): точные значения, главный источник.
// Пока GSI «живое» (последнее чтение моложе GSI_LIVE_MS), зрение не трогает поля, которые даёт GSI,
// и лишь дополняет недостающие. Когда GSI замолкает — поведение в точности как на этапе D.
// Чистое ядро: ни Electron, ни DOM, ни часов — время всегда передаётся в ingest/snapshot.
import type { HudReading } from '../vision/recognize-hud.ts';
import type { GsiPhase, GsiReading } from '../gsi/map.ts';
import type { Observed } from '../../shared/types/observation.ts';
import { ClockTracker } from './clock.ts';
import { StableField, VISIBLE_MS, unknownTracked, type FieldChange } from './stable-field.ts';
import { SourceEventGate } from './source-events.ts';
import type {
  AbilityState,
  DayNight,
  Farm,
  HeroIdentity,
  Kda,
  MatchEvent,
  MatchEventType,
  MatchState,
  Pool,
  SlotContent,
  Tracked,
  TrackedAbility,
  TrackedItemSlot,
} from './types.ts';

/** Сколько последних событий хранится */
export const EVENT_LIMIT = 100;
/** Ниже этой уверенности ячейка способности или предмета не учитывается (как MIN_CONFIDENCE распознавания) */
export const MIN_SLOT_CONFIDENCE = 0.5;

/** Герой игрока: одно и то же имя (свой юнит выбран) столько раз за окно — это он */
export const LOCK_READINGS = 8;
export const LOCK_WINDOW_MS = 30_000;
/** Чтение без имени ещё считается чтением игрока, если прошлое было не раньше этого */
export const NAMELESS_GRACE_MS = 3000;
/** GSI «живое», пока последнее чтение моложе этого (мс). Dota шлёт GSI при изменениях и по heartbeat */
export const GSI_LIVE_MS = 5000;
/** Зрение «живое», пока последний поддерживаемый кадр моложе этого (мс) */
export const SCREEN_LIVE_MS = 5000;

/** Поля, которые может дать GSI; пока GSI живое, зрение их не перезаписывает */
type GsiField = 'clock' | 'scoreRadiant' | 'scoreDire' | 'dayNight' | 'kda' | 'farm' | 'identity' | 'level' | 'gold' | 'health' | 'mana' | 'abilities' | 'items';

const MATCH_LONG = Number.POSITIVE_INFINITY;
/** Сколько помнить значение после последнего чтения, потом — «неизвестно» */
export const TTL_MS = {
  health: 10_000,
  mana: 10_000,
  gold: 60_000,
  items: 600_000,
  abilityState: 10_000,
  level: MATCH_LONG,
  kda: MATCH_LONG,
  farm: MATCH_LONG,
  score: MATCH_LONG,
  identity: MATCH_LONG,
  dayNight: MATCH_LONG,
} as const;

const SLOTS = ['inv1', 'inv2', 'inv3', 'inv4', 'inv5', 'inv6', 'bp1', 'bp2', 'bp3'];
/** Ячейки только из GSI (экран их не читает) */
export const EXTRA_SLOTS = ['stash1', 'stash2', 'stash3', 'stash4', 'stash5', 'stash6', 'tp', 'neutral', 'neutral2'];
/** Ключ свитка телепорта: его появление и исчезновение — не события */
const TP_KEY = 'tpscroll';
/** Предмет, ушедший из тайника, считается «на курьере» столько секунд игрового времени */
export const COURIER_SEC = 120;
const COURIER_LIMIT = 30;

const same = <T>(a: T, b: T) => a === b;
const samePool = (a: Pool, b: Pool) => a.current === b.current && a.max === b.max;
const sameKda = (a: Kda, b: Kda) => a.kills === b.kills && a.deaths === b.deaths && a.assists === b.assists;
const sameFarm = (a: Farm, b: Farm) => a.lastHits === b.lastHits && a.denies === b.denies;
const sameSlot = (a: SlotContent, b: SlotContent) => (a.item?.key ?? null) === (b.item?.key ?? null);
const lessNum = (prev: number, next: number) => next < prev;
const lessKda = (p: Kda, n: Kda) => n.kills < p.kills || n.deaths < p.deaths || n.assists < p.assists;
const lessFarm = (p: Farm, n: Farm) => n.lastHits < p.lastHits || n.denies < p.denies;

const isValid = <T>(o: Observed<T>) => o.validity === 'valid' && o.value !== null;

interface AbilityTrack {
  /** Ключ способности — только из GSI */
  key: string | null;
  state: StableField<AbilityState>;
  level: StableField<number>;
  /** Перезарядка хранится как момент готовности (мс): так соседние чтения сравнимы, хотя секунды убывают */
  readyAt: StableField<number>;
}

/** Моменты готовности считаются одинаковыми, если различаются меньше чем на 1.5 с */
const READY_TOLERANCE_MS = 1500;

class HeroTrack {
  locked: HeroIdentity | null = null;
  identity = new StableField<HeroIdentity>({ equals: (a, b) => a.id === b.id });
  level = new StableField<number>({ equals: same, decreases: lessNum });
  gold = new StableField<number>({ equals: same });
  health = new StableField<Pool>({ equals: samePool });
  mana = new StableField<Pool>({ equals: samePool });
  kda = new StableField<Kda>({ equals: sameKda, decreases: lessKda });
  farm = new StableField<Farm>({ equals: sameFarm, decreases: lessFarm });
  abilities = new Map<number, AbilityTrack>();
  // Смена содержимого ячейки должна продержаться 2 чтения — без приёма с первого чтения
  items = new Map(SLOTS.map((s) => [s, new StableField<SlotContent>({ equals: sameSlot, fastConfidence: null })]));
  /** Ячейки, которые даёт только GSI: тайник, телепорт, нейтральный предмет, зачарование */
  extra = new Map(EXTRA_SLOTS.map((s) => [s, new StableField<SlotContent>({ equals: sameSlot, fastConfidence: null })]));
  /** Ушли из тайника — возможно, едут на курьере */
  courier: { key: string; clock: number | null; wallMs: number }[] = [];
  /** Чтения «свой юнит + имя» для определения героя игрока */
  sightings: { id: number; identity: HeroIdentity; wallMs: number }[] = [];
  lastPlayerReadingMs: number | null = null;
}

export class MatchStateModel {
  /** Состояние GSI живёт вне clear(): сброс матча не забывает, что GSI работает */
  private gsi = {
    lastWallMs: null as number | null,
    provided: new Set<GsiField>(),
    matchId: null as string | null,
    phase: null as GsiPhase | null,
    /** Герой из последнего чтения GSI: другой герой — другая игра, даже без matchid (Hero Demo, лобби: matchid "0") */
    heroId: null as number | null,
  };
  private lastScreenMs: number | null = null;
  private clock = new ClockTracker();
  private scoreRadiant = new StableField<number>({ equals: same, decreases: lessNum });
  private scoreDire = new StableField<number>({ equals: same, decreases: lessNum });
  private dayNight = new StableField<DayNight>({ equals: same });
  private hero = new HeroTrack();
  private events: MatchEvent[] = [];
  private seq = 0;
  /** Какое значение каждого поля последним подтвердил каждый источник — события только по своим изменениям */
  private gate = new SourceEventGate();

  /** Растёт с каждым новым событием (и при сбросе) — по нему видно, что появилось событие */
  get eventSeq(): number {
    return this.seq;
  }

  /** GSI живое на момент wallMs */
  private gsiLive(wallMs: number): boolean {
    const t = this.gsi.lastWallMs;
    return t !== null && wallMs - t < GSI_LIVE_MS;
  }

  /** Поле сейчас приходит из GSI — чтение с экрана его не трогает */
  private fromGsi(field: GsiField, wallMs: number): boolean {
    return this.gsi.provided.has(field) && this.gsiLive(wallMs);
  }

  /** Одно чтение HUD (один кадр). wallMs — время получения кадра */
  ingest(reading: HudReading, wallMs: number): void {
    const f = reading.fields;
    if (reading.supported) this.lastScreenMs = wallMs;
    const gsi = (field: GsiField) => this.fromGsi(field, wallMs);

    // 1. Время — первым: по нему узнаём новый матч
    if (!gsi('clock')) for (const ev of this.clock.ingest(f.gameClock.value, f.gameClock.confidence, isValid(f.gameClock), wallMs)) {
      if (ev.type === 'pause' || ev.type === 'unpause') this.emit(ev.type, wallMs, {});
      else if (ev.type === 'match-reset') {
        // Новый матч: всё забываем, кроме только что принятого времени
        const clock = this.clock;
        this.clear();
        this.clock = clock;
        this.emit('match-reset', wallMs, { reason: 'clock-regression', from: ev.from, to: ev.to });
      }
    }

    // 2. Счёт и время суток — общие для матча
    if (!gsi('scoreRadiant')) this.scoreRadiant.ingest(f.scoreRadiant.value, f.scoreRadiant.confidence, isValid(f.scoreRadiant), wallMs);
    if (!gsi('scoreDire')) this.scoreDire.ingest(f.scoreDire.value, f.scoreDire.confidence, isValid(f.scoreDire), wallMs);
    // Значок над часами — день/ночь, только если на том же кадре прочитаны часы матча (не меньше 0:00):
    // до горна Dota показывает луну, хотя это не ночь, а в меню и на загрузке на месте значка может быть что угодно
    if (!gsi('dayNight') && isValid(f.gameClock) && f.gameClock.value! >= 0) {
      const ok = isValid(reading.dayNight);
      const dn = this.dayNight.ingest(reading.dayNight.value, reading.dayNight.confidence, ok, wallMs);
      const ev = this.screenTransition('dayNight', this.dayNight, dn, reading.dayNight.value, ok, wallMs);
      if (ev) this.emit('day-night', wallMs, { from: ev.prev, to: ev.next });
    }

    // 3. У/С/П и ДК/НО — блок слева вверху, всегда свой игрок (не зависит от выбранного юнита)
    if (!gsi('kda')) {
      const ok = isValid(f.kda);
      const ch = this.hero.kda.ingest(f.kda.value, f.kda.confidence, ok, wallMs);
      this.kdaEvents(this.screenTransition('kda', this.hero.kda, ch, f.kda.value, ok, wallMs), wallMs);
    }
    if (!gsi('farm')) this.hero.farm.ingest(f.farm.value, f.farm.confidence, isValid(f.farm), wallMs);

    // 4. Нижняя панель — только если на ней герой игрока (после GSI герой известен сразу, чужая панель отсекается)
    this.trackIdentity(reading, wallMs);
    if (this.isPlayerReading(reading, wallMs)) this.ingestHero(reading, wallMs);
  }

  /**
   * Одно чтение GSI. Значения точные: принимаются сразу (уверенность 1, метка «видно сейчас», источник gsi),
   * герой игрока определяется с первого чтения. Сброс матча — при смене matchid или возврате из игры в подготовку.
   * Первое чтение после тишины GSI только сверяет состояние: расхождения со зрением — исправления, а не события.
   */
  ingestGsi(reading: GsiReading, wallMs: number): void {
    const g = this.gsi;
    if (reading.matchId !== null && g.matchId !== null && reading.matchId !== g.matchId) {
      this.clear();
      this.emit('match-reset', wallMs, { reason: 'gsi-match-id', from: g.matchId, to: reading.matchId });
    } else if (g.phase === 'in-progress' && reading.phase === 'pre-game') {
      this.clear();
      this.emit('match-reset', wallMs, { reason: 'gsi-pre-game', gameState: reading.gameState });
    } else if (reading.hero.id !== null && g.heroId !== null && reading.hero.id !== g.heroId) {
      this.clear();
      this.emit('match-reset', wallMs, { reason: 'gsi-hero', from: g.heroId, to: reading.hero.id });
    }
    if (reading.hero.id !== null) g.heroId = reading.hero.id;
    const sync = !this.gsiLive(wallMs);
    // Первое чтение после тишины GSI — сверка: прежние значения GSI больше не «свои» для событий
    if (sync) this.gate.forget('gsi');
    const provided = new Set<GsiField>();
    g.lastWallMs = wallMs;
    if (reading.matchId !== null) g.matchId = reading.matchId;
    if (reading.phase !== null) g.phase = reading.phase;
    g.provided = provided;
    /** Изменение — событие по правилам source-events.ts; сверка после тишины GSI событием не бывает */
    const real = <T>(key: string, ch: FieldChange<T> | null, value: T) => this.gsiTransition(key, ch, value, sync, wallMs);

    // Время и пауза
    if (reading.clock !== null) {
      provided.add('clock');
      for (const ev of this.clock.force(reading.clock, reading.paused, wallMs)) this.emit(ev.type as 'pause' | 'unpause', wallMs, {});
    }
    if (reading.scoreRadiant !== null) {
      provided.add('scoreRadiant');
      this.scoreRadiant.force(reading.scoreRadiant, wallMs);
    }
    if (reading.scoreDire !== null) {
      provided.add('scoreDire');
      this.scoreDire.force(reading.scoreDire, wallMs);
    }
    if (reading.dayNight !== null) {
      provided.add('dayNight');
      const ev = real('dayNight', this.dayNight.force(reading.dayNight, wallMs), reading.dayNight);
      if (ev) this.emit('day-night', wallMs, { from: ev.prev, to: ev.next });
    }

    const h = this.hero;
    if (reading.kda !== null) {
      provided.add('kda');
      this.kdaEvents(real('kda', h.kda.force(reading.kda, wallMs), reading.kda), wallMs);
    }
    if (reading.farm !== null) {
      provided.add('farm');
      h.farm.force(reading.farm, wallMs);
    }
    if (reading.gold !== null) {
      provided.add('gold');
      h.gold.force(reading.gold, wallMs);
    }

    // Герой игрока: GSI сообщает именно его — фиксируется сразу
    const hero = reading.hero;
    if (hero.id !== null) {
      provided.add('identity');
      const prevName = h.identity.value?.id === hero.id ? h.identity.value.name : null;
      const identity: HeroIdentity = { id: hero.id, name: hero.name ?? prevName ?? hero.key };
      if (h.locked?.id !== hero.id || h.locked.name !== identity.name) h.locked = identity;
      h.sightings = [];
      h.identity.force(identity, wallMs);
    }
    if (hero.level !== null) {
      provided.add('level');
      const lvl = real('level', h.level.force(hero.level, wallMs), hero.level);
      if (lvl && lvl.next > lvl.prev) this.emit('level-up', wallMs, { from: lvl.prev, to: lvl.next });
    }
    if (hero.health !== null) {
      provided.add('health');
      h.health.force(hero.health, wallMs);
    }
    if (hero.mana !== null) {
      provided.add('mana');
      h.mana.force(hero.mana, wallMs);
    }

    // Способности — по номеру ячейки на панели (как у зрения); служебные (slot = null) пропускаются
    const onBar = reading.abilities.filter((a) => a.slot !== null);
    if (onBar.length > 0) {
      provided.add('abilities');
      for (const a of onBar) {
        const t = this.abilityTrack(a.slot!);
        t.key = a.key;
        if (a.level !== null) {
          const lvl = real(`ability:${a.slot}`, t.level.force(a.level, wallMs), a.level);
          if (lvl && lvl.next > lvl.prev) this.emit('ability-learned', wallMs, { index: a.slot, from: lvl.prev, to: lvl.next });
        }
        if (a.state !== null) t.state.force(a.state, wallMs);
        if (a.state === 'cooldown' && a.cooldownSec !== null) t.readyAt.force(wallMs + a.cooldownSec * 1000, wallMs);
        else if (a.cooldownSec === 0 || a.state === 'ready') t.readyAt.force(wallMs, wallMs);
      }
    }

    // Предметы: 6 ячеек и рюкзак, а также только из GSI — тайник, телепорт, нейтральный предмет и зачарование
    if (reading.items !== null) {
      provided.add('items');
      const before: Placed[] = [];
      const after: Placed[] = [];
      for (const it of reading.items) {
        const field = h.items.get(it.slot) ?? h.extra.get(it.slot);
        if (!field) continue;
        const content: SlotContent = { item: it.key === null ? null : { key: it.key, name: it.name ?? it.key } };
        // Сравниваем только со своим прежним значением GSI: ячейка, которую GSI видит впервые
        // (или которую до этого вёл экран), — знакомство или расхождение, а не покупка и не потеря
        const prev = field.source === 'gsi' ? field.value : null;
        field.force(content, wallMs);
        if (prev === null) continue;
        if (prev.item) before.push({ ...prev.item, slot: it.slot });
        if (content.item) after.push({ ...content.item, slot: it.slot });
      }
      if (!sync) this.gsiItemEvents(before, after, wallMs);
    }
  }

  /**
   * События предметов по GSI — по всем ячейкам героя вместе (инвентарь, рюкзак, тайник, нейтральные):
   * перекладывание между ячейками — не событие. Телепорт событий не даёт никогда (заряды, пустая ячейка, новый свиток).
   * Ушедшее из тайника может ехать на курьере (GSI курьера не показывает): это не потеря, а если тот же предмет
   * появится у героя в течение COURIER_SEC игрового времени — и не новый предмет.
   * Сборка: в одном запросе пропали предметы и появился новый — сообщаем только о новом.
   */
  private gsiItemEvents(before: Placed[], after: Placed[], wallMs: number): void {
    const h = this.hero;
    const counted = (x: Placed) => x.slot !== 'tp' && x.key !== TP_KEY;
    const b = before.filter(counted);
    const a = after.filter(counted);
    const gained = diff(a, b);
    const lost = diff(b, a);
    const clock = this.clock.at(wallMs);
    h.courier = h.courier.filter((c) => !courierExpired(c, clock, wallMs));
    for (const it of gained) {
      const i = h.courier.findIndex((c) => c.key === it.key);
      if (i >= 0) h.courier.splice(i, 1); // приехал курьером — куплен раньше
      else this.emit('item-gained', wallMs, { key: it.key, name: it.name });
    }
    // Компоненты ушли в собранный предмет — это не потеря
    if (gained.length > 0 && lost.length > 0) return;
    // Сколько экземпляров каждого предмета ушло из тайника и не появилось в других ячейках
    const fromStash = new Map<string, number>();
    const stashCount = (list: Placed[], key: string) => list.filter((x) => x.slot.startsWith('stash') && x.key === key).length;
    for (const it of lost) if (!fromStash.has(it.key)) fromStash.set(it.key, Math.max(0, stashCount(b, it.key) - stashCount(a, it.key)));
    for (const it of lost) {
      const left = fromStash.get(it.key) ?? 0;
      if (left > 0) {
        fromStash.set(it.key, left - 1);
        h.courier.push({ key: it.key, clock, wallMs });
        if (h.courier.length > COURIER_LIMIT) h.courier.shift();
      } else this.emit('item-lost', wallMs, { key: it.key, name: it.name });
    }
  }

  /** Состояние на момент wallMs */
  snapshot(wallMs: number): MatchState {
    const h = this.hero;
    const abilities: TrackedAbility[] = [...h.abilities.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, t]) => ({
        index,
        key: t.key,
        state: t.state.tracked(wallMs, TTL_MS.abilityState),
        level: t.level.tracked(wallMs, TTL_MS.level),
        cooldown: cooldownTracked(t.readyAt, wallMs),
      }));
    const items: TrackedItemSlot[] = SLOTS.map((slot) => ({ slot, ...h.items.get(slot)!.tracked(wallMs, TTL_MS.items) }));
    // Тайник, телепорт и нейтральные — только ячейки, которые GSI уже присылал
    const extraItems: TrackedItemSlot[] = EXTRA_SLOTS.filter((slot) => h.extra.get(slot)!.value !== null).map((slot) => ({
      slot,
      ...h.extra.get(slot)!.tracked(wallMs, TTL_MS.items),
    }));
    return {
      wallMs,
      sources: {
        gsi: this.gsiLive(wallMs),
        screen: this.lastScreenMs !== null && wallMs - this.lastScreenMs < SCREEN_LIVE_MS,
      },
      match: {
        clock: this.clock.tracked(wallMs),
        paused: this.clock.paused,
        scoreRadiant: this.scoreRadiant.tracked(wallMs, TTL_MS.score),
        scoreDire: this.scoreDire.tracked(wallMs, TTL_MS.score),
        dayNight: this.dayNight.tracked(wallMs, TTL_MS.dayNight),
      },
      hero: {
        locked: h.locked !== null,
        identity: h.locked ? h.identity.tracked(wallMs, TTL_MS.identity) : unknownTracked(),
        level: h.level.tracked(wallMs, TTL_MS.level),
        gold: h.gold.tracked(wallMs, TTL_MS.gold),
        health: h.health.tracked(wallMs, TTL_MS.health),
        mana: h.mana.tracked(wallMs, TTL_MS.mana),
        kda: h.kda.tracked(wallMs, TTL_MS.kda),
        farm: h.farm.tracked(wallMs, TTL_MS.farm),
        abilities,
        items,
        ...(extraItems.length > 0 ? { extraItems } : {}),
      },
      events: [...this.events],
    };
  }

  /** Сброс вручную (новый матч): событие и чистое состояние */
  reset(wallMs = 0): void {
    this.clear();
    this.emit('match-reset', wallMs, { reason: 'manual' });
  }

  private clear(): void {
    this.clock = new ClockTracker();
    this.scoreRadiant = new StableField<number>({ equals: same, decreases: lessNum });
    this.scoreDire = new StableField<number>({ equals: same, decreases: lessNum });
    this.dayNight = new StableField<DayNight>({ equals: same });
    this.hero = new HeroTrack();
    this.events = [];
    this.gate.reset();
  }

  /**
   * Чтение с экрана подтвердило значение поля (приняло новое или совпало с принятым). Событие — только если
   * изменилось прежнее значение САМОГО экрана и GSI не сообщил тот же переход только что (source-events.ts).
   */
  private screenTransition<T>(key: string, field: StableField<T>, ch: FieldChange<T> | null, value: T | null, valid: boolean, wallMs: number): { prev: T; next: T } | null {
    const seen = ch ? ch.next : valid && field.matches(value) ? field.value : null;
    if (seen === null) return null;
    const changed = this.gate.observe('screen', key, seen);
    if (!ch || ch.prev === null || !changed) return null;
    return this.gate.allow('screen', key, ch.next, this.clock.at(wallMs), wallMs) ? { prev: ch.prev, next: ch.next } : null;
  }

  /** Значение поля из GSI. Пока поле ведёт GSI, экран его не трогает — его следующее значение снова будет «первым» */
  private gsiTransition<T>(key: string, ch: FieldChange<T> | null, value: T, sync: boolean, wallMs: number): { prev: T; next: T } | null {
    const changed = this.gate.observe('gsi', key, value);
    this.gate.forget('screen', key);
    if (sync || !ch || ch.prev === null || !changed) return null;
    return this.gate.allow('gsi', key, ch.next, this.clock.at(wallMs), wallMs) ? { prev: ch.prev, next: ch.next } : null;
  }

  private emit(type: MatchEventType, wallMs: number, data: Record<string, unknown>): void {
    this.seq++;
    this.events.push({ type, wallMs, clock: this.clock.at(wallMs), data });
    if (this.events.length > EVENT_LIMIT) this.events.splice(0, this.events.length - EVENT_LIMIT);
  }

  /** Копит чтения «свой юнит + имя»; одно имя ≥ LOCK_READINGS раз за LOCK_WINDOW_MS — герой игрока */
  private trackIdentity(r: HudReading, wallMs: number): void {
    const h = this.hero;
    if (h.locked || r.selectedUnit.value !== 'ally' || !isValid(r.selectedUnit) || !isValid(r.heroName)) return;
    const identity = r.heroName.value!;
    h.sightings = h.sightings.filter((s) => wallMs - s.wallMs <= LOCK_WINDOW_MS);
    h.sightings.push({ id: identity.id, identity, wallMs });
    const count = h.sightings.reduce((n, s) => (s.id === identity.id ? n + 1 : n), 0);
    if (count >= LOCK_READINGS) {
      h.locked = identity;
      h.sightings = [];
    }
  }

  /** Нижняя панель показывает героя игрока, а не выбранного союзника или врага */
  private isPlayerReading(r: HudReading, wallMs: number): boolean {
    const h = this.hero;
    if (!h.locked || r.selectedUnit.value !== 'ally' || !isValid(r.selectedUnit)) return false;
    if (isValid(r.heroName)) return r.heroName.value!.id === h.locked.id;
    // Имя не прочиталось: верим, только если игрок был на панели только что и уровень тот же
    const lvl = r.fields.level;
    return (
      r.heroName.value === null &&
      h.lastPlayerReadingMs !== null &&
      wallMs - h.lastPlayerReadingMs < NAMELESS_GRACE_MS &&
      isValid(lvl) &&
      h.level.value !== null &&
      lvl.value === h.level.value
    );
  }

  private ingestHero(r: HudReading, wallMs: number): void {
    const h = this.hero;
    const f = r.fields;
    const gsi = (field: GsiField) => this.fromGsi(field, wallMs);
    h.lastPlayerReadingMs = wallMs;
    if (!gsi('identity')) {
      if (isValid(r.heroName)) h.identity.ingest(r.heroName.value, 1, true, wallMs);
      else if (h.identity.value === null) h.identity.ingest(h.locked, 1, true, wallMs);
    }

    if (!gsi('level')) {
      const ok = isValid(f.level);
      const lvl = this.screenTransition('level', h.level, h.level.ingest(f.level.value, f.level.confidence, ok, wallMs), f.level.value, ok, wallMs);
      if (lvl && lvl.next > lvl.prev) this.emit('level-up', wallMs, { from: lvl.prev, to: lvl.next });
    }
    if (!gsi('gold')) h.gold.ingest(f.gold.value, f.gold.confidence, isValid(f.gold), wallMs);
    if (!gsi('health')) h.health.ingest(f.health.value, f.health.confidence, isValid(f.health), wallMs);
    if (!gsi('mana')) h.mana.ingest(f.mana.value, f.mana.confidence, isValid(f.mana), wallMs);

    if (!gsi('abilities')) for (const slot of r.abilities ?? []) this.ingestAbility(slot, wallMs);
    if (r.items && !gsi('items')) this.ingestItems(r.items, wallMs);
  }

  private abilityTrack(index: number): AbilityTrack {
    let t = this.hero.abilities.get(index);
    if (!t) {
      t = {
        key: null,
        state: new StableField<AbilityState>({ equals: same }),
        level: new StableField<number>({ equals: same, decreases: lessNum }),
        readyAt: new StableField<number>({ equals: (a, b) => Math.abs(a - b) < READY_TOLERANCE_MS }),
      };
      this.hero.abilities.set(index, t);
    }
    return t;
  }

  private kdaEvents(kda: { prev: Kda; next: Kda } | null, wallMs: number): void {
    if (!kda) return;
    const p = kda.prev, n = kda.next;
    if (n.kills > p.kills) this.emit('kill', wallMs, { from: p.kills, to: n.kills });
    if (n.deaths > p.deaths) this.emit('death', wallMs, { from: p.deaths, to: n.deaths });
    if (n.assists > p.assists) this.emit('assist', wallMs, { from: p.assists, to: n.assists });
  }

  /** Перекладывание между ячейками — не покупка и не потеря: сравниваем наборы предметов до и после */
  private itemEvents(before: Item[], after: Item[], wallMs: number): void {
    for (const it of diff(after, before)) this.emit('item-gained', wallMs, { key: it.key, name: it.name });
    for (const it of diff(before, after)) this.emit('item-lost', wallMs, { key: it.key, name: it.name });
  }

  private ingestAbility(slot: NonNullable<HudReading['abilities']>[number], wallMs: number): void {
    const t = this.abilityTrack(slot.index);
    const ok = slot.confidence >= MIN_SLOT_CONFIDENCE;
    t.state.ingest(slot.state, slot.confidence, ok, wallMs);
    const lvl = this.screenTransition(`ability:${slot.index}`, t.level, t.level.ingest(slot.level, slot.confidence, ok, wallMs), slot.level, ok, wallMs);
    if (lvl && lvl.next > lvl.prev) this.emit('ability-learned', wallMs, { index: slot.index, from: lvl.prev, to: lvl.next });
    if (ok && slot.state === 'cooldown' && slot.cooldown !== null) t.readyAt.ingest(wallMs + slot.cooldown * 1000, slot.confidence, true, wallMs);
    // Способность готова — перезарядка закончилась
    else if (ok && slot.state === 'ready') t.readyAt.ingest(wallMs, slot.confidence, true, wallMs);
  }

  private ingestItems(slots: NonNullable<HudReading['items']>, wallMs: number): void {
    const before: Item[] = [];
    const after: Item[] = [];
    let changed = false;
    for (const s of slots) {
      const field = this.hero.items.get(s.slot);
      if (!field) continue;
      // Предмет в ячейке есть, но не узнан — чтение ячейки не учитываем
      const valid = s.confidence >= MIN_SLOT_CONFIDENCE && (s.empty || s.item !== null);
      const content: SlotContent = { item: s.empty || !s.item ? null : { key: s.item.key, name: s.item.name } };
      const ch = field.ingest(content, s.confidence, valid, wallMs);
      // Первое знакомство с ячейкой — не покупка и не потеря
      if (ch && ch.prev !== null) {
        changed = true;
        if (ch.prev.item) before.push(ch.prev.item);
        if (ch.next.item) after.push(ch.next.item);
      }
    }
    if (!changed) return;
    this.itemEvents(before, after, wallMs);
  }
}

type Item = { key: string; name: string };
/** Предмет и ячейка, где он лежит */
type Placed = Item & { slot: string };

/** Срок «на курьере» вышел: по игровому времени, если оно известно в оба момента, иначе по «настенному» */
function courierExpired(c: { clock: number | null; wallMs: number }, clock: number | null, wallMs: number): boolean {
  if (c.clock !== null && clock !== null) return clock - c.clock > COURIER_SEC || clock < c.clock - 1;
  return wallMs - c.wallMs > COURIER_SEC * 1000;
}

/** Элементы a, которых нет в b (с учётом повторов) */
function diff<T extends Item>(a: T[], b: T[]): T[] {
  const rest = b.map((x) => x.key);
  const out: T[] = [];
  for (const x of a) {
    const i = rest.indexOf(x.key);
    if (i >= 0) rest.splice(i, 1);
    else out.push(x);
  }
  return out;
}

/** Остаток перезарядки: прочитанное значение минус прошедшее время, не меньше нуля */
function cooldownTracked(readyAt: StableField<number>, wallMs: number): Tracked<number> {
  if (readyAt.value === null || readyAt.lastSeenWallMs === null) return unknownTracked();
  const fresh = wallMs - readyAt.lastSeenWallMs < VISIBLE_MS;
  return {
    value: Math.max(0, (readyAt.value - wallMs) / 1000),
    confidence: readyAt.confidence,
    tag: fresh ? 'visible' : 'inferred',
    lastSeenWallMs: readyAt.lastSeenWallMs,
    firstSeenWallMs: readyAt.firstSeenWallMs,
    source: readyAt.source,
  };
}
