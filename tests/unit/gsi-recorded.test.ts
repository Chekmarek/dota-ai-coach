// Настоящая запись GSI из Dota 2 (Hero Demo, Anti-Mage, 2026-10-13): tests/fixtures/gsi/recorded/demo-antimage.jsonl.
// Проверяем разбор каждого тела и то, что модель состояния выдаёт ровно те события, что есть в записи.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mapGsi, parseGsiBody, type GsiReading } from '../../src/core/gsi/index.ts';
import { GSI_LIVE_MS, MatchStateModel } from '../../src/core/match-state/index.ts';
import heroNames from '../../src/data/hero-names.json';

const FILE = join(import.meta.dirname, '../fixtures/gsi/recorded/demo-antimage.jsonl');
type Entry = { t: number; body: Record<string, any> };
const entries: Entry[] = readFileSync(FILE, 'utf8')
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Entry);

const heroes = new Map((heroNames.names as { id: number; key: string; name: string }[]).map((h) => [h.key, { id: h.id, name: h.name }]));
const read = (body: unknown): GsiReading | null => mapGsi(body, undefined, (k) => heroes.get(k));

/** Тело с выбранным героем (как его понимает Dota: hero.name = npc_dota_hero_*) */
const picked = (b: Record<string, any>) => typeof b.hero?.name === 'string' && b.hero.name.startsWith('npc_dota_hero_') && !!b.map;

describe('GSI: настоящая запись Hero Demo', () => {
  it('файл на месте и без личных данных', () => {
    expect(entries.length).toBeGreaterThan(400);
    const text = readFileSync(FILE, 'utf8');
    for (const s of ['"auth"', '"token"', '"steamid":"7', '"accountid":"1']) expect(text).not.toContain(s);
  });

  it('каждая строка разбирается без ошибок', () => {
    for (const e of entries) {
      expect(typeof e.t).toBe('number');
      const r = parseGsiBody(e.body);
      expect(r.ok).toBe(true);
    }
  });

  it('mapGsi → null только без выбранного героя: меню {player} и выбор героя (hero.id = 0)', () => {
    const nulls = entries.filter((e) => read(e.body) === null);
    // Меню: одно тело {"player":{}}; выбор героя: hero = {id: 0} без имени
    expect(nulls[0]!.body).toEqual({ player: {} });
    for (const e of nulls.slice(1)) expect(e.body.hero).toEqual({ id: 0 });
    // Все остальные тела — с героем и читаются
    for (const e of entries) expect(read(e.body) === null).toBe(!picked(e.body));
    expect(nulls.length).toBeLessThan(10);
  });

  it('matchid "0" (Hero Demo) → matchId null, сброса матча нет', () => {
    const readings = entries.map((e) => read(e.body)).filter((r): r is GsiReading => r !== null);
    expect(entries.every((e) => !e.body.map || e.body.map.matchid === '0')).toBe(true);
    expect(readings.every((r) => r.matchId === null)).toBe(true);
  });

  it('plus_* — не на панели (slot null); ячейки панели идут подряд', () => {
    const r = read(entries.find((e) => picked(e.body) && e.body.abilities?.ability5)!.body)!;
    const plus = r.abilities.find((a) => a.key.startsWith('plus_'))!;
    expect(plus.slot).toBeNull();
    expect(r.abilities.filter((a) => a.slot !== null).map((a) => a.slot)).toEqual([0, 1, 2, 3, 4]);
    expect(r.abilities[0]).toMatchObject({ key: 'antimage_mana_break', slot: 0 });
  });

  it('preserved_neutral6…10, previously и added пропускаются без ошибок; neutral1 — ячейка neutral2', () => {
    const e = entries.find((x) => picked(x.body) && x.body.items?.preserved_neutral6 && x.body.previously && x.body.items?.neutral1)!;
    expect(e).toBeDefined();
    const r = read(e.body)!;
    const slots = r.items!.map((s) => s.slot);
    expect(slots.some((s) => s.startsWith('preserved'))).toBe(false);
    expect(slots).toContain('neutral2');
    expect(slots).toContain('tp');
    expect(r.items!.find((s) => s.slot === 'tp')!.key).toBe('tpscroll');
    const withAdded = entries.find((x) => picked(x.body) && x.body.added)!;
    expect(read(withAdded.body)).not.toBeNull();
  });

  it('вся запись через ingestGsi: герой Anti-Mage (id 1), события — ровно те, что в записи, по одному', () => {
    // Независимый подсчёт по сырым телам: повышения уровня и изученные способности между соседними телами
    // с героем (после тишины GSI дольше GSI_LIVE_MS изменение — сверка, а не событие)
    let levelUps = 0;
    let learned = 0;
    let prev: Entry | null = null;
    for (const e of entries) {
      if (!picked(e.body)) continue;
      if (prev && e.t - prev.t < GSI_LIVE_MS) {
        const pl = prev.body.hero.level, nl = e.body.hero.level;
        if (typeof pl === 'number' && typeof nl === 'number' && nl > pl) levelUps++;
        for (const [k, a] of Object.entries<any>(e.body.abilities ?? {})) {
          const p = prev.body.abilities?.[k];
          if (!p || p.name !== a.name || /^(plus_|special_bonus_)/.test(a.name)) continue;
          if (typeof p.level === 'number' && typeof a.level === 'number' && a.level > p.level) learned++;
        }
      }
      prev = e;
    }
    expect(levelUps).toBe(2);
    expect(learned).toBe(1);

    const m = new MatchStateModel();
    for (const e of entries) {
      const r = read(e.body);
      if (r) m.ingestGsi(r, e.t);
    }
    const last = entries.at(-1)!.t;
    const s = m.snapshot(last);
    expect(s.hero.identity.value).toEqual({ id: 1, name: 'Anti-Mage' });
    expect(s.hero.locked).toBe(true);
    expect(s.hero.level.value).toBe(3);
    const evs = s.events.map((x) => ({ type: x.type, ...x.data }));
    expect(evs).toEqual([
      { type: 'level-up', from: 1, to: 2 },
      { type: 'level-up', from: 2, to: 3 },
      { type: 'ability-learned', index: 0, from: 0, to: 1 },
    ]);
    expect(evs.filter((x) => x.type === 'level-up')).toHaveLength(levelUps);
    expect(evs.filter((x) => x.type === 'ability-learned')).toHaveLength(learned);
  });
});
