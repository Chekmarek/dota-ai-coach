import { describe, expect, it } from 'vitest';
import { formatKbGain, formatKbList, formatKbNumber } from '../../src/core/knowledge-base/format.ts';

describe('формат чисел базы знаний', () => {
  it('не больше одного знака, без хвостовых нулей', () => {
    expect(formatKbNumber(2.6666667)).toBe('2.7');
    expect(formatKbNumber(1.7999999)).toBe('1.8');
    expect(formatKbNumber(0)).toBe('0');
    expect(formatKbNumber(3)).toBe('3');
    expect(formatKbNumber(-1)).toBe('-1');
    expect(formatKbNumber(1.5)).toBe('1.5');
    expect(formatKbNumber(-0.04)).toBe('0');
  });
  it('не число — прочерк', () => {
    expect(formatKbNumber(null)).toBe('—');
    expect(formatKbNumber(Number.NaN)).toBe('—');
  });
  it('прирост со знаком и списки по уровням', () => {
    expect(formatKbGain(2.6666667)).toBe('+2.7');
    expect(formatKbGain(-1)).toBe('-1');
    expect(formatKbList([12.5, 10.0000001, 7.99999])).toBe('12.5/10/8');
  });
});
