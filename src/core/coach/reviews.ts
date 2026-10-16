// G. Разборы: после смерти (пока герой мёртв) и в конце матча. Шаблон строится из фактов всегда;
// ИИ, если успевает, пишет короткий текст поверх (числа проверяются). Чистое ядро.
import { MAP_ZONE_RU } from '../match-state/map-zones.ts';
import { goalFor, MISTAKE_RU, type Mistake, type MistakeType } from './mistakes.ts';
import type { CoachMemory, DeathRecord } from './memory.ts';
import type { CoachLookup } from './data.ts';
import type { CoachView } from './view.ts';
import { mmss } from './rules/context.ts';
import { laneRole } from './rules/laning.ts';
import type { RuleContext } from './rules/context.ts';

export interface DeathReview {
  kind: 'death';
  index: number;
  clock: number | null;
  respawnSec: number | null;
  why: string[];
  mistakes: Mistake[];
  /** 1–3 совета */
  tips: string[];
  buyback: { advice: 'buy' | 'save' | 'cannot' | 'unknown'; text: string };
  /** Строки фактов для ИИ */
  facts: string[];
  aiText: string | null;
}

export interface StatLine {
  label: string;
  value: number | null;
  ref: number | null;
  refLabel: string | null;
  verdict: 'good' | 'ok' | 'bad' | null;
}

export interface MatchReview {
  kind: 'match';
  result: 'win' | 'loss' | null;
  heroName: string | null;
  durationSec: number | null;
  why: string[];
  topMistakes: Mistake[];
  goodPlays: string[];
  stats: StatLine[];
  timeline: { clock: number; text: string }[];
  goals: string[];
  facts: string[];
  aiText: string | null;
}

export function deathReview(c: RuleContext, d: DeathRecord, index: number, mistakes: readonly Mistake[]): DeathReview {
  const why: string[] = [];
  if (d.enemiesNear >= 2) why.push(`Вас поймали ${d.enemiesNear} врага`);
  else if (d.enemiesNear === 1) why.push('Вас убил один враг');
  if (d.hpBefore !== null && d.dropSec !== null && d.dropSec <= 3 && d.hpBefore >= 50) why.push(`Здоровье упало с ${Math.round(d.hpBefore)}% за ${Math.max(1, Math.round(d.dropSec))} с — сильный урон разом`);
  if (d.side === 'enemy') why.push(`Смерть на стороне врага (${d.zone ? MAP_ZONE_RU[d.zone] : 'место неизвестно'})`);
  if (d.enemiesMissing >= 2) why.push(`${d.enemiesMissing} врагов не было видно на мини-карте`);
  if (d.night) why.push('Была ночь — обзор меньше');
  if (!why.length) why.push('Точную причину по данным коуча не определить');

  const own = mistakes.filter((m) => m.deathIndex === index);
  const tips = [...new Set(own.sort((a, b) => b.severity - a.severity).map((m) => m.instead))].slice(0, 3);
  if (!tips.length) tips.push(d.enemiesNear >= 2 ? 'Следите за мини-картой: отходите, когда врагов рядом больше, чем союзников.' : 'Держитесь ближе к своим башням, пока не знаете, где враги.');

  const respawn = d.respawnSec;
  let buyback: DeathReview['buyback'];
  if (d.buybackCost === null || d.gold === null) buyback = { advice: 'unknown', text: 'Данных о выкупе нет.' };
  else if (d.gold < d.buybackCost) buyback = { advice: 'cannot', text: `На выкуп не хватает ${d.buybackCost - d.gold} золота.` };
  else if (d.buybackReady === false) buyback = { advice: 'cannot', text: 'Выкуп на перезарядке.' };
  else if (respawn !== null && respawn <= 20) buyback = { advice: 'save', text: `Не выкупайтесь: возрождение через ${respawn} с.` };
  else {
    const clock = c.v.clock.value ?? 0;
    const attackedAt = c.mem.marks.get('bld-attack@');
    const baseUnderAttack = attackedAt !== undefined && c.now - attackedAt <= 20_000;
    if (clock >= 30 * 60 && baseUnderAttack) buyback = { advice: 'buy', text: `Выкупитесь (${d.buybackCost}): бьют ваши здания.` };
    else buyback = { advice: 'save', text: `Сохраните ${d.buybackCost} золота: выкуп сейчас не решает.` };
  }

  const facts = [
    d.clock !== null ? `Смерть в ${mmss(d.clock)}` : '',
    `Врагов рядом при смерти: ${d.enemiesNear}`,
    `Союзников рядом: ${d.alliesNear}`,
    d.hpBefore !== null ? `Здоровье за 10 с до смерти: ${Math.round(d.hpBefore)}%` : '',
    d.dropSec !== null ? `Здоровье упало за ${Math.round(d.dropSec)} с` : '',
    `Врагов не было видно: ${d.enemiesMissing}`,
    d.zone ? `Место: ${MAP_ZONE_RU[d.zone]}` : '',
    respawn !== null ? `Возрождение через ${respawn} с` : '',
    ...own.map((m) => `Ошибка: ${m.text}`),
    `Выкуп: ${buyback.text}`,
  ].filter(Boolean);
  return { kind: 'death', index, clock: d.clock, respawnSec: respawn, why, mistakes: own, tips, buyback, facts, aiText: null };
}

const verdict = (v: number | null, ref: number | null, higherIsBetter = true): StatLine['verdict'] => {
  if (v === null || ref === null || ref === 0) return null;
  const r = higherIsBetter ? v / ref : ref / Math.max(v, 0.5);
  return r >= 1 ? 'good' : r >= 0.8 ? 'ok' : 'bad';
};

export function matchReview(v: CoachView, mem: CoachMemory, look: CoachLookup, mistakes: readonly Mistake[], c: RuleContext): MatchReview {
  const hero = v.me.hero.value;
  const st = look.statsFor(hero?.id, hero?.key);
  const result = v.winTeam && v.team ? (v.winTeam === v.team ? 'win' : 'loss') : null;
  const clock = mem.lastClock;
  // Добивания к 10:00 — из истории (ближайшая запись к 600 с)
  const at10 = mem.samples.filter((s) => s.clock !== null && s.clock >= 595 && s.clock <= 640 && s.lastHits !== null)[0]?.lastHits ?? null;
  const role = laneRole(c);
  const lhRef = role && role !== 4 ? (st?.pro?.lhAt10[String(role)]?.median ?? null) : null;
  const deaths = v.me.deaths.value ?? mem.deaths.length;
  const stats: StatLine[] = [
    { label: 'Добивания к 10:00', value: at10, ref: lhRef, refLabel: 'профи патча', verdict: verdict(at10, lhRef === null ? null : lhRef * 0.7) },
    { label: 'GPM', value: v.me.gpm.value, ref: st?.bench?.gpm?.p50 ?? null, refLabel: 'медиана патча', verdict: verdict(v.me.gpm.value, st?.bench?.gpm?.p50 ?? null) },
    { label: 'XPM', value: v.me.xpm.value, ref: st?.bench?.xpm?.p50 ?? null, refLabel: 'медиана патча', verdict: verdict(v.me.xpm.value, st?.bench?.xpm?.p50 ?? null) },
    { label: 'Смерти', value: deaths, ref: null, refLabel: null, verdict: deaths <= 4 ? 'good' : deaths <= 8 ? 'ok' : 'bad' },
  ];
  const build = hero ? look.buildFor(hero.id, hero.key).filter((b) => b.share >= 0.4 && (look.itemCost(b.key) ?? 0) >= 1500).slice(0, 3) : [];
  for (const b of build) {
    const t = mem.items.get(b.key);
    stats.push({ label: `${look.itemName(b.key)}, мин`, value: t === undefined ? null : Math.round(t / 6) / 10, ref: b.medianMin, refLabel: 'профи патча', verdict: t === undefined ? 'bad' : verdict(t / 60, b.medianMin, false) });
  }

  const sorted = [...mistakes].sort((a, b) => b.severity - a.severity || (a.clock ?? 0) - (b.clock ?? 0));
  const byType = new Map<MistakeType, Mistake>();
  for (const m of sorted) if (!byType.has(m.type)) byType.set(m.type, m);
  const topMistakes = [...byType.values()].slice(0, 3);

  const good: string[] = [];
  const k = v.me.kills.value ?? mem.kills.length;
  const a = v.me.assists.value ?? mem.assists.length;
  if (k + a >= 2 * Math.max(1, deaths)) good.push(`Участие в убийствах: ${k + a} при ${deaths} смертях`);
  for (const s of stats) if (s.verdict === 'good' && s.value !== null && s.label !== 'Смерти') good.push(`${s.label}: ${s.value}${s.ref !== null ? ` (ориентир ${s.ref})` : ''}`);
  const deathClocks = mem.deaths.map((d) => d.clock).filter((x): x is number => x !== null);
  const gaps = [0, ...deathClocks, clock ?? 0].map((t, i, arr) => (i ? t - arr[i - 1]! : 0));
  const longest = Math.max(...gaps);
  if (longest >= 12 * 60) good.push(`${Math.floor(longest / 60)} минут без смертей подряд`);

  const why: string[] = [];
  if (result) why.push(result === 'win' ? 'Победа' : 'Поражение');
  if (deaths >= 8) why.push(`Много смертей: ${deaths}`);
  const gpmLine = stats[1]!;
  if (gpmLine.verdict === 'bad') why.push(`Золота меньше обычного: GPM ${gpmLine.value} против ${gpmLine.ref}`);
  if (topMistakes[0]) why.push(`Главная ошибка: ${MISTAKE_RU[topMistakes[0].type].toLowerCase()}`);

  const timeline = [
    ...mem.deaths.filter((d) => d.clock !== null).map((d) => ({ clock: d.clock!, text: 'Смерть' })),
    ...mem.kills.map((t) => ({ clock: t, text: 'Убийство' })),
    ...build.filter((b) => mem.items.has(b.key)).map((b) => ({ clock: mem.items.get(b.key)!, text: `Куплен ${look.itemName(b.key)}` })),
    ...(mem.roshanKilledAt !== null ? [{ clock: mem.roshanKilledAt, text: 'Рошан убит' }] : []),
  ].sort((x, y) => x.clock - y.clock);

  const goals = topMistakes.map((m) => goalFor(m.type));
  if (!goals.length) goals.push('Повторить: следить за мини-картой и тратить золото вовремя');

  const facts = [
    result ? `Результат: ${result === 'win' ? 'победа' : 'поражение'}` : '',
    hero ? `Герой: ${hero.name}` : '',
    clock !== null ? `Длительность: ${mmss(clock)}` : '',
    ...stats.map((s) => `${s.label}: ${s.value ?? 'нет данных'}${s.ref !== null ? ` (ориентир ${s.ref}, ${s.refLabel})` : ''}`),
    ...topMistakes.map((m) => `Ошибка ${m.clock !== null ? mmss(m.clock) : ''}: ${m.text}`),
    ...good.map((g) => `Хорошо: ${g}`),
  ].filter(Boolean);

  return { kind: 'match', result, heroName: hero?.name ?? null, durationSec: clock, why, topMistakes, goodPlays: good.slice(0, 3), stats, timeline, goals: goals.slice(0, 3), facts, aiText: null };
}
