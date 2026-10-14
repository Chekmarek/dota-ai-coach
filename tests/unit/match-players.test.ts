import { describe, expect, it } from 'vitest';
import { PLAYER_LOCK_READS, PlayersTrack } from '../../src/core/match-state/players.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import type { TopBarReading, TopBarSlot } from '../../src/core/vision/top-bar.ts';

const KEYS = ['antimage', 'nevermore', 'pudge', 'crystal_maiden', 'lion', 'axe', 'juggernaut', 'lina', 'earthshaker', 'witch_doctor'];

/** Чтение верхней панели: по умолчанию все живы и узнаны; patch — изменения отдельных ячеек */
function bar(patch: Record<number, Partial<TopBarSlot>> = {}): TopBarReading {
  return {
    supported: true,
    durationMs: 1,
    slots: KEYS.map((k, slot) => ({
      slot,
      team: slot < 5 ? 'radiant' : 'dire',
      side: null,
      heroKey: k,
      heroConfidence: 0.6,
      alive: true,
      aliveConfidence: 0.9,
      respawnSec: null,
      respawnConfidence: 0,
      ...patch[slot],
    })),
  };
}

describe('союзники и враги по верхней панели', () => {
  it('герой ячейки фиксируется только после нескольких согласных чтений', () => {
    const p = new PlayersTrack();
    for (let i = 0; i < PLAYER_LOCK_READS - 1; i++) p.ingest(bar(), 100, 1000 + i * 250);
    expect(p.snapshot(2500).players[1]!).toMatchObject({ locked: false, hero: { value: null, tag: 'unknown' } });
    p.ingest(bar(), 100, 2500);
    const s = p.snapshot(2600).players[1]!;
    expect(s).toMatchObject({ locked: true, hero: { value: 'nevermore', source: 'screen' } });
  });

  it('после фиксации ошибочное чтение героя не меняет', () => {
    const p = new PlayersTrack();
    for (let i = 0; i < PLAYER_LOCK_READS; i++) p.ingest(bar(), 100, 1000 + i * 250);
    for (let i = 0; i < 10; i++) p.ingest(bar({ 1: { heroKey: 'pudge', heroConfidence: 0.9 } }), 100, 5000 + i * 250);
    expect(p.snapshot(8000).players[1]!.hero.value).toBe('nevermore');
  });

  it('разнобой чтений (меньше 80 % согласных) — не фиксируется', () => {
    const p = new PlayersTrack();
    for (let i = 0; i < 10; i++) p.ingest(bar({ 2: { heroKey: i % 2 ? 'pudge' : 'lion' } }), 100, 1000 + i * 250);
    expect(p.snapshot(4000).players[2]!.locked).toBe(false);
  });

  it('смерть и время возрождения — игровое время + таймер, только пока мёртв', () => {
    const p = new PlayersTrack();
    const dead = { 7: { alive: false, aliveConfidence: 0.95, respawnSec: 30, respawnConfidence: 0.8 } };
    p.ingest(bar(dead), 600, 1000);
    p.ingest(bar({ 7: { ...dead[7], respawnSec: 29 } }), 601, 2000);
    const s = p.snapshot(2100).players[7]!;
    expect(s.alive).toMatchObject({ value: false, tag: 'visible' });
    expect(s.respawnAt.value).toBe(630);
    // Возродился — «возродится в» больше не показывается
    p.ingest(bar(), 631, 32000);
    p.ingest(bar(), 632, 33000);
    expect(p.snapshot(33100).players[7]!).toMatchObject({ alive: { value: true }, respawnAt: { value: null } });
  });

  it('без часов матча «возродится в» не вычисляется (не угадываем)', () => {
    const p = new PlayersTrack();
    p.ingest(bar({ 3: { alive: false, aliveConfidence: 0.95, respawnSec: 40, respawnConfidence: 0.9 } }), null, 1000);
    p.ingest(bar({ 3: { alive: false, aliveConfidence: 0.95, respawnSec: 39, respawnConfidence: 0.9 } }), null, 2000);
    expect(p.snapshot(2100).players[3]!.respawnAt.value).toBeNull();
  });

  it('союзники и враги — только когда своя команда известна из GSI', () => {
    const p = new PlayersTrack();
    p.ingest(bar(), 100, 1000);
    expect(p.snapshot(1100)).toMatchObject({ ourTeam: null, allies: [], enemies: [] });
    p.setOurTeam('dire');
    const s = p.snapshot(1200);
    expect(s.allies.map((x) => x.slot)).toEqual([5, 6, 7, 8, 9]);
    expect(s.enemies.map((x) => x.slot)).toEqual([0, 1, 2, 3, 4]);
    expect(s.players.every((x) => x.side === (x.slot < 5 ? 'enemy' : 'ally'))).toBe(true);
  });

  it('тёмная или неподдерживаемая панель ничего не меняет', () => {
    const p = new PlayersTrack();
    p.ingest({ supported: false, slots: [], durationMs: 0 }, 100, 1000);
    expect(p.snapshot(1100).players).toEqual([]);
    p.ingest(bar({ 0: { heroKey: null, alive: null, heroConfidence: 0 } }), 100, 1000);
    expect(p.snapshot(1100).players[0]!.alive.value).toBeNull();
  });

  it('модель матча: в снимке есть players/allies/enemies, сброс матча их очищает', () => {
    const m = new MatchStateModel();
    expect(m.snapshot(0)).toMatchObject({ ourTeam: null, players: [], allies: [], enemies: [] });
    m.reset(1);
    expect(m.snapshot(2).players).toEqual([]);
  });
});

describe('мини-карта в модели: позиция и «пропал»', () => {
  const mm = (heroes: { slot: number; x: number; y: number }[]) => ({
    supported: true,
    rect: null,
    durationMs: 1,
    heroes: heroes.map((h) => ({ ...h, team: (h.slot < 5 ? 'radiant' : 'dire') as 'radiant' | 'dire', px: 0, py: 0, confidence: 0.9, ambiguous: false })),
  });

  it('позиция: «видно сейчас», затем «видели раньше» с временем последнего показа', () => {
    const p = new PlayersTrack();
    p.ingestMinimap(mm([{ slot: 6, x: 1000, y: -2000 }]), 1000);
    expect(p.snapshot(1100).players[6]!.position).toMatchObject({ value: { x: 1000, y: -2000 }, tag: 'visible', lastSeenWallMs: 1000, source: 'screen' });
    p.ingestMinimap(mm([]), 4000);
    expect(p.snapshot(4000).players[6]!.position).toMatchObject({ value: { x: 1000, y: -2000 }, tag: 'remembered', lastSeenWallMs: 1000 });
  });

  it('враг пропал через 3 с без значка; до первого показа — не определить', () => {
    const p = new PlayersTrack();
    p.setOurTeam('radiant');
    p.ingest(bar(), 100, 0);
    p.ingestMinimap(mm([{ slot: 5, x: 0, y: 0 }]), 1000);
    p.ingestMinimap(mm([]), 2500);
    expect(p.snapshot(2500).players[5]!.missing).toBe(false);
    p.ingestMinimap(mm([]), 4100);
    expect(p.snapshot(4100).players[5]).toMatchObject({ missing: true, missingSinceWallMs: 4000 });
    // Врага в ячейке 6 ни разу не видели — «пропал» не срабатывает
    expect(p.snapshot(4100).players[6]!.missing).toBeNull();
    // Снова показался — не пропал
    p.ingestMinimap(mm([{ slot: 5, x: 100, y: 0 }]), 5000);
    expect(p.snapshot(5000).players[5]!.missing).toBe(false);
  });

  it('союзник, мёртвый враг или нет кадров мини-карты — «пропал» не определяется', () => {
    const p = new PlayersTrack();
    p.setOurTeam('radiant');
    p.ingestMinimap(mm([{ slot: 1, x: 0, y: 0 }, { slot: 7, x: 0, y: 0 }]), 1000);
    p.ingest(bar({ 7: { alive: false, aliveConfidence: 0.95, respawnSec: 20, respawnConfidence: 0.9 } }), 100, 1000);
    p.ingest(bar({ 7: { alive: false, aliveConfidence: 0.95, respawnSec: 19, respawnConfidence: 0.9 } }), 101, 2000);
    p.ingestMinimap(mm([]), 9000);
    const s = p.snapshot(9000);
    expect(s.players[1]!.missing).toBeNull(); // союзник
    expect(s.players[7]!.missing).toBeNull(); // мёртв
    // Кадров мини-карты давно нет (свернули Доту) — не утверждаем, что кто-то пропал
    expect(p.snapshot(20000).players.every((x) => x.missing === null)).toBe(true);
  });
});

describe('полоски здоровья в модели: привязка к игроку только несомненная', () => {
  const hb = (bars: { color: 'green' | 'red'; hpPercent: number; level: number | null }[]) => ({
    supported: true,
    durationMs: 1,
    bars: bars.map((b, k) => ({ ...b, levelConfidence: b.level === null ? 0 : 0.8, x: 100 * k, y: 300, length: 99, confidence: 1 })),
  });

  it('своя полоска (зелёная, уровень как у своего героя из GSI) — здоровье игрока; чужие не привязываются', () => {
    const p = new PlayersTrack();
    p.setOurTeam('dire');
    p.setLevel(7, 12, 1000);
    p.ingestHealthBars(hb([{ color: 'green', hpPercent: 64, level: 12 }, { color: 'red', hpPercent: 30, level: 12 }, { color: 'green', hpPercent: 90, level: null }]), 1000);
    const s = p.snapshot(1200);
    expect(s.players[7]!.hpPercent).toMatchObject({ value: 64, tag: 'visible', source: 'screen' });
    expect(s.players.filter((q) => q.hpPercent.value !== null).map((q) => q.slot)).toEqual([7]);
    expect(s.healthBars.map((b) => [b.side, b.slot])).toEqual([
      ['ally', 7],
      ['enemy', null],
      ['ally', null],
    ]);
    // Через 1,5 с — «видели раньше», через 10 с — неизвестно; полоски на экране — только свежие
    expect(p.snapshot(3000).players[7]!.hpPercent.tag).toBe('remembered');
    expect(p.snapshot(3000).healthBars).toEqual([]);
    expect(p.snapshot(11_500).players[7]!.hpPercent.value).toBeNull();
  });

  it('две зелёные полоски с тем же уровнем (иллюзия) — не привязываем ни одну', () => {
    const p = new PlayersTrack();
    p.setOurTeam('radiant');
    p.setLevel(2, 9, 1000);
    p.ingestHealthBars(hb([{ color: 'green', hpPercent: 80, level: 9 }, { color: 'green', hpPercent: 40, level: 9 }]), 1000);
    expect(p.snapshot(1100).players[2]!.hpPercent.value).toBeNull();
  });

  it('наблюдатель: команда по цвету (зелёные — Силы Света), без уровней игроков никто не назван', () => {
    const p = new PlayersTrack();
    p.ingestHealthBars(hb([{ color: 'green', hpPercent: 50, level: 3 }, { color: 'red', hpPercent: 20, level: 4 }]), 1000);
    expect(p.snapshot(1100).healthBars.map((b) => [b.team, b.side, b.slot])).toEqual([
      ['radiant', null, null],
      ['dire', null, null],
    ]);
  });
});
