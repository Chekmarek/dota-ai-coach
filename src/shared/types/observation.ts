/** Прямоугольник в пикселях кадра */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Validity =
  | 'valid'
  /** значение старое — обновлений давно не было */
  | 'stale'
  /** противоречит другим наблюдениям */
  | 'conflicting'
  /** текст прочитан, но значение вне допустимых пределов */
  | 'out-of-range'
  /** текст не удалось разобрать */
  | 'unparsed'
  /** в области нет текста (элемент скрыт, перекрыт меню и т.п.) */
  | 'absent'
  /** интерфейс не поддерживается (другое соотношение сторон и т.п.) */
  | 'unsupported';

export interface RegionRef {
  layoutId: string;
  regionId: string;
  rect: Rect;
  frameSize: { w: number; h: number };
}

/** Любое значение, полученное с экрана. value = null — не распознано; ничего не выдумываем. */
export interface Observed<T> {
  value: T | null;
  confidence: number;
  /** Время кадра (мс от начала записи, если известно; иначе время получения кадра) */
  observedAt: number;
  sourceRegion: RegionRef;
  validity: Validity;
  /** Версия раскладки HUD */
  schemaVersion: string;
  /** Сырой распознанный текст — для диагностики */
  raw: string;
}
