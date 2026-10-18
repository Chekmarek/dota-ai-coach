// Справочник Турбо (src/data/modes/turbo.json): у каждого значения — источник; без источника — null и «в Турбо не
// проверено»; посчитанные значения (×2, ÷2) сходятся с обычной механикой базы знаний; обычный режим не меняется.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { modeRule, parseModeOverrides, turboMechanics } from '../../src/core/knowledge-base/modes.ts';
import { mechanicsEntrySchema, parseMechanics } from '../../src/shared/types/mechanics.ts';
import { upcomingEvents } from '../../src/core/knowledge-base/timers.ts';

const ROOT = join(import.meta.dirname, '../..');
const raw = JSON.parse(readFileSync(join(ROOT, 'src/data/modes/turbo.json'), 'utf8'));
const turbo = parseModeOverrides(raw)!;
const kbPatch = JSON.parse(readFileSync(join(ROOT, 'resources/data/kb/current.json'), 'utf8')).patch as string;
const normal = parseMechanics(JSON.parse(readFileSync(join(ROOT, `resources/data/kb/${kbPatch}/mechanics.json`), 'utf8'))).file!.entries;
const applied = turboMechanics(normal, turbo, kbPatch);
const get = (list: typeof normal, id: string, key: string) => list.find((e) => e.id === id)!.values.find((v) => v.key === key)!.value;

describe('справочник Турбо: источники', () => {
  it('файл проходит схему и сверен с текущим патчем базы знаний', () => {
    expect(turbo).not.toBeNull();
    expect(turbo.patch).toBe(kbPatch);
  });
  it('каждая запись механики есть в справочнике ровно один раз', () => {
    expect(turbo.entries.map((e) => e.id).sort()).toEqual(normal.map((e) => e.id).sort());
  });
  it('same и changed — с источниками из списка; unknown — без значений и с объяснением', () => {
    for (const e of turbo.entries) {
      if (e.status === 'unknown') {
        expect(e.values, e.id).toBeUndefined();
        expect(e.basis, e.id).toBe('conflict');
        expect(e.noteRu.length, e.id).toBeGreaterThan(10);
        continue;
      }
      expect(e.sources.length, e.id).toBeGreaterThan(0);
      for (const s of e.sources) expect(turbo.sources[s], `${e.id}: ${s}`).toBeDefined();
    }
  });
  it('у страниц Liquipedia указана ревизия; у правил (аегис и т. п.) — источники', () => {
    for (const [id, s] of Object.entries(turbo.sources)) if (id.startsWith('lp-')) expect(s.revision, id).toBeGreaterThan(0);
    for (const [k, r] of Object.entries(turbo.rules)) for (const s of r.sources) expect(turbo.sources[s], `${k}: ${s}`).toBeDefined();
  });
  it('changed меняет только существующие ключи записи', () => {
    for (const e of turbo.entries.filter((x) => x.status === 'changed')) {
      const keys = normal.find((n) => n.id === e.id)!.values.map((v) => v.key);
      for (const k of Object.keys(e.values ?? {})) expect(keys, `${e.id}.${k}`).toContain(k);
    }
  });
});

describe('механика Турбо после наложения', () => {
  it('каждая запись проходит схему механики; unknown — «missing» и все значения null', () => {
    for (const e of applied) {
      expect(mechanicsEntrySchema.safeParse(e).success, e.id).toBe(true);
      const o = turbo.entries.find((x) => x.id === e.id)!;
      if (o.status === 'unknown') {
        expect(e.verification).toBe('missing');
        expect(e.values.every((v) => v.value === null)).toBe(true);
        expect(e.notesRu.startsWith('В Турбо не проверено')).toBe(true);
      }
      if (o.status === 'same') expect(e).toEqual(normal.find((n) => n.id === e.id));
      if (o.status === 'changed') expect(e.verification).not.toBe('verified');
    }
  });
  it('сверка: вдвое быстрее — Рошан, Мучитель, лотос, Святилище, уровни нейтральных предметов', () => {
    for (const [id, key] of [['roshan-respawn', 'min'], ['roshan-respawn', 'max'], ['tormentor-spawn', 'firstAt'], ['tormentor-spawn', 'respawn'], ['lotus-pool', 'interval'], ['lotus-pool', 'great'], ['lotus-pool', 'greater'], ['shrine-of-wisdom', 'interval'], ['neutral-items-tiers', 't2'], ['neutral-items-tiers', 't3'], ['neutral-items-tiers', 't4'], ['neutral-items-tiers', 't5']] as const)
      expect(get(applied, id, key), `${id}.${key}`).toBe((get(normal, id, key) as number) / 2);
    // Великий/Величайший лотос — с 4-го/5-го уровня нейтральных предметов (Valve 7.38) и в обычной игре
    expect(get(normal, 'lotus-pool', 'great')).toBe(get(normal, 'neutral-items-tiers', 't4'));
    expect(get(normal, 'lotus-pool', 'greater')).toBe(get(normal, 'neutral-items-tiers', 't5'));
  });
  it('сверка: вдвое больше — опыт и золото за крипов, золото за здания; за героев — без изменений', () => {
    expect(get(applied, 'lane-creep-stats-melee', 'xp')).toBe((get(normal, 'lane-creep-stats-melee', 'xp') as number) * 2);
    expect(get(applied, 'neutral-camp-ancient', 'xp')).toBe((get(normal, 'neutral-camp-ancient', 'xp') as number) * 2);
    expect(get(applied, 'building-bounty', 'meleeRax')).toBe((get(normal, 'building-bounty', 'meleeRax') as number) * 2);
    expect(get(applied, 'gold-hero-kill', 'formula')).toBe(get(normal, 'gold-hero-kill', 'formula'));
  });
  it('нет единого мнения — null: пассивное золото, время возрождения', () => {
    for (const id of ['gold-passive', 'respawn-time']) expect(applied.find((e) => e.id === id)!.values.every((v) => v.value === null), id).toBe(true);
  });
  it('таймеры Турбо: Рошан, Мучитель 10:00, лотос 1:30, Святилище 3:30; Рошан — без времени смерти неизвестен', () => {
    const t = upcomingEvents(applied, 60);
    expect(t.find((x) => x.id === 'tormentor')!.at).toBe(600);
    expect(t.find((x) => x.id === 'shrine-of-wisdom')!.at).toBe(210);
    expect(upcomingEvents(applied, 0, { roshanDeathAt: 300 }).find((x) => x.id === 'roshan-respawn')).toMatchObject({ at: 540, until: 630 });
  });
  it('правила: аегис 4 мин; нет справочника — null', () => {
    expect(modeRule(turbo, 'aegisSec')).toBe(240);
    expect(modeRule(null, 'aegisSec')).toBeNull();
  });
  it('справочник другого патча или его нет — вся механика Турбо «не проверено»', () => {
    for (const m of [turboMechanics(normal, turbo, '7.99'), turboMechanics(normal, null, kbPatch)]) {
      expect(m.every((e) => e.verification === 'missing' && e.values.every((v) => v.value === null))).toBe(true);
    }
  });
  it('испорченный файл — null', () => {
    expect(parseModeOverrides({ ...raw, version: 2 })).toBeNull();
    expect(parseModeOverrides({ ...raw, entries: [{ id: 'x', status: 'maybe' }] })).toBeNull();
  });
});
