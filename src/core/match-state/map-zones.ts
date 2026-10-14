// Грубое название места на карте по координатам мира — для «где видели» в интерфейсе и контексте ИИ.
// Карта Dota — квадрат примерно ±8800 единиц; база Сил Света слева внизу, Сил Тьмы справа вверху,
// река идёт по диагонали из левого верхнего угла в правый нижний (x + y ≈ 0).
// Границы приблизительные (по форме карты, не по данным Valve): это подпись, а не правило игры.
// Чистое ядро: без Electron, DOM, сети и файлов.

export type MapZone =
  | 'radiant-base'
  | 'dire-base'
  | 'top-lane'
  | 'bot-lane'
  | 'mid-lane'
  | 'river'
  | 'radiant-jungle'
  | 'dire-jungle';

export const MAP_ZONE_RU: Record<MapZone, string> = {
  'radiant-base': 'база Сил Света',
  'dire-base': 'база Сил Тьмы',
  'top-lane': 'верхняя линия',
  'bot-lane': 'нижняя линия',
  'mid-lane': 'средняя линия',
  river: 'река',
  'radiant-jungle': 'лес Сил Света',
  'dire-jungle': 'лес Сил Тьмы',
};

/** Граница мира, которую рисует интерфейс (единицы карты) */
export const MAP_HALF_SIZE = 8800;

export function mapZone(x: number, y: number): MapZone {
  if (x < -4800 && y < -4300) return 'radiant-base';
  if (x > 4300 && y > 3800) return 'dire-base';
  if (x < -5600 || y > 5600) return 'top-lane';
  if (x > 5600 || y < -5600) return 'bot-lane';
  if (Math.abs(x - y) < 1400) return 'mid-lane';
  if (Math.abs(x + y) < 1200) return 'river';
  return x + y < 0 ? 'radiant-jungle' : 'dire-jungle';
}
