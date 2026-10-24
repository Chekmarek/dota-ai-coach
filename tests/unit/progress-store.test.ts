// Хранилище прогресса в main: законченный матч из истории → опыт; повтор не считается; старые матчи досчитываются;
// незаконченный матч (нет разбора) — не считается; испорченный файл — с чистого листа.
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProgressStore, recordFromHistory } from '../../src/main/coach/progress-store';
import type { HistoryMatch } from '../../src/shared/types/history';

const match = (id: string, p: Partial<HistoryMatch> = {}): HistoryMatch => ({
  id,
  startedAt: `2026-10-${id.padStart(2, '0')}T10:00:00.000Z`,
  matchId: id,
  heroName: 'Slark',
  result: 'win',
  durationSec: 1800,
  entries: [],
  mistakes: [],
  deathReviews: [],
  matchReview: { result: 'win', why: [], goodPlays: [], goals: [], stats: [], timeline: [], aiText: null },
  ...p,
});

describe('ProgressStore', () => {
  it('фокус выполнен — опыт; тот же матч второй раз — ничего; файл переживает перезапуск', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-progress-'));
    const s = new ProgressStore(dir);
    const m = match('1', { focus: { id: 'deaths-early', title: 'меньше смертей до 10 мин', value: 0, target: 1, unit: '', better: 'lower', achieved: true, prevAvg: null, keep: '' }, hintOutcomes: [{ clock: 100, type: 'danger.model', short: 'Отходи', result: 'acted', survived: true }] });
    const a = s.addMatch(m)!;
    expect(a.award.total).toBe(110);
    expect(a.award.items.map((i) => i.reason)).toEqual(['focus', 'hint']);
    expect(s.addMatch(m)).toBeNull();
    expect(new ProgressStore(dir).view().level.total).toBe(110);
  });
  it('незаконченный матч не считается; старые досчитываются по времени', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-progress-'));
    const s = new ProgressStore(dir);
    expect(recordFromHistory(match('2', { matchReview: null }))).toBeNull();
    // смерти до 10 мин восстанавливаются из разборов смертей (старые матчи без метрик)
    const old = match('3', { deathReviews: [{ clock: 120, why: [], tips: [], buyback: '', aiText: null }, { clock: 900, why: [], tips: [], buyback: '', aiText: null }] });
    expect(recordFromHistory(old)!.metrics['deaths-early']).toBe(1);
    expect(s.backfill([match('5'), old, match('4', { matchReview: null })])).toBe(2);
    expect(s.view().matches).toBe(2);
  });
  it('испорченный файл — с чистого листа', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-progress-'));
    writeFileSync(join(dir, 'progress.json'), '{"version":1,"records":"мусор"}');
    expect(new ProgressStore(dir).view().matches).toBe(0);
  });
});
