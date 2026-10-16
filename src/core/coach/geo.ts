// Геометрия карты для правил (единицы мира Dota). Границы приблизительные — по форме карты, не данные Valve:
// поэтому факты, построенные на них, помечаются как вывод (derived) с уверенностью ниже 1.
import type { MapPoint } from '../match-state/index.ts';
import type { MapZone } from '../match-state/map-zones.ts';

/** Дистанция «рядом» (примерно экран игрока) и «в драке» */
export const NEAR_UNITS = 2500;
export const CLOSE_UNITS = 1500;
/** Ширина полосы реки по диагонали x + y ≈ 0 */
const RIVER_BAND = 1200;

export function dist(a: MapPoint, b: MapPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Половина карты относительно своей команды */
export function mapSide(p: MapPoint, team: 'radiant' | 'dire'): 'own' | 'river' | 'enemy' {
  const d = p.x + p.y;
  if (Math.abs(d) < RIVER_BAND) return 'river';
  const radiantHalf = d < 0;
  return radiantHalf === (team === 'radiant') ? 'own' : 'enemy';
}

export function isEnemyJungle(zone: MapZone | null, team: 'radiant' | 'dire'): boolean {
  return zone === (team === 'radiant' ? 'dire-jungle' : 'radiant-jungle');
}
export function isOwnBase(zone: MapZone | null, team: 'radiant' | 'dire'): boolean {
  return zone === (team === 'radiant' ? 'radiant-base' : 'dire-base');
}

/** Линия здания по ключу Valve (tower1_top, rax_melee_bot, …); null — база/трон */
export function buildingLane(key: string): 'top-lane' | 'mid-lane' | 'bot-lane' | null {
  if (/_top$/.test(key)) return 'top-lane';
  if (/_mid$/.test(key)) return 'mid-lane';
  if (/_bot$/.test(key)) return 'bot-lane';
  return null;
}

export const BUILDING_RU = (key: string): string => {
  const lane = { 'top-lane': 'верхней', 'mid-lane': 'средней', 'bot-lane': 'нижней' }[buildingLane(key) ?? 'mid-lane'];
  const t = /^tower(\d)/.exec(key);
  if (t) return Number(t[1]) >= 4 ? 'башню трона' : `башню T${t[1]} на ${lane} линии`;
  if (/^rax/.test(key)) return `казармы на ${lane} линии`;
  if (/fort/.test(key)) return 'трон';
  return 'здание';
};
