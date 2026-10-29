// Мета патча на главной: сильные герои по позициям (OpenDota heroStats + позиции STRATZ) и изменения героев в патчах
// (официальные описания Valve, datafeed/patchnotes, на русском).

/** Группа рангов OpenDota: 1 Рекрут … 8 Титан */
export type MetaBracket = 'all' | 'mid' | 'high';
export const META_BRACKETS: Record<MetaBracket, { nameRu: string; ids: number[] }> = {
  all: { nameRu: 'Все ранги', ids: [1, 2, 3, 4, 5, 6, 7, 8] },
  mid: { nameRu: 'Герой – Легенда', ids: [4, 5] },
  high: { nameRu: 'Властелин и выше', ids: [6, 7, 8] },
};

export interface MetaHeroRow {
  hero: string;
  name: string;
  /** Доля побед в выбранных рангах (0–1) */
  winrate: number;
  /** Игр в выбранных рангах */
  picks: number;
  /** Доля матчей, где героя берут (0–1) */
  pickRate: number;
  /** Изменение доли побед с прежнего замера (≥ 3 дней назад), п.п.; null — замера нет или изменение мало */
  trend: number | null;
  /** Доля игр героя на этой позиции у сильных игроков (0–1); null — позиция по ролям базы знаний */
  positionShare: number | null;
  /** Герой изменён в последнем патче */
  changedInLatest: boolean;
}

export interface MetaPatchInfo {
  version: string;
  /** Дата выхода, ISO */
  date: string | null;
}

export interface MetaState {
  /** Позиция 1–5 → лучшие герои; «0» — все позиции вместе */
  positions: Record<string, MetaHeroRow[]>;
  bracket: MetaBracket;
  /** Когда скачана статистика (ISO); null — ещё ни разу */
  statsAt: string | null;
  /** Откуда позиции: STRATZ (сильные игроки рейтинга) или роли базы знаний */
  positionsFrom: 'stratz' | 'roles';
  /** Патчи текущей версии, от новых к старым */
  patches: MetaPatchInfo[];
  /** Идёт обновление */
  refreshing: boolean;
  /** Почему данных нет или они старые (по-русски); null — всё хорошо */
  note: string | null;
}

export interface MetaChangeNote {
  /** Способность, талант, аспект или «Герой» */
  title: string;
  text: string;
  indent: number;
}

export interface MetaHeroChanges {
  hero: string;
  name: string;
  patches: { version: string; date: string | null; notes: MetaChangeNote[] }[];
  /** Текущая сила героя по позициям (все ранги и выбранные); пусто — нет статистики */
  winrate: number | null;
  picks: number | null;
}
