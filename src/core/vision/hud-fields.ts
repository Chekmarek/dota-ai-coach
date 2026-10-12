// Разбор распознанного текста в значения и проверка правдоподобия.
// Если текст не подходит под формат или значение невозможно в игре — значение отбрасывается.

export interface Pool {
  current: number;
  max: number;
}

/** Убийства / смерти / помощь игрока (блок «У/С/П» слева вверху) */
export interface Kda {
  kills: number;
  deaths: number;
  assists: number;
}

/** Добивания / невсе (блок «ДК/НО» слева вверху) */
export interface Farm {
  lastHits: number;
  denies: number;
}

export interface HudValues {
  gameClock: number; // секунды
  scoreRadiant: number;
  scoreDire: number;
  gold: number;
  health: Pool;
  mana: Pool;
  level: number;
  kda: Kda;
  farm: Farm;
}

export type HudFieldId = keyof HudValues;

export const HUD_FIELDS: HudFieldId[] = ['gameClock', 'scoreRadiant', 'scoreDire', 'gold', 'health', 'mana', 'level', 'kda', 'farm'];

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: 'unparsed' | 'out-of-range' };

function int(text: string, min: number, max: number): ParseResult<number> {
  if (!/^\d{1,6}$/.test(text)) return { ok: false, reason: 'unparsed' };
  const n = Number(text);
  return n >= min && n <= max ? { ok: true, value: n } : { ok: false, reason: 'out-of-range' };
}

function pool(text: string, maxLimit: number): ParseResult<Pool> {
  const m = /^(\d{1,5})\/(\d{1,5})$/.exec(text);
  if (!m) return { ok: false, reason: 'unparsed' };
  const current = Number(m[1]), max = Number(m[2]);
  if (max <= 0 || max > maxLimit || current > max) return { ok: false, reason: 'out-of-range' };
  return { ok: true, value: { current, max } };
}

export const PARSERS: { [K in HudFieldId]: (text: string) => ParseResult<HudValues[K]> } = {
  gameClock: (t) => {
    // Двоеточие бывает слишком бледным и не распознаётся — оно не несёт информации:
    // последние две цифры всегда секунды («4426» = 44:26)
    const m = /^(\d{1,3}):?(\d{2})$/.exec(t);
    if (!m) return { ok: false, reason: 'unparsed' };
    const sec = Number(m[2]);
    if (sec > 59) return { ok: false, reason: 'out-of-range' };
    return { ok: true, value: Number(m[1]) * 60 + sec };
  },
  scoreRadiant: (t) => int(t, 0, 300),
  scoreDire: (t) => int(t, 0, 300),
  gold: (t) => int(t, 0, 99_999),
  health: (t) => pool(t, 40_000),
  mana: (t) => pool(t, 20_000),
  level: (t) => int(t, 1, 30),
  kda: (t) => {
    const m = /^(\d{1,3})\/(\d{1,3})\/(\d{1,3})$/.exec(t);
    if (!m) return { ok: false, reason: 'unparsed' };
    const [kills, deaths, assists] = [m[1], m[2], m[3]].map(Number) as [number, number, number];
    if (kills > 300 || deaths > 300 || assists > 300) return { ok: false, reason: 'out-of-range' };
    return { ok: true, value: { kills, deaths, assists } };
  },
  farm: (t) => {
    const m = /^(\d{1,4})\/(\d{1,3})$/.exec(t);
    if (!m) return { ok: false, reason: 'unparsed' };
    const lastHits = Number(m[1]), denies = Number(m[2]);
    if (lastHits > 3000 || denies > 500) return { ok: false, reason: 'out-of-range' };
    return { ok: true, value: { lastHits, denies } };
  },
};

/** Значение поля в текстовом виде, как в разметке кадров («10/3/4», «1530/1616», «20:02») */
export function formatHudLabel(id: HudFieldId, v: unknown): string {
  if (id === 'gameClock') return formatClock(v as number);
  if (id === 'health' || id === 'mana') return `${(v as Pool).current}/${(v as Pool).max}`;
  if (id === 'kda') return `${(v as Kda).kills}/${(v as Kda).deaths}/${(v as Kda).assists}`;
  if (id === 'farm') return `${(v as Farm).lastHits}/${(v as Farm).denies}`;
  return String(v);
}

/** Время в «м:сс»; отрицательное — отсчёт до горна («-1:19») */
export function formatClock(sec: number): string {
  const a = Math.abs(sec);
  return `${sec < 0 ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}
