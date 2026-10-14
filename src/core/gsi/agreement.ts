// Сверка зрения с GSI — измерение точности распознавания на живой игре.
// GSI — эталон: ступенчатая функция времени (Dota шлёт его при изменениях). Чтение с экрана в момент t
// считается верным, если совпадает с одним из чтений GSI в окне ±AGREE_WINDOW_MS: значение могло смениться
// между кадром и запросом GSI, и сравнение только с ближайшим давало бы ложные расхождения.
// Чистое ядро: без Electron, DOM, сети и файлов.
import type { HudReading } from '../vision/recognize-hud.ts';
import type { Pool } from '../vision/hud-fields.ts';
import type { GsiReading } from './map.ts';
import type { VisionAgreementField } from './vision-agreement.ts';

/** Чтения двух источников сравниваются, если между ними не больше этого (мс) */
export const AGREE_WINDOW_MS = 1500;
/** Допуск для здоровья и маны: доля от максимума */
export const POOL_TOLERANCE = 0.02;
/** Допуск для игровых часов, секунды: GSI и экран показывают целые секунды и обновляются не одновременно */
export const CLOCK_TOLERANCE_SEC = 1;
/** Ниже этой уверенности ячейка с экрана не сравнивается (как MIN_SLOT_CONFIDENCE модели) */
const MIN_SLOT_CONFIDENCE = 0.5;

export type AgreementField =
  | 'clock'
  | 'scoreRadiant'
  | 'scoreDire'
  | 'dayNight'
  | 'kda'
  | 'farm'
  | 'heroName'
  | 'level'
  | 'gold'
  | 'health'
  | 'mana'
  | 'abilityState'
  | 'abilityLevel'
  | 'items';

export interface FieldAgreement {
  samples: number;
  /** Доля совпадений, 0…100; null — сравнений ещё не было */
  agreePct: number | null;
  lastMismatch: { gsi: unknown; screen: unknown; wallMs: number } | null;
}

/** Поля игрока (AgreementTracker) и зрения о союзниках и врагах по GSI наблюдателя (VisionAgreementTracker) */
export type AgreementReport = Partial<Record<AgreementField | VisionAgreementField, FieldAgreement>>;

interface Sample {
  /** Значение с экрана и как его сравнить со значением GSI того же поля */
  field: AgreementField;
  screen: unknown;
  pick: (g: GsiReading) => unknown;
  match: (gsi: unknown, screen: unknown, dtMs: number, g: GsiReading) => boolean;
}

interface PendingFrame {
  wallMs: number;
  samples: Sample[];
}

const exact = (a: unknown, b: unknown) => a === b;
const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function samePool(g: unknown, s: unknown): boolean {
  const a = g as Pool, b = s as Pool;
  const tol = POOL_TOLERANCE * Math.max(a.max, 1);
  return Math.abs(a.max - b.max) <= tol && Math.abs(a.current - b.current) <= tol;
}

export class AgreementTracker {
  /** Чтения GSI за последние 2 окна */
  private gsi: { wallMs: number; r: GsiReading }[] = [];
  /** Кадры, которые ждут чтения GSI после себя (или конца окна) */
  private pending: PendingFrame[] = [];
  private stats = new Map<AgreementField, { samples: number; agree: number; lastMismatch: FieldAgreement['lastMismatch'] }>();

  addGsi(r: GsiReading, wallMs: number): void {
    this.gsi.push({ wallMs, r });
    this.settle(wallMs, false);
  }

  addScreen(r: HudReading, wallMs: number): void {
    const samples = this.samplesOf(r);
    if (samples.length > 0) this.pending.push({ wallMs, samples });
    this.settle(wallMs, false);
  }

  /** Итог по полям; незавершённые кадры (окно ещё открыто) сравниваются с тем, что уже есть */
  /**
   * nowMs не задан — итог: незавершённые кадры сравниваются с тем, что уже есть.
   * nowMs задан (живой режим) — сравниваются только кадры, окно которых уже закрыто: отчёт можно брать часто.
   */
  report(nowMs?: number): AgreementReport {
    if (nowMs === undefined) this.settle(Number.POSITIVE_INFINITY, true);
    else this.settle(nowMs, false);
    const out: AgreementReport = {};
    for (const [field, s] of this.stats) {
      out[field] = { samples: s.samples, agreePct: s.samples ? Math.round((s.agree / s.samples) * 1000) / 10 : null, lastMismatch: s.lastMismatch };
    }
    return out;
  }

  reset(): void {
    this.gsi = [];
    this.pending = [];
    this.stats.clear();
  }

  /** Сравнивает кадры, для которых чтения GSI вокруг уже известны */
  private settle(nowMs: number, all: boolean): void {
    const latestGsi = this.gsi.length ? this.gsi[this.gsi.length - 1]!.wallMs : null;
    const keep: PendingFrame[] = [];
    for (const p of this.pending) {
      const ready = all || (latestGsi !== null && latestGsi >= p.wallMs) || nowMs - p.wallMs > AGREE_WINDOW_MS;
      if (!ready) {
        keep.push(p);
        continue;
      }
      const around = this.gsi.filter((g) => Math.abs(g.wallMs - p.wallMs) <= AGREE_WINDOW_MS);
      if (around.length > 0) for (const s of p.samples) this.compare(s, around, p.wallMs);
    }
    this.pending = keep;
    // Старые чтения GSI больше не понадобятся
    const oldest = keep.length ? keep[0]!.wallMs : nowMs;
    if (Number.isFinite(oldest)) this.gsi = this.gsi.filter((g) => g.wallMs >= oldest - AGREE_WINDOW_MS);
  }

  private compare(s: Sample, around: { wallMs: number; r: GsiReading }[], wallMs: number): void {
    let nearest: { v: unknown; dt: number } | null = null;
    let agreed = false;
    for (const g of around) {
      const v = s.pick(g.r);
      if (v === null || v === undefined) continue;
      const dt = wallMs - g.wallMs;
      if (!nearest || Math.abs(dt) < Math.abs(nearest.dt)) nearest = { v, dt };
      if (s.match(v, s.screen, dt, g.r)) agreed = true;
    }
    if (!nearest) return; // GSI это поле не сообщает — сравнивать не с чем
    const st = this.stats.get(s.field) ?? { samples: 0, agree: 0, lastMismatch: null };
    st.samples++;
    if (agreed) st.agree++;
    else st.lastMismatch = { gsi: nearest.v, screen: s.screen, wallMs };
    this.stats.set(s.field, st);
  }

  /** Что с этого кадра можно сравнить с GSI */
  private samplesOf(r: HudReading): Sample[] {
    if (!r.supported) return [];
    const out: Sample[] = [];
    const f = r.fields;
    const add = (field: AgreementField, screen: unknown, pick: Sample['pick'], match: Sample['match'] = exact) => out.push({ field, screen, pick, match });
    const ok = <T>(o: { value: T | null; validity: string }) => o.validity === 'valid' && o.value !== null;

    // Время: GSI экстраполируется на момент кадра (кроме паузы)
    if (ok(f.gameClock))
      add('clock', f.gameClock.value, (g) => g.clock, (gv, sv, dt, g) => {
        const expected = (gv as number) + (g.paused ? 0 : dt / 1000);
        return Math.abs((sv as number) - expected) <= CLOCK_TOLERANCE_SEC;
      });
    if (ok(f.scoreRadiant)) add('scoreRadiant', f.scoreRadiant.value, (g) => g.scoreRadiant);
    if (ok(f.scoreDire)) add('scoreDire', f.scoreDire.value, (g) => g.scoreDire);
    if (ok(r.dayNight)) add('dayNight', r.dayNight.value, (g) => g.dayNight);
    // Блок слева вверху — всегда свой игрок
    if (ok(f.kda)) add('kda', f.kda.value, (g) => g.kda, sameJson);
    if (ok(f.farm)) add('farm', f.farm.value, (g) => g.farm, sameJson);

    // Нижняя панель — только когда выбран свой юнит; чей он, решает имя (сверяется с героем GSI)
    if (r.selectedUnit.value !== 'ally' || r.selectedUnit.validity !== 'valid') return out;
    const name = ok(r.heroName) ? r.heroName.value! : null;
    if (name) add('heroName', name.id, (g) => g.hero.id);
    // Без имени нельзя быть уверенным, что на панели свой герой, — поля панели не сравниваются
    const own = (pick: Sample['pick']): Sample['pick'] => (g) => (name && g.hero.id === name.id ? pick(g) : null);
    if (!name) return out;

    if (ok(f.level)) add('level', f.level.value, own((g) => g.hero.level));
    if (ok(f.gold)) add('gold', f.gold.value, own((g) => g.gold));
    if (ok(f.health)) add('health', f.health.value, own((g) => g.hero.health), samePool);
    if (ok(f.mana)) add('mana', f.mana.value, own((g) => g.hero.mana), samePool);

    for (const a of r.abilities ?? []) {
      if (a.confidence < MIN_SLOT_CONFIDENCE) continue;
      const bySlot = (g: GsiReading) => g.abilities.find((x) => x.slot === a.index) ?? null;
      add('abilityState', a.state, own((g) => bySlot(g)?.state ?? null));
      add('abilityLevel', a.level, own((g) => bySlot(g)?.level ?? null));
    }
    for (const it of r.items ?? []) {
      // Предмет есть, но не узнан — сравнивать нечего
      if (it.confidence < MIN_SLOT_CONFIDENCE || (!it.empty && !it.item)) continue;
      const screenKey = it.empty ? null : it.item!.key;
      const aliases = it.empty ? [] : (it.item!.aliases ?? []);
      add(
        'items',
        `${it.slot}:${screenKey ?? '—'}`,
        own((g) => {
          const slot = g.items?.find((x) => x.slot === it.slot);
          return slot ? `${it.slot}:${slot.key ?? '—'}` : null;
        }),
        // Одинаковые иконки (aliases) по картинке не различить — это не ошибка зрения
        (gv) => gv === `${it.slot}:${screenKey ?? '—'}` || aliases.some((k) => gv === `${it.slot}:${k}`),
      );
    }
    return out;
  }
}
