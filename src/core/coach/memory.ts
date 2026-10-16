// Память матча для правил и разборов: история по секундам, смерти, покупки, события карты, подозрение на смок.
// Чистое ядро: время — из снимка (wallMs), игровые часы — из фактов.
import type { MapPoint } from '../match-state/index.ts';
import type { MapZone } from '../match-state/map-zones.ts';
import { CLOSE_UNITS, NEAR_UNITS, dist, mapSide } from './geo.ts';
import { TP_ITEMS, REGEN_ITEMS } from './data.ts';
import { poolPct, type CoachView, type ViewPlayer } from './view.ts';

/** Сколько секунд истории держим (по одной записи в секунду) */
export const HISTORY_SEC = 900;
/** Подозрение на смок: столько врагов пропало за SMOKE_WINDOW_MS */
export const SMOKE_MIN_HEROES = 3;
export const SMOKE_WINDOW_MS = 5000;
/** Простой: позиция не меняется больше чем на IDLE_UNITS и нет новых приказов */
export const IDLE_UNITS = 150;

export interface Sample {
  wallMs: number;
  clock: number | null;
  alive: boolean | null;
  hpPct: number | null;
  manaPct: number | null;
  gold: number | null;
  lastHits: number | null;
  commands: number | null;
  pos: MapPoint | null;
  zone: MapZone | null;
  /** Врагов видно рядом (мини-карта ближе NEAR_UNITS или полоска здоровья на экране) */
  enemiesNear: number;
  alliesNear: number;
  enemiesMissing: number;
  enemiesDead: number;
  alliesDead: number;
}

export interface DeathRecord {
  clock: number | null;
  wallMs: number;
  zone: MapZone | null;
  side: 'own' | 'river' | 'enemy' | null;
  night: boolean | null;
  /** Максимум здоровья за 10 с до смерти, % */
  hpBefore: number | null;
  /** За сколько секунд здоровье упало от hpBefore до 0 */
  dropSec: number | null;
  enemiesNear: number;
  alliesNear: number;
  enemiesMissing: number;
  ultReady: boolean | null;
  keyItemsReady: string[];
  tpReady: boolean | null;
  hadRegen: boolean | null;
  buybackReady: boolean | null;
  gold: number | null;
  buybackCost: number | null;
  respawnSec: number | null;
  /** Оценка «вступать» в начале драки, если была */
  engageAtEntry: number | null;
}

export interface MemoryEvents {
  died: DeathRecord | null;
  respawned: boolean;
  levelUp: number | null;
  newItems: string[];
  /** Враги, пропавшие почти одновременно (подозрение на смок) */
  smoke: number[] | null;
  /** Союзник умер (ячейки) */
  allyDied: number[];
  enemyDied: number[];
  roshanKilled: boolean;
  aegisPicked: boolean;
  matchReset: boolean;
}

export function enemyNear(p: ViewPlayer, me: MapPoint | null): boolean {
  if (p.alive.value === false) return false;
  if (p.pos.value && p.pos.ageSec !== null && p.pos.ageSec <= 2 && me) return dist(p.pos.value, me) <= NEAR_UNITS;
  return false;
}

export function ultReady(v: CoachView): boolean | null {
  const ult = v.me.abilities.find((a) => a.ultimate);
  if (!ult || ult.level === null) return null;
  if (ult.level === 0) return false;
  if (ult.state === 'ready') return true;
  if (ult.state === 'cooldown' || ult.state === 'no-mana') return false;
  return ult.cooldownSec === null ? null : ult.cooldownSec === 0;
}

export function readyItems(v: CoachView, keys: readonly string[]): string[] {
  return v.me.items.filter((i) => keys.includes(i.key) && !i.slot.startsWith('stash') && !i.slot.startsWith('bp') && i.cooldownSec === 0).map((i) => i.key);
}

export function hasItem(v: CoachView, keys: readonly string[], opts: { inventoryOnly?: boolean } = {}): boolean {
  return v.me.items.some((i) => keys.includes(i.key) && (!opts.inventoryOnly || !(i.slot.startsWith('stash') || i.slot.startsWith('bp'))) && (i.charges === null || i.charges > 0));
}

export function tpReady(v: CoachView): boolean | null {
  if (!v.me.itemsKnown) return null;
  const tp = v.me.items.find((i) => TP_ITEMS.includes(i.key) && !i.slot.startsWith('stash'));
  if (!tp) return false;
  if (tp.charges !== null && tp.charges <= 0) return false;
  return tp.cooldownSec === null ? null : tp.cooldownSec === 0;
}

export function hasRegen(v: CoachView): boolean | null {
  if (!v.me.itemsKnown) return null;
  return v.me.items.some((i) => REGEN_ITEMS[i.key] !== undefined && !i.slot.startsWith('stash') && (i.charges === null || i.charges > 0));
}

export class CoachMemory {
  samples: Sample[] = [];
  deaths: DeathRecord[] = [];
  /** Игровое время своих убийств и помощи (по счётчикам GSI) */
  kills: number[] = [];
  assists: number[] = [];
  /** Первое появление предмета у героя: ключ → игровое время */
  items = new Map<string, number>();
  roshanKilledAt: number | null = null;
  aegisAt: number | null = null;
  aegisOurs: boolean | null = null;
  tormentorKilledAt: number | null = null;
  smokes: { wallMs: number; slots: number[] }[] = [];
  /** С какого момента (wallMs) герой стоит без дела; null — двигается */
  idleSinceMs: number | null = null;
  /** С какого момента (игровое время) золота больше порога */
  goldHighSince: number | null = null;
  /** Оценка «вступать» на входе в текущую драку */
  engageAtEntry: number | null = null;
  inFightSinceMs: number | null = null;
  matchId: string | null = null;
  lastClock: number | null = null;
  private prev: CoachView | null = null;
  private lastSampleMs = 0;
  private missingSince = new Map<number, number>();
  private seenEventKeys = new Set<string>();
  /** Объявленные одноразовые вещи: «6 уровень у врага X» и т. п. */
  readonly once = new Set<string>();
  /** Числовые метки правил между тиками (прошлое здоровье здания, начало непотраченного очка и т. п.) */
  readonly marks = new Map<string, number>();

  reset(): void {
    Object.assign(this, new CoachMemory());
  }

  last(sec: number, now: number): Sample[] {
    return this.samples.filter((s) => now - s.wallMs <= sec * 1000);
  }

  ingest(v: CoachView, goldThreshold: number): MemoryEvents {
    const ev: MemoryEvents = { died: null, respawned: false, levelUp: null, newItems: [], smoke: null, allyDied: [], enemyDied: [], roshanKilled: false, aegisPicked: false, matchReset: false };
    const clock = v.clock.value;
    // Новый матч: другой matchId или часы ушли назад больше чем на минуту
    if ((v.matchId && this.matchId && v.matchId !== this.matchId) || (clock !== null && this.lastClock !== null && clock < this.lastClock - 60)) {
      this.reset();
      ev.matchReset = true;
    }
    if (v.matchId) this.matchId = v.matchId;
    if (clock !== null) this.lastClock = clock;
    const p = this.prev;
    const me = v.me.pos.value;

    const enemiesNear = v.enemies.filter((e) => enemyNear(e, me)).length;
    const alliesNear = me ? v.allies.filter((a) => a.alive.value !== false && a.pos.value && (a.pos.ageSec ?? 99) <= 2 && dist(a.pos.value, me) <= NEAR_UNITS).length : 0;

    // Смерть / возрождение
    const alive = v.me.alive.value;
    if (p && p.me.alive.value === true && alive === false) {
      const hist = this.last(10, v.wallMs);
      const hpVals = hist.map((s) => s.hpPct).filter((x): x is number => x !== null);
      const maxHp = hpVals.length ? Math.max(...hpVals) : null;
      const maxAt = maxHp !== null ? hist.find((s) => s.hpPct === maxHp)?.wallMs ?? null : null;
      const recent = this.last(5, v.wallMs);
      const cost = p.me.buybackCost.value;
      const bbCd = p.me.buybackCooldown.value;
      const gold = p.me.gold.value;
      this.deaths.push({
        clock,
        wallMs: v.wallMs,
        zone: p.me.zone,
        side: p.me.pos.value && v.team ? mapSide(p.me.pos.value, v.team) : null,
        night: v.dayNight.value === null ? null : v.dayNight.value === 'night',
        hpBefore: maxHp,
        dropSec: maxAt !== null ? (v.wallMs - maxAt) / 1000 : null,
        enemiesNear: Math.max(enemiesNear, ...recent.map((s) => s.enemiesNear)),
        alliesNear: Math.max(alliesNear, ...recent.map((s) => s.alliesNear)),
        enemiesMissing: p ? p.enemies.filter((e) => e.missing === true).length : 0,
        ultReady: ultReady(p),
        keyItemsReady: readyItems(p, ['black_king_bar', 'blink', 'refresher', 'aeon_disk', 'manta', 'satanic', 'sphere', 'ghost', 'glimmer_cape', 'force_staff']),
        tpReady: tpReady(p),
        hadRegen: hasRegen(p),
        buybackReady: cost !== null && bbCd !== null && gold !== null ? bbCd === 0 && gold >= cost : null,
        gold,
        buybackCost: cost,
        respawnSec: v.me.respawnSec.value,
        engageAtEntry: this.engageAtEntry,
      });
      ev.died = this.deaths[this.deaths.length - 1]!;
    }
    if (p && p.me.alive.value === false && alive === true) ev.respawned = true;

    // Убийства и помощь
    if (p && clock !== null) {
      const dk = (v.me.kills.value ?? 0) - (p.me.kills.value ?? v.me.kills.value ?? 0);
      const da = (v.me.assists.value ?? 0) - (p.me.assists.value ?? v.me.assists.value ?? 0);
      for (let i = 0; i < dk && i < 5; i++) this.kills.push(clock);
      for (let i = 0; i < da && i < 5; i++) this.assists.push(clock);
    }

    // Уровень
    if (p && p.me.level.value !== null && v.me.level.value !== null && v.me.level.value > p.me.level.value) ev.levelUp = v.me.level.value;

    // Покупки (первое появление предмета)
    if (clock !== null && v.me.itemsKnown) {
      for (const it of v.me.items) {
        if (!this.items.has(it.key)) {
          this.items.set(it.key, clock);
          if (p) ev.newItems.push(it.key);
        }
      }
    }

    // Смерти героев по верхней панели
    if (p) {
      const died = (list: ViewPlayer[], prev: ViewPlayer[]) =>
        list.filter((x) => x.alive.value === false && prev.find((y) => y.slot === x.slot)?.alive.value === true).map((x) => x.slot);
      ev.allyDied = died(v.allies, p.allies);
      ev.enemyDied = died(v.enemies, p.enemies);
    }

    // Подозрение на смок: несколько живых врагов пропали почти одновременно
    for (const e of v.enemies) {
      if (e.missing === true && !this.missingSince.has(e.slot)) this.missingSince.set(e.slot, v.wallMs - (e.missingForSec ?? 0) * 1000);
      if (e.missing !== true) this.missingSince.delete(e.slot);
    }
    const fresh = [...this.missingSince.entries()].filter(([, t]) => v.wallMs - t <= SMOKE_WINDOW_MS + 3000);
    if (fresh.length >= SMOKE_MIN_HEROES) {
      const times = fresh.map(([, t]) => t);
      const lastSmoke = this.smokes[this.smokes.length - 1];
      if (Math.max(...times) - Math.min(...times) <= SMOKE_WINDOW_MS && (!lastSmoke || v.wallMs - lastSmoke.wallMs > 60_000)) {
        const slots = fresh.map(([s]) => s);
        this.smokes.push({ wallMs: v.wallMs, slots });
        ev.smoke = slots;
      }
    }

    // События карты из GSI
    for (const e of v.events ?? []) {
      const key = `${e.type}@${e.gameTime}`;
      if (this.seenEventKeys.has(key)) continue;
      this.seenEventKeys.add(key);
      // gameTime — время с загрузки карты; в игровые часы — через разницу из GSI
      const at = e.gameTime !== null && v.clockOffset !== null ? Math.round(e.gameTime - v.clockOffset) : clock;
      if (e.type === 'roshan_killed') {
        this.roshanKilledAt = at;
        ev.roshanKilled = true;
      } else if (e.type === 'aegis_picked_up') {
        this.aegisAt = at;
        this.aegisOurs = e.team === null || v.team === null ? null : e.team === v.team;
        ev.aegisPicked = true;
      } else if (e.type === 'tormentor_killed') {
        this.tormentorKilledAt = at;
      }
    }

    // Простой
    const cmdChanged = p && p.me.commands.value !== null && v.me.commands.value !== null && v.me.commands.value !== p.me.commands.value;
    const lastPos = this.samples.length ? this.samples[this.samples.length - 1]!.pos : null;
    const moved = me && lastPos ? dist(me, lastPos) > IDLE_UNITS : false;
    const canIdle = alive === true && v.inGame && !v.paused && me !== null;
    if (!canIdle || moved || cmdChanged) this.idleSinceMs = null;
    else this.idleSinceMs ??= v.wallMs;

    // Непотраченное золото
    const gold = v.me.gold.value;
    if (gold !== null && clock !== null) this.goldHighSince = gold >= goldThreshold ? (this.goldHighSince ?? clock) : null;

    // Драка
    const inFight = alive === true && enemiesNear > 0 && me !== null && v.enemies.some((e) => enemyNear(e, me) && e.pos.value && dist(e.pos.value, me) <= CLOSE_UNITS);
    if (inFight) this.inFightSinceMs ??= v.wallMs;
    else if (this.inFightSinceMs !== null && enemiesNear === 0) {
      this.inFightSinceMs = null;
      this.engageAtEntry = null;
    }

    // Запись истории раз в секунду
    if (v.wallMs - this.lastSampleMs >= 1000) {
      this.lastSampleMs = v.wallMs;
      this.samples.push({
        wallMs: v.wallMs,
        clock,
        alive,
        hpPct: poolPct(v.me.hp.value),
        manaPct: poolPct(v.me.mana.value),
        gold,
        lastHits: v.me.lastHits.value,
        commands: v.me.commands.value,
        pos: me,
        zone: v.me.zone,
        enemiesNear,
        alliesNear,
        enemiesMissing: v.enemies.filter((e) => e.missing === true).length,
        enemiesDead: v.enemies.filter((e) => e.alive.value === false).length,
        alliesDead: v.allies.filter((e) => e.alive.value === false).length,
      });
      if (this.samples.length > HISTORY_SEC) this.samples.splice(0, this.samples.length - HISTORY_SEC);
    }
    this.prev = v;
    return ev;
  }

  get inFight(): boolean {
    return this.inFightSinceMs !== null;
  }
}
