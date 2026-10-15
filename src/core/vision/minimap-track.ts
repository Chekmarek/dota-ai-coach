// Сопровождение значков мини-карты во времени: значок героя не может мгновенно оказаться на другом конце карты.
// Одиночный кадр с чужим пятном того же цвета (крип, эффект, иллюзия Phantom Lancer рядом с другим героем) иначе
// выглядит как «герой там» — подмена. Правила:
// - Из значков цвета игрока выбирается достижимый от прежнего места (скорость героя + погрешность), ближайший к нему.
// - Значок вне досягаемости (скачок) или первый после долгого перерыва — «не подтверждён»: в чтении он помечен
//   ambiguous («вывод», коуч не утверждает, что герой там), пока не продержится CONFIRM_MS (скачок — JUMP_CONFIRM_MS)
//   в нескольких чтениях подряд (без разрывов дольше PENDING_GAP_MS). Телепорт и прыжок подтверждаются так же —
//   с задержкой, но без подмены.
// - Если у игрока недавно (ILLUSION_MEMORY_MS) было несколько значков его цвета — иллюзии или клоны, — где он сам,
//   по мини-карте не сказать: место помечается «вывод», даже когда сейчас значок один (сам герой мог скрыться).
// Состояние — только последние места; время передаётся снаружи. Чистое ядро: без Electron, DOM, сети и файлов.
import type { MinimapHero, MinimapReading } from './minimap.ts';

/** Погрешность места значка (единицы мира) — запас к пути, пройденному героем */
export const TRACK_POSITION_SLACK = 500;
/** Самая большая скорость героя (единицы в секунду): предел скорости бега 550, с запасом на рывки */
export const TRACK_MAX_SPEED = 750;
/** Место значка помним для сопровождения столько (мс); дальше значок считается увиденным впервые */
export const TRACK_MEMORY_MS = 8000;
/** Впервые (или после перерыва) увиденный значок подтверждается, продержавшись столько (мс) */
export const CONFIRM_MS = 1000;
/** Значок после скачка от недавнего места подтверждается дольше: иллюзии Phantom Lancer живут несколько секунд */
export const JUMP_CONFIRM_MS = 4500;
/** Неподтверждённый значок должен появляться без разрывов дольше этого (мс), иначе подтверждение начинается заново */
export const PENDING_GAP_MS = 2500;
/** Сколько (мс) после последнего кадра с несколькими значками одного игрока его место остаётся «выводом» */
export const ILLUSION_MEMORY_MS = 15_000;

interface Track {
  x: number;
  y: number;
  wallMs: number;
}

interface Pending extends Track {
  sinceMs: number;
  /** Скачок от недавнего подтверждённого места (иначе — первый показ после перерыва) */
  jump: boolean;
}

const reach = (dtMs: number) => TRACK_POSITION_SLACK + (TRACK_MAX_SPEED * Math.max(0, dtMs)) / 1000;

export class MinimapTracker {
  private tracks = new Map<number, Track>();
  private pending = new Map<number, Pending>();
  /** Когда у игрока последний раз было несколько значков его цвета */
  private multiAt = new Map<number, number>();

  reset(): void {
    this.tracks.clear();
    this.pending.clear();
    this.multiAt.clear();
  }

  /** Чтение мини-карты → то же чтение, где у каждого героя выбран значок и неподтверждённые помечены ambiguous */
  update(r: MinimapReading, wallMs: number): MinimapReading {
    if (!r.supported) return r;
    return {
      ...r,
      heroes: r.heroes.map((h) => {
        if (h.ambiguous || h.others.length > 0) this.multiAt.set(h.slot, wallMs);
        const d = this.decide(h, wallMs);
        const m = this.multiAt.get(h.slot);
        const illusions = m !== undefined && wallMs >= m && wallMs - m <= ILLUSION_MEMORY_MS;
        return illusions && !d.ambiguous ? { ...d, ambiguous: true, confidence: Math.min(d.confidence, 0.3) } : d;
      }),
    };
  }

  private decide(h: MinimapHero, wallMs: number): MinimapHero {
    const all = [{ x: h.x, y: h.y, n: Number.POSITIVE_INFINITY }, ...h.others];
    const track = this.tracks.get(h.slot);
    // Время назад (перемотка записи) — прежние места не годятся
    const fresh = track && wallMs >= track.wallMs && wallMs - track.wallMs <= TRACK_MEMORY_MS ? track : null;
    if (fresh) {
      // Достижимые от прежнего места значки; из них — ближайший (а не самый крупный)
      const r = reach(wallMs - fresh.wallMs);
      let best: { x: number; y: number } | null = null, bd = Number.POSITIVE_INFINITY;
      for (const c of all) {
        const d = Math.hypot(c.x - fresh.x, c.y - fresh.y);
        if (d <= r && d < bd) (best = c), (bd = d);
      }
      if (best) {
        this.tracks.set(h.slot, { x: best.x, y: best.y, wallMs });
        this.pending.delete(h.slot);
        // Несколько похожих значков рядом с героем (иллюзии) — по-прежнему «вывод»
        return { ...h, x: best.x, y: best.y, ambiguous: h.ambiguous };
      }
    }
    // Значок вне досягаемости или первый показ: подтверждается, если держится на одном месте (с учётом бега)
    const p = this.pending.get(h.slot);
    const cont = p && wallMs >= p.wallMs && wallMs - p.wallMs <= PENDING_GAP_MS && Math.hypot(h.x - p.x, h.y - p.y) <= reach(wallMs - p.wallMs) ? p : null;
    const next: Pending = cont ? { x: h.x, y: h.y, wallMs, sinceMs: cont.sinceMs, jump: cont.jump } : { x: h.x, y: h.y, wallMs, sinceMs: wallMs, jump: !!fresh };
    if (wallMs - next.sinceMs >= (next.jump ? JUMP_CONFIRM_MS : CONFIRM_MS)) {
      this.tracks.set(h.slot, { x: h.x, y: h.y, wallMs });
      this.pending.delete(h.slot);
      return h;
    }
    this.pending.set(h.slot, next);
    return { ...h, ambiguous: true, confidence: Math.min(h.confidence, 0.3) };
  }
}
