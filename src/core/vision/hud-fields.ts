// Разбор распознанного текста в значения и проверка правдоподобия.
// Если текст не подходит под формат или значение невозможно в игре — значение отбрасывается.

export interface Pool {
  current: number;
  max: number;
}

export interface HudValues {
  gameClock: number; // секунды
  scoreRadiant: number;
  scoreDire: number;
  gold: number;
  health: Pool;
  mana: Pool;
  level: number;
}

export type HudFieldId = keyof HudValues;

export const HUD_FIELDS: HudFieldId[] = ['gameClock', 'scoreRadiant', 'scoreDire', 'gold', 'health', 'mana', 'level'];

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
};

export function formatClock(sec: number): string {
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
}
