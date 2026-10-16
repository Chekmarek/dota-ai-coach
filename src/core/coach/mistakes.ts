// F. Обнаружение ошибок: каждая — с игровым временем (для перехода к записи) и тем, что делать вместо.
// Пишутся в журнал матча; ИИ (если доступен) пересказывает каждую одной фразой. Чистое ядро.
import { mapZone, MAP_ZONE_RU } from '../match-state/map-zones.ts';
import { dist } from './geo.ts';
import { laneRole } from './rules/laning.ts';
import { mmss, type RuleContext } from './rules/context.ts';
import { derivedFact } from './view.ts';
import type { FactRef } from './types.ts';
import type { DeathRecord } from './memory.ts';

export type MistakeType =
  | 'died-unused'
  | 'joined-losing-fight'
  | 'overextended'
  | 'fog-night'
  | 'no-tp'
  | 'missed-fight'
  | 'idle'
  | 'unspent-gold'
  | 'late-item'
  | 'poor-cs'
  | 'missed-rune';

export const MISTAKE_RU: Record<MistakeType, string> = {
  'died-unused': 'Смерть с неиспользованными ресурсами',
  'joined-losing-fight': 'Вступили в проигрышную драку',
  overextended: 'Зашли далеко без обзора',
  'fog-night': 'Один в тумане ночью',
  'no-tp': 'Нет ТП, когда он был нужен',
  'missed-fight': 'Команда дралась без вас',
  idle: 'Простой',
  'unspent-gold': 'Золото долго не тратилось',
  'late-item': 'Поздний ключевой предмет',
  'poor-cs': 'Мало добиваний',
  'missed-rune': 'Пропущенная руна',
};

export interface Mistake {
  id: string;
  type: MistakeType;
  /** Игровое время (с) — для перехода к моменту записи */
  clock: number | null;
  wallMs: number;
  /** 1 — мелочь, 3 — стоило смерти или драки */
  severity: 1 | 2 | 3;
  /** Что случилось (шаблон) */
  text: string;
  /** Что делать вместо */
  instead: string;
  facts: FactRef[];
  /** Объяснение ИИ одной фразой (если успел) */
  aiText?: string | null;
  /** Связана со смертью №… (индекс в memory.deaths) */
  deathIndex?: number;
}

const GOAL_RU: Record<MistakeType, string> = {
  'died-unused': 'Нажимать ульту, BKB и ТП до того, как здоровье упадёт ниже половины',
  'joined-losing-fight': 'Вступать в драку, только когда шанс выше 50% или ульта готова',
  overextended: 'Без обзора не заходить на половину врага, если 2+ врага пропали',
  'fog-night': 'Ночью ходить по чужому лесу только с союзником или вардом',
  'no-tp': 'Всегда носить свиток ТП',
  'missed-fight': 'Смотреть на мини-карту и приходить на драки команды',
  idle: 'Не стоять без дела: волна, лагерь, стак',
  'unspent-gold': 'Тратить золото сразу, как хватает на предмет',
  'late-item': 'Успевать ключевой предмет к времени профи патча ±5 мин',
  'poor-cs': 'Добивать на линии не меньше 60% ориентира',
  'missed-rune': 'Проверять руну силы каждые 2 минуты на центре',
};
export const goalFor = (t: MistakeType): string => GOAL_RU[t];

export class MistakeDetector {
  readonly list: Mistake[] = [];
  private seq = 0;
  private idleStart: number | null = null;
  private goldStreakLogged = false;
  private allyFightMs: number | null = null;
  private allyFightZone: string | null = null;

  reset(): void {
    this.list.length = 0;
    this.seq = 0;
    this.idleStart = null;
    this.goldStreakLogged = false;
    this.allyFightMs = null;
  }

  private add(c: RuleContext, m: Omit<Mistake, 'id' | 'wallMs' | 'clock'> & { clock?: number | null }): Mistake {
    const mk: Mistake = { ...m, id: `m${++this.seq}`, wallMs: c.now, clock: m.clock === undefined ? c.v.clock.value : m.clock };
    this.list.push(mk);
    return mk;
  }

  /** Новые ошибки за этот тик */
  detect(c: RuleContext): Mistake[] {
    const out: Mistake[] = [];
    if (c.ev.matchReset) this.reset();
    if (c.ev.died) out.push(...this.onDeath(c, c.ev.died, c.mem.deaths.length - 1));
    const clock = c.v.clock.value;

    // Простой: фиксируем, когда закончился и длился ≥ 40 с
    if (c.mem.idleSinceMs !== null) this.idleStart ??= c.mem.idleSinceMs;
    else if (this.idleStart !== null) {
      const sec = Math.round((c.now - this.idleStart) / 1000);
      this.idleStart = null;
      if (sec >= 40) out.push(this.add(c, { type: 'idle', severity: 1, text: `Простой ${sec} с`, instead: 'Заберите волну или лагерь, поставьте стак.', facts: [derivedFact('idle', 'Без движения, с', sec, 0.75)] }));
    }

    // Золото ≥ порога больше 2 минут
    if (c.mem.goldHighSince !== null && clock !== null && clock - c.mem.goldHighSince >= 120 && !this.goldStreakLogged) {
      this.goldStreakLogged = true;
      out.push(this.add(c, { type: 'unspent-gold', severity: 1, text: `Золото ${c.v.me.gold.value} не тратилось больше 2 минут`, instead: 'Покупайте предмет сразу, как хватает, — курьером.', facts: [derivedFact('gold', 'Золото', c.v.me.gold.value, c.v.me.gold.confidence)] }));
    }
    if (c.mem.goldHighSince === null) this.goldStreakLogged = false;

    // Драка союзников без нас: союзник видит 2+ врагов рядом, мы далеко; через ≤ 15 с союзник умер
    const me = c.v.me.pos.value;
    if (me && c.v.me.alive.value === true) {
      const enemies = c.v.enemies.filter((e) => e.alive.value !== false && e.pos.value && (e.pos.ageSec ?? 99) <= 3);
      const fight = c.v.allies.find((a) => a.alive.value !== false && a.pos.value && (a.pos.ageSec ?? 99) <= 3 && dist(me, a.pos.value) >= 4000 && enemies.filter((e) => dist(e.pos.value!, a.pos.value!) <= 2000).length >= 2);
      if (fight) {
        this.allyFightMs = c.now;
        this.allyFightZone = MAP_ZONE_RU[mapZone(fight.pos.value!.x, fight.pos.value!.y)];
      }
    }
    if (this.allyFightMs !== null && c.ev.allyDied.length > 0 && c.now - this.allyFightMs <= 15_000) {
      out.push(this.add(c, { type: 'missed-fight', severity: 2, text: `Команда дралась без вас (${this.allyFightZone}), союзник погиб`, instead: 'Когда у союзника 2+ врага, идите к нему или используйте ТП.', facts: [derivedFact('ally-fight', 'Драка союзников', this.allyFightZone, 0.6)] }));
      this.allyFightMs = null;
    }

    // Добивания к 10:00
    if (clock !== null && clock >= 600 && !c.mem.once.has('mistake:cs10')) {
      c.mem.once.add('mistake:cs10');
      const role = laneRole(c);
      const st = c.look.statsFor(c.v.me.hero.value?.id, c.v.me.hero.value?.key);
      const ref = role && role !== 4 ? st?.pro?.lhAt10[String(role)] : undefined;
      const lh = c.v.me.lastHits.value;
      if (ref && lh !== null && ref.n >= 5 && lh < ref.median * 0.6) {
        out.push(this.add(c, { type: 'poor-cs', severity: 2, text: `К 10:00 — ${lh} добиваний (профи патча ~${ref.median})`, instead: 'Не размениваться в ущерб добиваниям, тянуть волну к своей башне.', facts: [derivedFact('lh', 'Добиваний к 10:00', lh, 0.9), { key: 'lh-ref', label: 'Ориентир профи', value: ref.median, source: 'stats', ageSec: null, confidence: 0.8, verified: false }] }));
      }
    }

    // Поздний ключевой предмет
    const hero = c.v.me.hero.value;
    if (clock !== null && hero && c.v.me.itemsKnown) {
      const owned = new Set([...c.mem.items.keys(), ...c.v.me.items.map((i) => i.key)]);
      for (const b of c.look.buildFor(hero.id, hero.key).filter((x) => x.share >= 0.4 && (c.look.itemCost(x.key) ?? 0) >= 1500)) {
        if (owned.has(b.key) || clock / 60 <= b.medianMin + 6 || c.mem.once.has(`mistake:late:${b.key}`)) continue;
        c.mem.once.add(`mistake:late:${b.key}`);
        const name = c.look.itemName(b.key);
        out.push(this.add(c, { type: 'late-item', severity: 1, text: `${name} нет к ${Math.floor(clock / 60)} мин (профи — к ${Math.round(b.medianMin)})`, instead: 'Меньше бесцельных перемещений, больше лагерей между волнами.', facts: [{ key: 'median', label: `${name}: обычно к минуте`, value: b.medianMin, source: 'stats', ageSec: null, confidence: 0.8, verified: false }] }));
        break;
      }
    }

    // Руна силы на центре: через 25 с после появления герой ни разу не был у реки
    if (clock !== null && clock >= 360 + 25) {
      const first = c.look.mechanicValue('rune-power', 'firstAt');
      const interval = c.look.mechanicValue('rune-power', 'interval');
      if (first !== null && interval !== null && clock >= first + 25) {
        const k = Math.floor((clock - 25 - first) / interval);
        const spawn = first + k * interval;
        const key = `mistake:rune@${spawn}`;
        if (clock - spawn <= 40 && !c.mem.once.has(key) && laneRole(c) === 2) {
          c.mem.once.add(key);
          const visited = c.mem.samples.some((s) => s.clock !== null && s.clock >= spawn - 5 && s.clock <= spawn + 25 && s.zone === 'river');
          if (!visited && c.mem.samples.some((s) => s.clock !== null && s.clock >= spawn && s.alive === true)) {
            out.push(this.add(c, { type: 'missed-rune', clock: spawn, severity: 1, text: `Руна силы в ${mmss(spawn)} без внимания`, instead: 'За 10 с до появления руны идите к реке — или попросите саппорта.', facts: [{ key: 'rune', label: 'Руна силы', value: mmss(spawn), source: 'kb', ageSec: null, confidence: 0.8, verified: false }] }));
          }
        }
      }
    }
    return out;
  }

  private onDeath(c: RuleContext, d: DeathRecord, index: number): Mistake[] {
    const out: Mistake[] = [];
    const unused = [d.ultReady ? 'ульта' : null, ...d.keyItemsReady.map((k) => c.look.itemName(k)), d.tpReady ? 'ТП' : null].filter((x): x is string => x !== null);
    const facts = [derivedFact('enemies-near', 'Врагов рядом при смерти', d.enemiesNear, 0.75), derivedFact('drop', 'Здоровье упало за, с', d.dropSec === null ? null : Math.round(d.dropSec), 0.7)];
    if (unused.length && (d.dropSec ?? 0) >= 2) {
      out.push(this.add(c, { type: 'died-unused', severity: 3, deathIndex: index, text: `Умерли, не применив: ${unused.join(', ')}`, instead: 'Применяйте ульту и защитные предметы в начале драки, ТП — чтобы уйти.', facts }));
    }
    if (d.engageAtEntry !== null && d.engageAtEntry <= 40) {
      out.push(this.add(c, { type: 'joined-losing-fight', severity: 3, deathIndex: index, text: `Вступили в драку с шансом ${d.engageAtEntry}%`, instead: 'Подождите союзников или ульту — или не вступайте.', facts: [...facts, derivedFact('engage', 'Шанс при входе, %', d.engageAtEntry, 0.6)] }));
    }
    if (d.side === 'enemy' && d.enemiesMissing >= 2) {
      out.push(this.add(c, { type: 'overextended', severity: 2, deathIndex: index, text: `Умерли на стороне врага, ${d.enemiesMissing} врагов не было видно`, instead: 'Без обзора держитесь своей половины карты.', facts: [...facts, derivedFact('missing', 'Врагов не видно', d.enemiesMissing, 0.75)] }));
    }
    if (d.night === true && d.alliesNear === 0 && d.side !== 'own') {
      out.push(this.add(c, { type: 'fog-night', severity: 2, deathIndex: index, text: 'Умерли ночью в одиночку в тумане', instead: 'Ночью обзор меньше — ходите с союзником или ставьте вард.', facts }));
    }
    if (d.tpReady === false && d.side === 'enemy') {
      out.push(this.add(c, { type: 'no-tp', severity: 2, deathIndex: index, text: 'Умерли без свитка ТП на стороне врага', instead: 'Носите ТП: им можно сбежать или прийти на помощь.', facts }));
    }
    return out;
  }
}
