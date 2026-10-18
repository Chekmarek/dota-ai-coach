// Калькуляторы процентов. Модель — логистическая: базовая вероятность + сумма вкладов известных факторов.
// Неизвестный фактор вклада не даёт, но снижает уверенность оценки; при уверенности ниже порога процент не показываем.
// Значения весов — эвристика коуча (не статистика Valve): в фактах они помечаются как вывод (derived).
import type { CoachView, ViewPlayer } from './view.ts';
import { poolPct } from './view.ts';
import type { CoachMemory } from './memory.ts';
import { enemyNear, readyItems, tpReady, ultReady, hasRegen } from './memory.ts';
import type { CoachLookup } from './data.ts';
import { KEY_ITEMS } from './data.ts';
import { NEAR_UNITS, dist, mapSide } from './geo.ts';
import type { PercentEstimate, PercentFactor } from './types.ts';

export interface FactorInput {
  id: string;
  label: string;
  /** Сигнал −1…1 (1 — в пользу); null — неизвестно */
  value: number | null;
  /** Вес в логитах при сигнале 1 */
  weight: number;
  /** 0…1 — насколько верим значению */
  confidence: number;
  /** Важность фактора для уверенности оценки */
  importance: number;
}

const clamp = (x: number, a: number, b: number) => Math.min(b, Math.max(a, x));
const logit = (p: number) => Math.log(p / (1 - p));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
export const MIN_PCT = 5;
export const MAX_PCT = 95;

function pctOf(base: number, inputs: readonly FactorInput[], skip: number): number {
  let z = logit(clamp(base, 0.01, 0.99));
  inputs.forEach((f, i) => {
    if (i !== skip && f.value !== null) z += f.weight * clamp(f.value, -1, 1) * clamp(f.confidence, 0, 1);
  });
  return clamp(sigmoid(z) * 100, MIN_PCT, MAX_PCT);
}

/** Общая оценка: процент, уверенность (доля важности известных факторов) и вклад каждого фактора */
export function estimate(base: number, inputs: readonly FactorInput[], minConfidence: number): PercentEstimate {
  const value = pctOf(base, inputs, -1);
  const total = inputs.reduce((s, f) => s + f.importance, 0);
  const knownW = inputs.reduce((s, f) => s + (f.value === null ? 0 : f.importance * clamp(f.confidence, 0, 1)), 0);
  const confidence = total > 0 ? knownW / total : 0;
  const factors: PercentFactor[] = inputs.map((f, i) => ({
    id: f.id,
    label: f.label,
    known: f.value !== null,
    effect: f.value === null ? 0 : Math.round((value - pctOf(base, inputs, i)) * 10) / 10,
  }));
  return { value: Math.round(value), confidence: Math.round(confidence * 100) / 100, factors, showable: confidence >= minConfidence };
}

/** Факторы, отсортированные по силе: для подробного текста «почему» */
export function topFactors(e: PercentEstimate, n = 3): PercentFactor[] {
  return e.factors.filter((f) => f.known && Math.abs(f.effect) >= 1).sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect)).slice(0, n);
}

export function factorsText(e: PercentEstimate, n = 3): string {
  const t = topFactors(e, n).map((f) => `${f.label} ${f.effect > 0 ? '+' : ''}${Math.round(f.effect)}%`);
  const unknown = e.factors.filter((f) => !f.known).map((f) => f.label.toLowerCase());
  return [t.join(', '), unknown.length ? `неизвестно: ${unknown.join(', ')}` : ''].filter(Boolean).join('; ');
}

const fresh = (p: ViewPlayer) => p.pos.value !== null && p.pos.ageSec !== null && p.pos.ageSec <= 2;

/** Враги рядом со мной (видны на мини-карте ближе NEAR_UNITS) */
export function nearEnemies(v: CoachView): ViewPlayer[] {
  return v.enemies.filter((e) => enemyNear(e, v.me.pos.value));
}

function minimapReadable(v: CoachView): boolean {
  return v.enemies.length > 0 && v.enemies.some((e) => e.missing !== null || fresh(e));
}

/** Общие факторы моего героя */
function heroFactors(v: CoachView): FactorInput[] {
  const hp = poolPct(v.me.hp.value);
  const mana = poolPct(v.me.mana.value);
  const ult = ultReady(v);
  const lvl = v.me.level.value;
  const ownedKey = v.me.items.filter((i) => KEY_ITEMS.includes(i.key) && !i.slot.startsWith('stash') && !i.slot.startsWith('bp'));
  const readyKey = readyItems(v, KEY_ITEMS);
  return [
    { id: 'hp', label: 'Здоровье', value: hp === null ? null : (hp - 50) / 50, weight: 1.2, confidence: v.me.hp.confidence, importance: 3 },
    { id: 'mana', label: 'Мана', value: mana === null || v.me.mana.value?.max === 0 ? null : clamp((mana - 40) / 60, -1, 1), weight: 0.4, confidence: v.me.mana.confidence, importance: 1 },
    {
      id: 'ult',
      label: 'Ульта',
      value: ult === null ? (lvl !== null && lvl < 6 ? -0.3 : null) : ult ? 1 : -1,
      weight: 0.7,
      confidence: 0.9,
      importance: 2,
    },
    {
      id: 'items',
      label: 'Ключевые предметы',
      value: !v.me.itemsKnown ? null : ownedKey.length === 0 ? 0 : readyKey.length > 0 ? 1 : -0.5,
      weight: 0.5,
      confidence: 0.9,
      importance: 1,
    },
  ];
}

/** «Вступать в драку сейчас?» — шанс выиграть драку рядом */
export function engagePercent(v: CoachView, mem: CoachMemory, lookup: CoachLookup, minConfidence: number): PercentEstimate {
  const me = v.me.pos.value;
  const near = nearEnemies(v);
  const readable = minimapReadable(v) && me !== null;
  const alliesNear = me ? v.allies.filter((a) => a.alive.value !== false && fresh(a) && dist(a.pos.value!, me) <= NEAR_UNITS).length : 0;
  const missing = v.enemies.filter((e) => e.missing === true).length;
  const bars = near.filter((e) => e.barLevel !== null || e.hpPercent.value !== null);
  const lvl = v.me.level.value;
  const lvlDiffs = near.filter((e) => e.barLevel !== null && lvl !== null).map((e) => lvl! - e.barLevel!);
  const enemyHp = near.map((e) => e.hpPercent.value).filter((x): x is number => x !== null);
  const myKey = v.me.hero.value?.key ?? null;
  const mu = myKey ? near.map((e) => (e.hero.value ? lookup.matchup(myKey, e.hero.value) : null)).filter((m): m is NonNullable<typeof m> => m !== null && m.games >= 200) : [];
  const clock = v.clock.value;
  const bbCost = v.me.buybackCost.value;
  const bbReady = bbCost !== null && v.me.buybackCooldown.value !== null && v.me.gold.value !== null ? v.me.buybackCooldown.value === 0 && v.me.gold.value >= bbCost : null;
  // Срок аегиса — по режиму (Турбо — 4 мин); не проверен — аегис в оценке не учитываем
  const aegisSec = lookup.aegisSec() ?? 0;
  const aegisOurs = mem.aegisOurs === true && mem.aegisAt !== null && clock !== null && clock - mem.aegisAt < aegisSec;
  const side = me && v.team ? mapSide(me, v.team) : null;

  const inputs: FactorInput[] = [
    ...heroFactors(v),
    {
      id: 'numbers',
      label: 'Союзники и враги рядом',
      // Перевес в числе решает сильнее всего: 1×5 почти всегда проигрыш
      value: readable ? Math.tanh((alliesNear + 1 - near.length) / 1.5) : null,
      weight: 3,
      confidence: 0.8,
      importance: 3,
    },
    { id: 'missing', label: 'Враги не на карте', value: readable ? -missing / 5 : null, weight: 0.8, confidence: 0.75, importance: 2 },
    { id: 'level', label: 'Разница уровней', value: lvlDiffs.length ? clamp(lvlDiffs.reduce((a, b) => a + b, 0) / lvlDiffs.length / 4, -1, 1) : null, weight: 0.8, confidence: 0.7, importance: 2 },
    { id: 'enemy-hp', label: 'Здоровье врагов', value: enemyHp.length ? (50 - enemyHp.reduce((a, b) => a + b, 0) / enemyHp.length) / 50 : null, weight: 0.9, confidence: 0.7, importance: bars.length ? 2 : 2 },
    { id: 'position', label: 'Сторона карты', value: side === null ? null : side === 'own' ? 0.5 : side === 'enemy' ? -0.5 : 0, weight: 0.6, confidence: 0.7, importance: 1 },
    { id: 'buyback', label: 'Выкуп', value: clock === null || clock < 25 * 60 ? (bbReady === null ? null : 0) : bbReady === null ? null : bbReady ? 0.5 : -0.3, weight: 0.4, confidence: 1, importance: 0.5 },
    { id: 'aegis', label: 'Аегис', value: v.events === null ? null : aegisOurs ? 1 : 0, weight: 0.8, confidence: 1, importance: 0.5 },
    {
      id: 'matchup',
      label: 'Матчап (статистика патча)',
      value: mu.length ? clamp((mu.reduce((s, m) => s + (m.winrate - 0.5), 0) / mu.length) * 10, -1, 1) : near.length === 0 ? 0 : null,
      weight: 0.5,
      confidence: 0.8,
      importance: 1,
    },
    // Ценность героев врагов (предметы) с экрана не видна — честно неизвестно
    { id: 'networth', label: 'Ценность героев', value: null, weight: 0.8, confidence: 0, importance: 2 },
  ];
  return estimate(0.5, inputs, minConfidence);
}

/** 1×1 против конкретного врага прямо сейчас */
export function matchupPercent(v: CoachView, enemy: ViewPlayer, lookup: CoachLookup, minConfidence: number): PercentEstimate {
  const myKey = v.me.hero.value?.key ?? null;
  const mu = myKey && enemy.hero.value ? lookup.matchup(myKey, enemy.hero.value) : null;
  const myHp = poolPct(v.me.hp.value);
  const lvl = v.me.level.value;
  const inputs: FactorInput[] = [
    { id: 'matchup', label: 'Матчап (статистика патча)', value: mu && mu.games >= 200 ? clamp((mu.winrate - 0.5) * 10, -1, 1) : null, weight: 1, confidence: mu ? Math.min(1, mu.games / 2000) : 0, importance: 2 },
    { id: 'hp', label: 'Здоровье: вы против врага', value: myHp !== null && enemy.hpPercent.value !== null ? clamp((myHp - enemy.hpPercent.value) / 50, -1, 1) : null, weight: 1.3, confidence: Math.min(v.me.hp.confidence, enemy.hpPercent.confidence), importance: 3 },
    { id: 'level', label: 'Разница уровней', value: lvl !== null && enemy.barLevel !== null ? clamp((lvl - enemy.barLevel) / 4, -1, 1) : null, weight: 1, confidence: 0.7, importance: 2 },
    ...heroFactors(v).filter((f) => f.id !== 'hp'),
    { id: 'enemy-items', label: 'Предметы и ульта врага', value: null, weight: 0.8, confidence: 0, importance: 2 },
  ];
  return estimate(0.5, inputs, minConfidence);
}

export type Action = 'fight' | 'farm' | 'push' | 'retreat';
export const ACTION_RU: Record<Action, string> = { fight: 'Драться', farm: 'Фармить', push: 'Пушить', retreat: 'Отходить' };

export interface ActionChoice {
  best: Action;
  percents: Record<Action, number>;
  confidence: number;
  showable: boolean;
  /** Причины в пользу лучшего действия */
  reasons: string[];
}

/** Драка / фарм / пуш / отход: доли по сумме сигналов (softmax) */
export function actionChoice(v: CoachView, mem: CoachMemory, lookup: CoachLookup, minConfidence: number): ActionChoice {
  const hp = poolPct(v.me.hp.value);
  const missing = v.enemies.filter((e) => e.missing === true).length;
  const enemiesDead = v.enemies.filter((e) => e.alive.value === false).length;
  const alliesDead = v.allies.filter((e) => e.alive.value === false).length;
  const near = nearEnemies(v).length;
  const side = v.me.pos.value && v.team ? mapSide(v.me.pos.value, v.team) : null;
  const engage = near > 0 ? engagePercent(v, mem, lookup, minConfidence) : null;
  const clock = v.clock.value ?? 0;
  const regen = hasRegen(v);
  const tp = tpReady(v);
  const why: { a: Action; text: string }[] = [];
  const s: Record<Action, number> = { fight: -0.5, farm: 0.6, push: -0.3, retreat: -0.6 };

  if (hp !== null && hp < 35) {
    s.retreat += 2 * (1 - hp / 35);
    s.fight -= 1;
    why.push({ a: 'retreat', text: `мало здоровья (${Math.round(hp)}%)` });
  }
  if (hp !== null && hp < 50 && regen === false && tp === false) s.retreat += 0.6;
  if (missing >= 3 && side === 'enemy') {
    s.retreat += 1.2;
    s.push -= 0.8;
    why.push({ a: 'retreat', text: `${missing} врагов не видно, вы на их стороне` });
  }
  if (engage && engage.showable) {
    const e = (engage.value - 50) / 25;
    s.fight += e;
    s.retreat -= e * 0.6;
    why.push({ a: engage.value >= 50 ? 'fight' : 'retreat', text: `шанс в драке ${engage.value}%` });
  } else if (near > 0) s.fight += 0.2;
  if (enemiesDead >= 2 && clock > 8 * 60) {
    s.push += 0.8 * enemiesDead;
    why.push({ a: 'push', text: `${enemiesDead} врага мертвы` });
  }
  if (alliesDead >= 2) {
    s.push -= 0.6 * alliesDead;
    s.farm += 0.3;
    why.push({ a: 'farm', text: `${alliesDead} союзника мертвы` });
  }
  if (clock < 10 * 60) {
    s.farm += 0.4;
    why.push({ a: 'farm', text: 'ранняя игра' });
  }
  if (missing <= 1 && near === 0) why.push({ a: 'farm', text: 'врагов рядом нет' });
  const exps = Object.values(s).map((x) => Math.exp(x));
  const sum = exps.reduce((a, b) => a + b, 0);
  const percents = Object.fromEntries((Object.keys(s) as Action[]).map((k, i) => [k, Math.round((exps[i]! / sum) * 100)])) as Record<Action, number>;
  const best = (Object.keys(percents) as Action[]).reduce((a, b) => (percents[b] > percents[a] ? b : a));
  // Уверенность: HP героя, читается ли мини-карта и верхняя панель
  const parts = [v.me.hp.value ? v.me.hp.confidence : 0, minimapReadable(v) ? 0.8 : 0, v.enemies.some((e) => e.alive.value !== null) ? 0.9 : 0];
  const confidence = Math.round((parts.reduce((a, b) => a + b, 0) / parts.length) * 100) / 100;
  return { best, percents, confidence, showable: confidence >= minConfidence, reasons: why.filter((x) => x.a === best).map((x) => x.text) };
}
