import type { MechanicsEntry, MechanicsSchedule, MechanicsVerification } from '../../shared/types/mechanics.ts';

/**
 * Ближайшие события карты по механике из базы знаний и текущим игровым часам (секунды, 0 — горн, до горна < 0).
 * Всё берётся только из mechanics.json: если значения нет («missing» или записи нет) — событие без времени,
 * никаких значений по умолчанию. Событие, которое идёт прямо сейчас (час совпал), имеет inSec = 0.
 */

export type TimerId =
  | 'lane-wave'
  | 'neutral-spawn'
  | 'stack-window'
  | 'rune-bounty'
  | 'rune-power'
  | 'rune-water'
  | 'rune-wisdom'
  | 'shrine-of-wisdom'
  | 'day-night'
  | 'tormentor'
  | 'roshan-respawn';

/**
 * ok — время известно; missing — в базе нет значения; ended — событий больше не будет (вода после 4:00);
 * removed — механики нет в игре (руны мудрости); available — объект уже на месте (Мучитель, Рошан после окна);
 * unknown — нужно время смерти (Рошан), а его нет.
 */
export type TimerStatus = 'ok' | 'missing' | 'ended' | 'removed' | 'available' | 'unknown';

export interface TimerEvent {
  id: TimerId;
  nameRu: string;
  status: TimerStatus;
  /** Начало (или момент) события; null — неизвестно */
  at: number | null;
  /** Конец окна (стак, возрождение Рошана); null — событие мгновенное */
  until: number | null;
  /** Через сколько секунд начнётся (0 — уже идёт) */
  inSec: number | null;
  /** Пояснение к событию: «день»/«ночь» для смены суток */
  detailRu: string | null;
  /** Насколько проверены данные, на которых построено время (худшая из использованных записей) */
  verification: MechanicsVerification | null;
}

export interface TimerOptions {
  /** Игровое время смерти Рошана (секунды); null — неизвестно */
  roshanDeathAt?: number | null;
  /** Игровое время убийства Мучителя (секунды); null — не убит или неизвестно */
  tormentorDeathAt?: number | null;
}

const RANK: Record<MechanicsVerification, number> = { verified: 0, 'imported-unverified': 1, missing: 2 };
const worst = (...vs: (MechanicsVerification | undefined)[]): MechanicsVerification | null =>
  vs.reduce<MechanicsVerification | null>((w, v) => (!v ? w : !w || RANK[v] > RANK[w] ? v : w), null);

/** Ближайшее событие расписания не раньше t; 'ended' — после последнего; null — расписания нет */
export function nextScheduled(s: MechanicsSchedule | null | undefined, t: number): number | 'ended' | null {
  if (!s || s.firstAt === null) return null;
  if (t <= s.firstAt) return s.firstAt;
  if (s.interval === null) return 'ended';
  const at = s.firstAt + Math.ceil((t - s.firstAt) / s.interval) * s.interval;
  return s.lastAt !== null && at > s.lastAt ? 'ended' : at;
}

function numValue(e: MechanicsEntry | undefined, key: string): number | null {
  const v = e?.values.find((x) => x.key === key)?.value;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

const usable = (e: MechanicsEntry | undefined): e is MechanicsEntry => !!e && e.verification !== 'missing';

function event(id: TimerId, nameRu: string, t: number, at: number | null, verification: MechanicsVerification | null, extra: Partial<TimerEvent> = {}): TimerEvent {
  return {
    id,
    nameRu,
    status: at === null ? 'missing' : 'ok',
    at,
    until: null,
    inSec: at === null ? null : Math.max(0, at - t),
    detailRu: null,
    verification,
    ...extra,
  };
}

const missing = (id: TimerId, nameRu: string, verification: MechanicsVerification | null = 'missing'): TimerEvent =>
  event(id, nameRu, 0, null, verification);

/** Событие по расписанию записи */
function scheduled(id: TimerId, nameRu: string, e: MechanicsEntry | undefined, t: number): TimerEvent {
  if (!usable(e)) return missing(id, nameRu);
  const at = nextScheduled(e.schedule, t);
  if (at === null) return missing(id, nameRu);
  if (at === 'ended') return { ...event(id, nameRu, t, null, e.verification), status: 'ended' };
  return event(id, nameRu, t, at, e.verification);
}

export function upcomingEvents(entries: readonly MechanicsEntry[], clockSec: number, opts: TimerOptions = {}): TimerEvent[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const get = (id: string) => byId.get(id);
  const t = clockSec;
  const out: TimerEvent[] = [];

  out.push(scheduled('lane-wave', 'Волна крипов', get('lane-wave-spawn'), t));
  const neutral = get('neutral-spawn');
  out.push(scheduled('neutral-spawn', 'Появление нейтралов', neutral, t));

  // Окно стака: перед каждым появлением нейтралов, начиная с первого появления (до него стакать нечего)
  const stack = get('neutral-stack-window');
  const from = numValue(stack, 'fromSecond');
  const to = numValue(stack, 'toSecond');
  const s = neutral?.schedule;
  if (!usable(neutral) || !usable(stack) || from === null || to === null || !s || s.firstAt === null || s.interval === null) {
    out.push(missing('stack-window', 'Окно стака'));
  } else {
    const k = Math.max(0, Math.ceil((t - s.firstAt - to) / s.interval));
    const base = s.firstAt + k * s.interval;
    out.push(event('stack-window', 'Окно стака', t, base + from, worst(neutral.verification, stack.verification), { until: base + to }));
  }

  out.push(scheduled('rune-bounty', 'Руна богатства', get('rune-bounty'), t));
  out.push(scheduled('rune-power', 'Руна силы', get('rune-power'), t));
  out.push(scheduled('rune-water', 'Руна воды', get('rune-water'), t));
  const wisdom = get('rune-wisdom');
  out.push(
    wisdom && !wisdom.schedule
      ? { ...event('rune-wisdom', 'Руна мудрости', t, null, wisdom.verification), status: 'removed', detailRu: 'нет в игре — вместо неё Святилища мудрости' }
      : scheduled('rune-wisdom', 'Руна мудрости', wisdom, t),
  );
  out.push(scheduled('shrine-of-wisdom', 'Святилище мудрости', get('shrine-of-wisdom'), t));

  // Смена суток: чётный полупериод от начала — день, нечётный — ночь
  const dn = scheduled('day-night', 'Смена дня и ночи', get('day-night-cycle'), t);
  const dnS = get('day-night-cycle')?.schedule;
  if (dn.at !== null && dnS?.firstAt != null && dnS.interval) {
    dn.detailRu = Math.round((dn.at - dnS.firstAt) / dnS.interval) % 2 === 0 ? 'наступит день' : 'наступит ночь';
  }
  out.push(dn);

  // Мучитель: первое появление; после убийства — через время возрождения
  const tor = get('tormentor-spawn');
  const torFirst = numValue(tor, 'firstAt');
  const torRespawn = numValue(tor, 'respawn');
  if (!usable(tor) || torFirst === null) out.push(missing('tormentor', 'Мучитель'));
  else if (opts.tormentorDeathAt != null) {
    if (torRespawn === null) out.push(missing('tormentor', 'Мучитель'));
    else {
      const at = Math.max(torFirst, opts.tormentorDeathAt + torRespawn);
      out.push(at <= t ? { ...event('tormentor', 'Мучитель', t, at, tor.verification), status: 'available' } : event('tormentor', 'Мучитель', t, at, tor.verification));
    }
  } else if (t < torFirst) out.push(event('tormentor', 'Мучитель', t, torFirst, tor.verification));
  else out.push({ ...event('tormentor', 'Мучитель', t, torFirst, tor.verification), status: 'available', detailRu: 'на месте, если его не убили' });

  // Рошан: окно возрождения только по известному времени смерти
  const rosh = get('roshan-respawn');
  const rMin = numValue(rosh, 'min');
  const rMax = numValue(rosh, 'max');
  if (!usable(rosh) || rMin === null || rMax === null) out.push(missing('roshan-respawn', 'Возрождение Рошана'));
  else if (opts.roshanDeathAt == null) out.push({ ...event('roshan-respawn', 'Возрождение Рошана', t, null, rosh.verification), status: 'unknown' });
  else {
    const start = opts.roshanDeathAt + rMin;
    const end = opts.roshanDeathAt + rMax;
    out.push(
      t > end
        ? { ...event('roshan-respawn', 'Возрождение Рошана', t, end, rosh.verification), status: 'available', detailRu: 'точно жив' }
        : event('roshan-respawn', 'Возрождение Рошана', t, start, rosh.verification, { until: end }),
    );
  }
  return out;
}
