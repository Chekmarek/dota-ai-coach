// События по источникам (экран и GSI). Правила (после проверки на настоящей Dota 2026-10-13):
//  1. Событие — только когда ТОТ ЖЕ источник видит, что изменилось ЕГО прежнее значение.
//  2. Первое значение от любого источника событием не бывает; расхождение экрана с GSI — тоже.
//  3. Если один источник уже выпустил событие о том же переходе (то же поле, то же новое значение) за последние
//     CROSS_SOURCE_WINDOW_SEC секунд игрового времени, второй источник, увидев тот же переход, молчит.
// Чистое ядро: без Electron, DOM и часов — время передаётся снаружи.

export type EventSource = 'gsi' | 'screen';

/** Окно, в котором одинаковый переход от второго источника считается повтором (секунды игрового времени) */
export const CROSS_SOURCE_WINDOW_SEC = 5;
/** Сколько помнить выпущенные переходы по «настенному» времени (защита от роста списка) */
const RECENT_KEEP_MS = 60_000;

/** Строка для сравнения значений независимо от порядка ключей объекта */
function canon(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(o[k])}`)
    .join(',')}}`;
}

interface Emitted {
  key: string;
  to: string;
  src: EventSource;
  /** Игровое время, секунды; null — не было известно */
  clock: number | null;
  wallMs: number;
}

export class SourceEventGate {
  /** Последнее подтверждённое значение каждого поля — отдельно для каждого источника */
  private own: Record<EventSource, Map<string, string>> = { gsi: new Map(), screen: new Map() };
  private recent: Emitted[] = [];

  /**
   * Источник подтвердил значение поля (принял новое или увидел то же, что принято).
   * true — у этого источника было своё прежнее значение и оно другое (правило 1); первое значение — false (правило 2).
   */
  observe(src: EventSource, key: string, value: unknown): boolean {
    const v = canon(value);
    const prev = this.own[src].get(key);
    this.own[src].set(key, v);
    return prev !== undefined && prev !== v;
  }

  /** Источник перестал вести поле (или замолчал): его следующее значение снова будет «первым» */
  forget(src: EventSource, key?: string): void {
    if (key === undefined) this.own[src].clear();
    else this.own[src].delete(key);
  }

  /**
   * Можно ли выпустить событие «поле key стало to» от источника src (правило 3).
   * Если можно — переход запоминается, чтобы второй источник его не повторил.
   */
  allow(src: EventSource, key: string, to: unknown, clock: number | null, wallMs: number): boolean {
    this.recent = this.recent.filter((r) => wallMs - r.wallMs <= RECENT_KEEP_MS && r.wallMs <= wallMs);
    const v = canon(to);
    const dup = this.recent.some((r) => {
      if (r.key !== key || r.to !== v || r.src === src) return false;
      if (r.clock !== null && clock !== null) return Math.abs(clock - r.clock) <= CROSS_SOURCE_WINDOW_SEC;
      return Math.abs(wallMs - r.wallMs) <= CROSS_SOURCE_WINDOW_SEC * 1000;
    });
    if (dup) return false;
    this.recent.push({ key, to: v, src, clock, wallMs });
    return true;
  }

  reset(): void {
    this.own.gsi.clear();
    this.own.screen.clear();
    this.recent = [];
  }
}
