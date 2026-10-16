// Подбор героя в драфте по статистике патча (публичные рейтинговые матчи, stats.json):
//  - против врагов: доля побед героя против каждого выбранного врага сверх ожидаемой по общей силе обоих;
//  - с союзниками: доля побед пары в одной команде сверх ожидаемой;
//  - общая сила героя в патче (небольшой вес).
// Мало игр — вклад сжимается к нулю (n / (n + SHRINK)): редкая пара не перевешивает частые.
// Итог в процентах — оценка «насколько больше шанс победы», это ориентир, а не обещание.
import { PRO_BUILD_MIN, type CoachLookup } from '../coach/data.ts';

/** Сжатие к нулю: при SHRINK игр вклад пары — половина наблюдаемого */
const SHRINK = 400;
/** Меньше стольких игр пара не считается вовсе */
const MIN_GAMES = 100;
/**
 * Вес общей силы героя в патче. Небольшой: у героев «для своих» (Meepo, Chen) доля побед завышена —
 * на них играют в основном те, кто умеет; без этого они были бы первыми в любом драфте
 */
const META_WEIGHT = 0.35;
/** Позиция подходит герою, если её доля у профи патча не меньше */
const POSITION_MIN_SHARE = 0.15;

export interface DraftInput {
  allies: string[];
  enemies: string[];
  /** Забаненные и уже взятые кем угодно — не предлагаем */
  bans?: string[];
  /** Желаемая позиция 1–5; null — любая */
  position?: number | null;
  limit?: number;
}

export interface DraftReason {
  hero: string;
  /** Вклад, доля (0.021 = +2,1 п.п.) */
  delta: number;
  games: number;
}

export interface DraftCandidate {
  hero: string;
  name: string;
  /** Сумма вкладов, доля */
  score: number;
  /** Вклады против врагов и с союзниками, от сильных к слабым */
  vsEnemies: DraftReason[];
  withAllies: DraftReason[];
  /** Вклад общей силы в патче (уже с весом), доля */
  meta: number;
  /** Позиции, на которых героя берут профи (1–5); пусто — нет данных */
  positions: number[];
  /** Сколько выбранных героев покрыто данными (честность оценки) */
  covered: number;
}

const shrink = (delta: number, games: number) => (games < MIN_GAMES ? 0 : (delta * games) / (games + SHRINK));
const r4 = (x: number) => Math.round(x * 10000) / 10000;

/** Вклад «a против b» сверх ожидаемого по общей силе a и b; null — нет данных */
export function counterDelta(look: CoachLookup, a: string, b: string): DraftReason | null {
  const m = look.matchup(a, b);
  const wb = look.winrate(b);
  if (!m || wb === null) return null;
  const expected = 0.5 + (m.base - 0.5) - (wb - 0.5);
  return { hero: b, delta: r4(shrink(m.winrate - expected, m.games)), games: m.games };
}

/** Вклад связки a и b сверх ожидаемого; null — нет данных */
export function synergyDelta(look: CoachLookup, a: string, b: string): DraftReason | null {
  const s = look.synergy(a, b);
  const wa = look.winrate(a);
  const wb = look.winrate(b);
  if (!s || wa === null || wb === null) return null;
  const expected = 0.5 + (wa - 0.5) + (wb - 0.5);
  return { hero: b, delta: r4(shrink(s.winrate - expected, s.games)), games: s.games };
}

/** Позиции героя у профи патча (доля ≥ POSITION_MIN_SHARE), по убыванию доли */
export function heroPositions(look: CoachLookup, key: string): number[] {
  const pro = look.statsFor(null, key)?.pro;
  const p = pro?.positions;
  // по нескольким матчам позиции случайны — тогда берём роли базы знаний
  if (!p || (pro?.games ?? 0) < PRO_BUILD_MIN) return [];
  return p
    .map((share, i) => ({ pos: i + 1, share }))
    .filter((x) => x.share >= POSITION_MIN_SHARE)
    .sort((a, b) => b.share - a.share)
    .map((x) => x.pos);
}

/** Позиция по главной (первой) роли базы знаний, когда профи героя почти не берут: Carry → 1–2, Support → 4–5, иначе 2–3 */
function kbPositions(look: CoachLookup, key: string): number[] {
  const main = look.heroByKey.get(key)?.roles[0];
  return main === 'Carry' ? [1, 2] : main === 'Support' ? [4, 5] : [2, 3];
}

export function suggestHeroes(look: CoachLookup, input: DraftInput): DraftCandidate[] {
  const taken = new Set([...input.allies, ...input.enemies, ...(input.bans ?? [])]);
  const out: DraftCandidate[] = [];
  for (const h of look.data.heroes) {
    if (taken.has(h.key)) continue;
    const proPos = heroPositions(look, h.key);
    const positions = proPos.length ? proPos : kbPositions(look, h.key);
    if (input.position && !positions.includes(input.position)) continue;
    const vs = input.enemies.map((e) => counterDelta(look, h.key, e)).filter((x): x is DraftReason => x !== null);
    const wi = input.allies.map((a) => synergyDelta(look, h.key, a)).filter((x): x is DraftReason => x !== null);
    const wr = look.winrate(h.key);
    if (wr === null) continue;
    const meta = r4(META_WEIGHT * shrink(wr - 0.5, look.statsFor(h.id)?.pub?.games ?? 0));
    const score = r4(vs.reduce((s, x) => s + x.delta, 0) + wi.reduce((s, x) => s + x.delta, 0) + meta);
    out.push({
      hero: h.key,
      name: h.name,
      score,
      vsEnemies: vs.sort((a, b) => b.delta - a.delta),
      withAllies: wi.sort((a, b) => b.delta - a.delta),
      meta,
      positions,
      covered: vs.length + wi.length,
    });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, input.limit ?? 10);
}

/** Против кого из врагов мой герой слабее всего (для подсказки в начале матча); от худшего */
export function worstMatchups(look: CoachLookup, me: string, enemies: readonly string[], limit = 2): DraftReason[] {
  return enemies
    .map((e) => counterDelta(look, me, e))
    .filter((x): x is DraftReason => x !== null && x.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, limit);
}

/** «+2,1%» */
export function pctRu(delta: number): string {
  const v = Math.round(delta * 1000) / 10;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toLocaleString('ru-RU')}%`;
}
