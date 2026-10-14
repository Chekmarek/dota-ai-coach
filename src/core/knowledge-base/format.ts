/**
 * Единый формат чисел базы знаний: не больше одного знака после запятой, без хвостовых нулей.
 * 2.6666667 → «2.7», 1.5 → «1.5», 3 → «3», -0.04 → «0». Не число → «—».
 */
export function formatKbNumber(value: number | null | undefined): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value * 10) / 10;
  // -0 после округления показываем как 0
  return String(rounded === 0 ? 0 : rounded);
}

/** Прирост характеристики за уровень: «+2.7» (знак всегда виден) */
export function formatKbGain(value: number | null | undefined): string {
  const s = formatKbNumber(value);
  return s === '—' || s.startsWith('-') ? s : `+${s}`;
}

/** Список значений по уровням способности: «12/10/8» */
export function formatKbList(values: readonly number[]): string {
  return values.map((v) => formatKbNumber(v)).join('/');
}
