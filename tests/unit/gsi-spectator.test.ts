import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseSpectatorGsi } from '../../src/core/gsi/spectator.ts';
import { mapGsi } from '../../src/core/gsi/map.ts';

const FIX = join(import.meta.dirname, '../fixtures/gsi');
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8'));

// Тело наблюдателя синтетическое (tests/fixtures/gsi/README.md): формат по описаниям GSI, настоящей записью не проверен
describe('GSI наблюдателя → все 10 героев', () => {
  const r = parseSpectatorGsi(load('spectator.json'))!;

  it('10 героев по номерам игроков, команды по team2/team3', () => {
    expect(r.heroes).toHaveLength(10);
    expect(r.heroes.map((h) => h.slot)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(r.heroes.filter((h) => h.team === 'radiant').map((h) => h.heroKey)).toEqual(['antimage', 'nevermore', 'pudge', 'crystal_maiden', 'lion']);
    expect(r.heroes.filter((h) => h.team === 'dire')).toHaveLength(5);
    expect(r.clock).toBe(1210);
    expect(r.daytime).toBe(true);
  });

  it('позиция, здоровье, уровень, смерть и время возрождения', () => {
    expect(r.heroes[0]).toEqual({ team: 'radiant', slot: 0, heroKey: 'antimage', xpos: -6000, ypos: -5500, alive: true, respawnSec: 0, health: 400, maxHealth: 800, level: 5 });
    expect(r.heroes[7]).toMatchObject({ heroKey: 'lina', alive: false, respawnSec: 23, health: 0 });
  });

  it('неверное поле одного героя → null, остальное сохраняется', () => {
    expect(r.heroes[9]).toMatchObject({ heroKey: 'witch_doctor', xpos: null, health: null, ypos: 3500, level: 14 });
  });

  it('режим игрока, меню и мусор — не тело наблюдателя', () => {
    expect(parseSpectatorGsi(load('laning.json'))).toBeNull();
    expect(parseSpectatorGsi(load('menu.json'))).toBeNull();
    expect(parseSpectatorGsi('не json')).toBeNull();
    expect(parseSpectatorGsi({ hero: { team2: {} } })).toBeNull();
    expect(parseSpectatorGsi(JSON.stringify(load('spectator.json')))?.heroes).toHaveLength(10);
  });

  it('герой ещё не выбран — heroKey null', () => {
    const r2 = parseSpectatorGsi({ hero: { team2: { player0: { id: 0, name: '' } } } })!;
    expect(r2.heroes[0]).toMatchObject({ heroKey: null, xpos: null, alive: null });
  });

  it('режим игрока (mapGsi) тело наблюдателя не принимает — как и раньше', () => {
    expect(mapGsi(load('spectator.json'), () => undefined, () => undefined)).toBeNull();
  });
});
