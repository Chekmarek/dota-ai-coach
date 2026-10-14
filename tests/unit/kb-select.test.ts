import { describe, expect, it } from 'vitest';
import { selectKbCopy } from '../../src/core/knowledge-base/select.ts';

const asar = (generatedAt: string | null) => ({ origin: 'asar' as const, generatedAt });
const ext = (generatedAt: string | null) => ({ origin: 'external' as const, generatedAt });

describe('выбор копии базы знаний', () => {
  it('берётся более новая копия', () => {
    expect(selectKbCopy([asar('2026-10-14T10:00:00Z'), ext('2026-10-11T10:00:00Z')])?.origin).toBe('asar');
    expect(selectKbCopy([asar('2026-10-11T10:00:00Z'), ext('2026-10-14T10:00:00Z')])?.origin).toBe('external');
  });
  it('при равной дате — копия из app.asar (в любом порядке)', () => {
    expect(selectKbCopy([ext('2026-10-14T10:00:00Z'), asar('2026-10-14T10:00:00.000Z')])?.origin).toBe('asar');
    expect(selectKbCopy([asar('2026-10-14T10:00:00Z'), ext('2026-10-14T10:00:00Z')])?.origin).toBe('asar');
  });
  it('нечитаемая копия или копия без даты не выбирается', () => {
    expect(selectKbCopy([asar(null), ext('2026-10-11T10:00:00Z')])?.origin).toBe('external');
    expect(selectKbCopy([asar('не дата'), ext('2026-10-11T10:00:00Z')])?.origin).toBe('external');
    expect(selectKbCopy([asar(null), ext(null)])).toBeNull();
    expect(selectKbCopy([])).toBeNull();
  });
});
