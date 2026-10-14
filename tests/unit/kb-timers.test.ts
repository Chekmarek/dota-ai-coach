import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { upcomingEvents, type TimerEvent, type TimerId } from '../../src/core/knowledge-base/timers.ts';
import { parseMechanics, type MechanicsEntry } from '../../src/shared/types/mechanics.ts';

const ROOT = join(import.meta.dirname, '../..');
const patch = JSON.parse(readFileSync(join(ROOT, 'resources/data/kb/current.json'), 'utf8')).patch as string;
const real = parseMechanics(JSON.parse(readFileSync(join(ROOT, 'resources/data/kb', patch, 'mechanics.json'), 'utf8')));
const entries = real.file!.entries;

/** Минимальный набор записей с известными значениями — тесты не зависят от будущих правок данных */
const entry = (id: string, values: Record<string, number | string | null>, schedule: MechanicsEntry['schedule'] = null, verification: MechanicsEntry['verification'] = 'imported-unverified'): MechanicsEntry => ({
  id,
  category: 'test',
  nameRu: id,
  values: Object.entries(values).map(([key, value]) => ({ key, labelRu: key, value, unit: null })),
  schedule,
  notesRu: '',
  source: { name: 'тест', url: 'https://example.com/', license: null },
  patch: null,
  retrievedAt: '2026-10-14',
  verification,
});
const FIXTURE: MechanicsEntry[] = [
  entry('lane-wave-spawn', { firstAt: 0 }, { firstAt: 0, interval: 30, lastAt: null }),
  entry('neutral-spawn', { firstAt: 60 }, { firstAt: 60, interval: 60, lastAt: null }),
  entry('neutral-stack-window', { fromSecond: 54, toSecond: 55 }),
  entry('rune-bounty', { firstAt: 0 }, { firstAt: 0, interval: 240, lastAt: null }),
  entry('rune-power', { firstAt: 360 }, { firstAt: 360, interval: 120, lastAt: null }),
  entry('rune-water', { times: '2:00 и 4:00' }, { firstAt: 120, interval: 120, lastAt: 240 }),
  entry('rune-wisdom', { inGame: 'нет' }),
  entry('shrine-of-wisdom', { firstAt: 420 }, { firstAt: 420, interval: 420, lastAt: null }),
  entry('day-night-cycle', { half: 300 }, { firstAt: 0, interval: 300, lastAt: null }),
  entry('tormentor-spawn', { firstAt: 1200, respawn: 600 }, { firstAt: 1200, interval: null, lastAt: null }),
  entry('roshan-respawn', { min: 480, max: 660 }),
];

const at = (events: TimerEvent[]) => Object.fromEntries(events.map((e) => [e.id, e.status === 'ok' || e.status === 'available' ? e.at : e.status])) as Record<TimerId, number | string | null>;

describe('ближайшие события карты', () => {
  it('до горна (-1:00)', () => {
    const e = upcomingEvents(FIXTURE, -60);
    expect(at(e)).toMatchObject({ 'lane-wave': 0, 'neutral-spawn': 60, 'stack-window': 114, 'rune-bounty': 0, 'rune-power': 360, 'rune-water': 120, 'shrine-of-wisdom': 420, 'day-night': 0, tormentor: 1200 });
    expect(e.find((x) => x.id === 'lane-wave')!.inSec).toBe(60);
    expect(e.find((x) => x.id === 'day-night')!.detailRu).toBe('наступит день');
  });
  it('0:00 — волна и руна богатства прямо сейчас', () => {
    const e = upcomingEvents(FIXTURE, 0);
    expect(at(e)).toMatchObject({ 'lane-wave': 0, 'neutral-spawn': 60, 'stack-window': 114, 'rune-bounty': 0, 'rune-water': 120 });
    expect(e.find((x) => x.id === 'lane-wave')!.inSec).toBe(0);
    expect(e.find((x) => x.id === 'stack-window')!.until).toBe(115);
  });
  it('2:59 — окно стака 2:54 прошло, следующее в 3:54', () => {
    expect(at(upcomingEvents(FIXTURE, 179))).toMatchObject({ 'lane-wave': 180, 'neutral-spawn': 180, 'stack-window': 234, 'rune-bounty': 240, 'rune-power': 360, 'rune-water': 240, 'day-night': 300 });
  });
  it('5:00 — наступает ночь, руны воды больше не будет', () => {
    const e = upcomingEvents(FIXTURE, 300);
    expect(at(e)).toMatchObject({ 'lane-wave': 300, 'neutral-spawn': 300, 'stack-window': 354, 'rune-bounty': 480, 'rune-power': 360, 'rune-water': 'ended', 'day-night': 300 });
    expect(e.find((x) => x.id === 'day-night')!.detailRu).toBe('наступит ночь');
  });
  it('6:00 — первая руна силы', () => {
    const e = upcomingEvents(FIXTURE, 360);
    expect(at(e)).toMatchObject({ 'rune-power': 360, 'rune-bounty': 480, 'day-night': 600, 'shrine-of-wisdom': 420 });
    expect(e.find((x) => x.id === 'rune-power')!.inSec).toBe(0);
  });
  it('7:00 — святилище мудрости, следующая руна силы в 8:00', () => {
    expect(at(upcomingEvents(FIXTURE, 420))).toMatchObject({ 'shrine-of-wisdom': 420, 'rune-power': 480, 'lane-wave': 420, 'stack-window': 474 });
  });
  it('59:59 — всё на ровной минуте 60:00', () => {
    const e = upcomingEvents(FIXTURE, 3599);
    expect(at(e)).toMatchObject({ 'lane-wave': 3600, 'neutral-spawn': 3600, 'rune-bounty': 3600, 'rune-power': 3600, 'day-night': 3600, 'stack-window': 3654 });
    expect(e.find((x) => x.id === 'tormentor')!.status).toBe('available');
    expect(e.find((x) => x.id === 'day-night')!.detailRu).toBe('наступит день');
  });
  it('Мучитель и Рошан по времени смерти', () => {
    const e = upcomingEvents(FIXTURE, 1300, { tormentorDeathAt: 1250, roshanDeathAt: 1000 });
    expect(e.find((x) => x.id === 'tormentor')).toMatchObject({ status: 'ok', at: 1850, inSec: 550 });
    expect(e.find((x) => x.id === 'roshan-respawn')).toMatchObject({ status: 'ok', at: 1480, until: 1660, inSec: 180 });
    expect(upcomingEvents(FIXTURE, 1700, { roshanDeathAt: 1000 }).find((x) => x.id === 'roshan-respawn')!.status).toBe('available');
    expect(upcomingEvents(FIXTURE, 1300).find((x) => x.id === 'roshan-respawn')).toMatchObject({ status: 'unknown', at: null });
  });
  it('руна мудрости — нет в игре', () => {
    expect(upcomingEvents(FIXTURE, 0).find((x) => x.id === 'rune-wisdom')).toMatchObject({ status: 'removed', at: null });
  });
  it('нет значения в базе — null, а не значение по умолчанию', () => {
    const noPower = FIXTURE.filter((e) => e.id !== 'rune-power');
    const missingRosh = FIXTURE.map((e) => (e.id === 'roshan-respawn' ? entry('roshan-respawn', { min: null, max: null }, null, 'missing') : e));
    const ev = upcomingEvents([...noPower.filter((e) => e.id !== 'roshan-respawn'), ...missingRosh.filter((e) => e.id === 'roshan-respawn')], 100, { roshanDeathAt: 50 });
    expect(ev.find((x) => x.id === 'rune-power')).toMatchObject({ status: 'missing', at: null, inSec: null });
    expect(ev.find((x) => x.id === 'roshan-respawn')).toMatchObject({ status: 'missing', at: null });
    expect(upcomingEvents([], 100).every((x) => x.at === null)).toBe(true);
  });
  it('настоящий mechanics.json читается без предупреждений и даёт времена', () => {
    expect(real.warnings).toEqual([]);
    expect(at(upcomingEvents(entries, 179))).toMatchObject({ 'lane-wave': 180, 'neutral-spawn': 180, 'rune-power': 360, 'day-night': 300 });
  });
});

describe('схема mechanics.json', () => {
  it('плохая запись отбрасывается с предупреждением, остальные остаются', () => {
    const good = entry('a', { x: 1 });
    const r = parseMechanics({ patch: '7.41f', generatedAt: 'x', extra: true, entries: [good, { id: 'bad', values: [] }, { ...good, unknownField: 1 }, entry('m', { x: 5 }, null, 'missing')] });
    expect(r.file!.entries.map((e) => e.id)).toEqual(['a']);
    expect(r.warnings).toHaveLength(3);
  });
  it('файл без списка записей отклоняется целиком', () => {
    expect(parseMechanics({ patch: '7.41f' }).file).toBeNull();
  });
});
