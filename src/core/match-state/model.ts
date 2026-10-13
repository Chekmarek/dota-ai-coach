// Модель состояния матча: собирает шумные покадровые чтения HUD в устойчивое состояние с метками и событиями.
// Чистое ядро: ни Electron, ни DOM, ни часов — время всегда передаётся в ingest/snapshot.
import type { HudReading } from '../vision/recognize-hud.ts';
import type { Observed } from '../../shared/types/observation.ts';
import { ClockTracker } from './clock.ts';
import { StableField, VISIBLE_MS, unknownTracked } from './stable-field.ts';
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
  /** Чтения «свой юнит + имя» для определения героя игрока */
  sightings: { id: number; identity: HeroIdentity; wallMs: number }[] = [];
  lastPlayerReadingMs: number | null = null;
}

export class MatchStateModel {
  private clock = new ClockTracker();
  private scoreRadiant = new StableField<number>({ equals: same, decreases: lessNum });
  private scoreDire = new StableField<number>({ equals: same, decreases: lessNum });
  private dayNight = new StableField<DayNight>({ equals: same });
  private hero = new HeroTrack();
  private events: MatchEvent[] = [];

  /** Одно чтение HUD (один кадр). wallMs — время получения кадра */
  ingest(reading: HudReading, wallMs: number): void {
    const f = reading.fields;

    // 1. Время — первым: по нему узнаём новый матч
    for (const ev of this.clock.ingest(f.gameClock.value, f.gameClock.confidence, isValid(f.gameClock), wallMs)) {
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
    this.scoreRadiant.ingest(f.scoreRadiant.value, f.scoreRadiant.confidence, isValid(f.scoreRadiant), wallMs);
    this.scoreDire.ingest(f.scoreDire.value, f.scoreDire.confidence, isValid(f.scoreDire), wallMs);
    const dn = this.dayNight.ingest(reading.dayNight.value, reading.dayNight.confidence, isValid(reading.dayNight), wallMs);
    if (dn && dn.prev !== null) this.emit('day-night', wallMs, { from: dn.prev, to: dn.next });

    // 3. У/С/П и ДК/НО — блок слева вверху, всегда свой игрок (не зависит от выбранного юнита)
    const kda = this.hero.kda.ingest(f.kda.value, f.kda.confidence, isValid(f.kda), wallMs);
    if (kda?.prev) {
      const p = kda.prev, n = kda.next;
      if (n.kills > p.kills) this.emit('kill', wallMs, { from: p.kills, to: n.kills });
      if (n.deaths > p.deaths) this.emit('death', wallMs, { from: p.deaths, to: n.deaths });
      if (n.assists > p.assists) this.emit('assist', wallMs, { from: p.assists, to: n.assists });
    }
    this.hero.farm.ingest(f.farm.value, f.farm.confidence, isValid(f.farm), wallMs);

    // 4. Нижняя панель — только если на ней герой игрока
    this.trackIdentity(reading, wallMs);
    if (this.isPlayerReading(reading, wallMs)) this.ingestHero(reading, wallMs);
  }

  /** Состояние на момент wallMs */
  snapshot(wallMs: number): MatchState {
    const h = this.hero;
    const abilities: TrackedAbility[] = [...h.abilities.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([index, t]) => ({
        index,
        state: t.state.tracked(wallMs, TTL_MS.abilityState),
        level: t.level.tracked(wallMs, TTL_MS.level),
        cooldown: cooldownTracked(t.readyAt, wallMs),
      }));
    const items: TrackedItemSlot[] = SLOTS.map((slot) => ({ slot, ...h.items.get(slot)!.tracked(wallMs, TTL_MS.items) }));
    return {
      wallMs,
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
  }

  private emit(type: MatchEventType, wallMs: number, data: Record<string, unknown>): void {
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
    h.lastPlayerReadingMs = wallMs;
    if (isValid(r.heroName)) h.identity.ingest(r.heroName.value, 1, true, wallMs);
    else if (h.identity.value === null) h.identity.ingest(h.locked, 1, true, wallMs);

    const lvl = h.level.ingest(f.level.value, f.level.confidence, isValid(f.level), wallMs);
    if (lvl && lvl.prev !== null && lvl.next > lvl.prev) this.emit('level-up', wallMs, { from: lvl.prev, to: lvl.next });
    h.gold.ingest(f.gold.value, f.gold.confidence, isValid(f.gold), wallMs);
    h.health.ingest(f.health.value, f.health.confidence, isValid(f.health), wallMs);
    h.mana.ingest(f.mana.value, f.mana.confidence, isValid(f.mana), wallMs);

    for (const slot of r.abilities ?? []) this.ingestAbility(slot, wallMs);
    if (r.items) this.ingestItems(r.items, wallMs);
  }

  private ingestAbility(slot: NonNullable<HudReading['abilities']>[number], wallMs: number): void {
    let t = this.hero.abilities.get(slot.index);
    if (!t) {
      t = {
        state: new StableField<AbilityState>({ equals: same }),
        level: new StableField<number>({ equals: same, decreases: lessNum }),
        readyAt: new StableField<number>({ equals: (a, b) => Math.abs(a - b) < READY_TOLERANCE_MS }),
      };
      this.hero.abilities.set(slot.index, t);
    }
    const ok = slot.confidence >= MIN_SLOT_CONFIDENCE;
    t.state.ingest(slot.state, slot.confidence, ok, wallMs);
    const lvl = t.level.ingest(slot.level, slot.confidence, ok, wallMs);
    if (lvl && lvl.prev !== null && lvl.next > lvl.prev) this.emit('ability-learned', wallMs, { index: slot.index, from: lvl.prev, to: lvl.next });
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
    // Перекладывание между ячейками — не покупка и не потеря: сравниваем наборы предметов до и после
    for (const it of diff(after, before)) this.emit('item-gained', wallMs, { key: it.key, name: it.name });
    for (const it of diff(before, after)) this.emit('item-lost', wallMs, { key: it.key, name: it.name });
  }
}

type Item = { key: string; name: string };

/** Элементы a, которых нет в b (с учётом повторов) */
function diff(a: Item[], b: Item[]): Item[] {
  const rest = b.map((x) => x.key);
  const out: Item[] = [];
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
  };
}
