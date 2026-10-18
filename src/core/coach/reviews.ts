// G. Разборы: после смерти (пока герой мёртв) и в конце матча. Шаблон строится из фактов всегда;
// ИИ, если успевает, пишет короткий текст поверх (числа проверяются). Чистое ядро.
import { MAP_ZONE_RU } from '../match-state/map-zones.ts';
import { goalFor, MISTAKE_RU, type Mistake, type MistakeType } from './mistakes.ts';
import { readyActiveNames, type CoachMemory, type DeathRecord } from './memory.ts';
import type { CoachLookup } from './data.ts';
import type { CoachView } from './view.ts';
import { game, mmss } from './rules/context.ts';
import type { GameStage } from './game-context.ts';
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

/** Причина смерти: текст и что делать в следующий раз */
interface DeathCause {
  id: 'outnumbered' | 'position' | 'unused' | 'escape' | 'power' | 'regen';
  why: string;
  tip: string;
}

/**
 * Причины смерти по порядку важности (этап 4 «понимания игры»). Каждая проверка — только по тому, что коуч знал в
 * момент смерти; не знает — причины нет (лучше «не уверен», чем выдумка):
 *  1. меньшинство — врагов рядом больше, чем вас с союзниками;
 *  2. позиция — на стороне врага без союзников или без обзора (враги пропали), ночью;
 *  3. готовое и не нажатое, что могло спасти (Black King Bar, Blade Mail, спасительные способности);
 *  4. мог уйти — Town Portal Scroll был готов, а здоровье падало дольше, чем идёт телепорт;
 *  5. разница в силе — враги рядом выше уровнем;
 *  расходники (Tango, Healing Salve) — только в лайнинге и только если здоровье падало медленно.
 * В лейте сначала позиция и обзор: там решает, где вас поймали, а не «нажал ли кнопку».
 */
export function deathCauses(d: DeathRecord, stage: GameStage, look: Pick<CoachLookup, 'itemName' | 'abilityByKey'>): DeathCause[] {
  const out: DeathCause[] = [];
  const allies = d.alliesNear;
  const enemies = d.enemiesNear;
  const drop = d.dropSec;
  // 1. меньшинство (вы + союзники против врагов рядом)
  if (enemies >= 2 && enemies > allies + 1) {
    out.push({
      id: 'outnumbered',
      why: `Вы были в меньшинстве: ${enemies} ${enemies >= 5 ? 'врагов' : 'врага'} против ${allies === 0 ? 'вас одного' : `вас и ${allies} ${allies === 1 ? 'союзника' : 'союзников'}`}`,
      tip: 'Отходите заранее, когда врагов рядом больше, чем вас: смотрите на мини-карту перед тем, как зайти.',
    });
  }
  // 2. позиция: чужая сторона без союзников, или враги пропали, или ночь в одиночку
  if (d.side === 'enemy' && (allies === 0 || d.enemiesMissing >= 2)) {
    const where = d.zone ? MAP_ZONE_RU[d.zone] : 'сторона врага';
    const parts = [allies === 0 ? 'без союзников' : '', d.enemiesMissing >= 2 ? `${d.enemiesMissing} врагов не было видно` : '', d.night ? 'ночью' : ''].filter(Boolean);
    out.push({
      id: 'position',
      why: `Позиция: вы были на стороне врага (${where}) — ${parts.join(', ')}`,
      tip: stage === 'late' ? 'В лейте без обзора не заходите на половину врага: сначала варды, потом фарм рядом с командой.' : 'Без обзора держитесь своей половины карты, пока не знаете, где враги.',
    });
  }
  // 3. готовое и не нажатое
  const unused = readyActiveNames(look, d);
  if (unused.length) {
    out.push({
      id: 'unused',
      why: unused.length === 1 ? `${unused[0]} был готов, но не нажат` : `Были готовы, но не нажаты: ${unused.join(', ')}`,
      tip: 'Нажимайте спасительные предметы и способности в начале драки, а не когда здоровья почти не осталось.',
    });
  }
  // 4. мог уйти: телепорт готов, а здоровье падало дольше телепорта (3 с) с запасом
  if (d.tpReady === true && drop !== null && drop >= 5) {
    out.push({
      id: 'escape',
      why: `Можно было уйти: Town Portal Scroll был готов, а здоровье падало ${Math.round(drop)} с`,
      tip: 'Когда здоровье падает и врагов больше — телепортируйтесь сразу, пока не поймали в контроль.',
    });
  }
  // 5. разница в силе: средний уровень врагов рядом выше на 2+
  const lv = d.enemyLevels ?? [];
  if (d.myLevel != null && lv.length) {
    const avg = lv.reduce((a, b) => a + b, 0) / lv.length;
    if (avg - d.myLevel >= 2) {
      out.push({
        id: 'power',
        why: `Враги были сильнее: уровень ${Math.round(avg)} против вашего ${d.myLevel}`,
        tip: 'Пока враги выше уровнем, не деритесь с ними — фармите безопасно и ждите своих предметов.',
      });
    }
  }
  // Расходники: только лайнинг, только если были и здоровье падало медленно (было время съесть или выпить)
  const regen = d.regenItems ?? [];
  if (stage === 'laning' && regen.length && drop !== null && drop >= 8) {
    out.push({
      id: 'regen',
      why: `В инвентаре был ${regen.map((k) => look.itemName(k)).join(' и ')}, а здоровье падало ${Math.round(drop)} с — можно было подлечиться`,
      tip: 'На линии лечитесь заранее, не дожидаясь, пока здоровья станет мало.',
    });
  }
  // В лейте сначала позиция: там решает, где вас поймали
  if (stage === 'late') out.sort((a, b) => Number(b.id === 'position') - Number(a.id === 'position'));
  return out;
}

export function deathReview(c: RuleContext, d: DeathRecord, index: number, mistakes: readonly Mistake[]): DeathReview {
  const stage = game(c).stage;
  const causes = deathCauses(d, stage, c.look);
  // Одна главная причина и не больше одной дополнительной; нет ни одной — честно «не уверен»
  const why = causes.slice(0, 2).map((x) => x.why);
  if (!why.length) {
    why.push(
      d.enemiesNear === 0
        ? 'Коуч не уверен в причине: не было видно, кто и сколько врагов было рядом'
        : d.hpBefore !== null && d.dropSec !== null && d.dropSec <= 2 && d.hpBefore >= 70
          ? `Коуч не уверен в причине: здоровье упало с ${Math.round(d.hpBefore)}% за ${Math.max(1, Math.round(d.dropSec))} с — вероятно, вас поймали из тумана`
          : 'Коуч не уверен в причине: ни меньшинства, ни плохой позиции, ни неиспользованных предметов не видно',
    );
  }
  const own = mistakes.filter((m) => m.deathIndex === index);
  const tips = causes.length ? [causes[0]!.tip] : ['Держитесь ближе к своим башням, пока не знаете, где враги.'];

  const respawn = d.respawnSec;
  let buyback: DeathReview['buyback'];
  if (d.buybackCost === null || d.gold === null) buyback = { advice: 'unknown', text: 'Данных о выкупе нет.' };
  else if (d.gold < d.buybackCost) buyback = { advice: 'cannot', text: `Выкуп стоит ${d.buybackCost}, у вас ${d.gold} — не хватает ${d.buybackCost - d.gold}.` };
  else if (d.buybackReady === false) buyback = { advice: 'cannot', text: 'Выкуп на перезарядке.' };
  else if (respawn !== null && respawn <= 20) buyback = { advice: 'save', text: `Не выкупайтесь: возрождение через ${respawn} с.` };
  else {
    // Выкуп по стадии и ситуации (ночная задача, этап 3) — одинаково для обычной игры и Турбо:
    // бьют базу (башни 3–4-го уровня, казармы, трон) — выкупаться; лейт и долгое возрождение — по ситуации в драке;
    // иначе — сохранить золото. Стадия — по времени с поправкой на Турбо, уровню и потерянным зданиям
    const attackedAt = c.mem.marks.get('bld-base-attack@');
    const baseUnderAttack = attackedAt !== undefined && c.now - attackedAt <= 20_000;
    const wait = respawn !== null ? `возрождение через ${respawn} с` : 'возрождение не скоро';
    const price = `${d.buybackCost}, у вас ${d.gold}`;
    if (baseUnderAttack) buyback = { advice: 'buy', text: `Выкупайтесь (${price}): бьют вашу базу, а ${wait}.` };
    else if (stage === 'late' && (respawn === null || respawn >= 40)) buyback = { advice: 'unknown', text: `Выкуп ${price}: выкупайтесь, если команда сейчас дерётся или защищает базу; иначе сохраните — в лейте выкуп спасает от проигрыша.` };
    else buyback = { advice: 'save', text: `Сохраните выкуп (${price}): база цела, ${wait}.` };
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
  // Нормы (добивания профи, медианы GPM/XPM, минуты предметов) — из обычных матчей: в Турбо без ориентира и оценки
  const norms = look.hasNorms;
  const noNorm = 'норм для Турбо нет';
  const lhRef = norms && role && role !== 4 ? (st?.pro?.lhAt10[String(role)]?.median ?? null) : null;
  const gpmRef = norms ? (st?.bench?.gpm?.p50 ?? null) : null;
  const xpmRef = norms ? (st?.bench?.xpm?.p50 ?? null) : null;
  const deaths = v.me.deaths.value ?? mem.deaths.length;
  const stats: StatLine[] = [
    { label: 'Добивания к 10:00', value: at10, ref: lhRef, refLabel: norms ? 'профи патча' : noNorm, verdict: verdict(at10, lhRef === null ? null : lhRef * 0.7) },
    { label: 'GPM', value: v.me.gpm.value, ref: gpmRef, refLabel: norms ? 'медиана патча' : noNorm, verdict: verdict(v.me.gpm.value, gpmRef) },
    { label: 'XPM', value: v.me.xpm.value, ref: xpmRef, refLabel: norms ? 'медиана патча' : noNorm, verdict: verdict(v.me.xpm.value, xpmRef) },
    { label: 'Смерти', value: deaths, ref: null, refLabel: null, verdict: deaths <= 4 ? 'good' : deaths <= 8 ? 'ok' : 'bad' },
  ];
  const build = hero && norms ? look.buildFor(hero.id, hero.key).filter((b) => b.source === 'pro' && b.share >= 0.4 && (look.itemCost(b.key) ?? 0) >= 1500).slice(0, 3) : [];
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
    // Турбо — чтобы ИИ не сравнивал с обычной игрой (норм для Турбо нет)
    look.isTurbo ? 'Режим игры: Турбо — норм для сравнения GPM, XPM и добиваний нет' : '',
    result ? `Результат: ${result === 'win' ? 'победа' : 'поражение'}` : '',
    hero ? `Герой: ${hero.name}` : '',
    clock !== null ? `Длительность: ${mmss(clock)}` : '',
    ...stats.map((s) => `${s.label}: ${s.value ?? 'нет данных'}${s.ref !== null ? ` (ориентир ${s.ref}, ${s.refLabel})` : ''}`),
    ...topMistakes.map((m) => `Ошибка ${m.clock !== null ? mmss(m.clock) : ''}: ${m.text}`),
    ...good.map((g) => `Хорошо: ${g}`),
  ].filter(Boolean);

  return { kind: 'match', result, heroName: hero?.name ?? null, durationSec: clock, why, topMistakes, goodPlays: good.slice(0, 3), stats, timeline, goals: goals.slice(0, 3), facts, aiText: null };
}
