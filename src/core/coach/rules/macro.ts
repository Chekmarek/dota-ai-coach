// E. Макро и цели: окно для пуша (враги мертвы), сбор команды, помощь в драке союзников, Рошан, тайминги карты.
import { personalNote } from '../profile.ts';
import { upcomingEvents } from '../../knowledge-base/timers.ts';
import { MAP_ZONE_RU, mapZone } from '../../match-state/map-zones.ts';
import { nearEnemyCount, tpReady } from '../memory.ts';
import { NEAR_UNITS, dist, mapSide } from '../geo.ts';
import { derivedFact, fact, kbFact } from '../view.ts';
import { draft, game, mmss, playing, plural, type Rule } from './context.ts';
import { MAP_POINTS, RUN_SPEED, type GameContext } from '../game-context.ts';
import type { HintDraft } from '../types.ts';
import outpostsJson from '../../../data/outposts.json';

const freshPos = (p: { pos: { value: unknown; ageSec: number | null } }) => p.pos.value !== null && (p.pos.ageSec ?? 99) <= 3;

export const pushWindowRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!playing(c) || clock === null || clock < 8 * 60) return null;
  const dead = c.v.enemies.filter((e) => e.alive.value === false);
  if (dead.length < 2) return null;
  const left = dead.map((e) => (e.respawnAt.value === null ? null : e.respawnAt.value - clock)).filter((x): x is number => x !== null && x > 0);
  const minLeft = left.length ? Math.min(...left) : null;
  if (minLeft !== null && minLeft < 20) return null;
  const n = dead.length;
  const big = n >= 3 && clock >= 20 * 60;
  const roshan = c.mem.roshanKilledAt === null || clock - c.mem.roshanKilledAt >= (c.look.mechanicValue('roshan-respawn', 'max') ?? Infinity);
  return draft({
    id: 'macro.push',
    category: 'macro',
    priority: 'advice',
    confidence: 0.85,
    short: `${n} ${plural(n, 'враг мёртв', 'врага мертвы', 'врагов мертвы')}${minLeft !== null ? ` ${Math.round(minLeft)} с` : ''} — давите`,
    normal: big ? `${n} врагов мертвы: время ломать базу${roshan ? ' или брать Рошана' : ''}.` : `${n} врага мертвы: пушьте ближайшую башню вместе с командой.`,
    facts: [
      { key: 'enemies-dead', label: 'Врагов мертво (верхняя панель)', value: n, source: 'screen', ageSec: 0, confidence: 0.9, verified: true },
      derivedFact('respawn-min', 'Ближайшее возрождение через, с', minLeft === null ? null : Math.round(minLeft), 0.8),
    ],
    ttlSec: 10,
    cooldownSec: 40,
  });
};

export const groupRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const me = c.v.me.pos.value;
  if (!playing(c) || clock === null || clock < 20 * 60 || !me || c.mem.inFight) return null;
  const allies = c.v.allies.filter((a) => a.alive.value !== false && freshPos(a));
  for (const a of allies) {
    const group = allies.filter((b) => dist(a.pos.value!, b.pos.value!) <= NEAR_UNITS);
    if (group.length < 3) continue;
    const cx = group.reduce((s, b) => s + b.pos.value!.x, 0) / group.length;
    const cy = group.reduce((s, b) => s + b.pos.value!.y, 0) / group.length;
    if (dist(me, { x: cx, y: cy }) < 5000) return null;
    const zone = MAP_ZONE_RU[mapZone(cx, cy)];
    return draft({
      id: 'macro.group',
      category: 'macro',
      priority: 'info',
      confidence: 0.7,
      short: `Команда вместе: ${zone} — к ним`,
      normal: `${group.length} союзника собрались (${zone}). Поздняя игра — держитесь вместе.`,
      facts: [derivedFact('group', 'Союзников вместе', group.length, 0.7), derivedFact('where', 'Где', zone, 0.6)],
      ttlSec: 10,
      cooldownSec: 90,
    });
  }
  return null;
};

export const helpRule: Rule = (c) => {
  const me = c.v.me.pos.value;
  if (!playing(c) || !me || c.mem.inFight) return null;
  // В лайнинге каждый стоит на своей линии: «телепорт на верхнюю линию» в 0:30 керри только вредил (13 раз до 3:00)
  if (game(c).stage === 'laning') return null;
  const enemies = c.v.enemies.filter((e) => e.alive.value !== false && freshPos(e));
  for (const a of c.v.allies) {
    if (a.alive.value === false || !freshPos(a)) continue;
    const d = dist(me, a.pos.value!);
    if (d < 3500) continue;
    const around = enemies.filter((e) => dist(e.pos.value!, a.pos.value!) <= 2000);
    if (around.length < 2) continue;
    const zone = MAP_ZONE_RU[mapZone(a.pos.value!.x, a.pos.value!.y)];
    const tp = tpReady(c.v);
    const name = a.hero.value ? c.look.heroName(a.hero.value) : 'союзник';
    return draft({
      // один номер на правило: с номером по союзнику пауза не работала (режим тени: 1 075 раз на 100 игроков)
      id: 'macro.help',
      ruleId: 'macro.help',
      category: 'macro',
      priority: 'advice',
      confidence: 0.6,
      short: `Бой: ${zone} — ${tp ? 'телепорт' : 'помогите'}`,
      normal: `Возле ${name} ${around.length} врага (${zone}).${tp ? ' Town Portal Scroll готов — можно успеть.' : ' Идите на помощь.'}${personalNote(c.look.data.profile, 'missed-fights')}`,
      facts: [derivedFact('enemies-around-ally', 'Врагов у союзника', around.length, 0.7), derivedFact('distance', 'До союзника', Math.round(d), 0.7), derivedFact('tp', 'Town Portal Scroll готов', tp, 0.9)],
      ttlSec: 8,
      // реже (режим тени: 1 012 раз на 100 игроков про-матчей)
      cooldownSec: 60,
      icon: a.hero.value ? `hero:${a.hero.value}` : null,
    });
  }
  return null;
};

export const roshanKilledRule: Rule = (c) => {
  if (!c.ev.roshanKilled || c.mem.roshanKilledAt === null) return null;
  const min = c.look.mechanicValue('roshan-respawn', 'min');
  const max = c.look.mechanicValue('roshan-respawn', 'max');
  if (min === null || max === null) return null;
  const t = c.mem.roshanKilledAt;
  return draft({
    id: 'macro.roshan-killed',
    category: 'macro',
    priority: 'info',
    confidence: 0.95,
    short: `Рошан вернётся ${mmss(t + min)}–${mmss(t + max)}`,
    normal: `Рошан убит в ${mmss(t)}: возродится между ${mmss(t + min)} и ${mmss(t + max)}.`,
    facts: [{ key: 'roshan-killed', label: 'Рошан убит в', value: mmss(t), source: 'gsi', ageSec: 0, confidence: 1, verified: true }, kbFact('roshan-respawn', 'Возрождение, с', `${min}–${max}`, false)],
    ttlSec: 12,
    cooldownSec: 0,
    zone: 'timing',
  });
};

/**
 * Чья руна: руну силы и воду в лайнинге контролирует центр (и роумер-четвёрка), богатство — саппорты и центр.
 * Позиция не известна или игра уже не в лайнинге — объявляем всем. Первая руна богатства (0:00) — всем.
 */
export function runeForMe(id: string, at: number, g: Pick<GameContext, 'stage' | 'position'>): boolean {
  if (!id.startsWith('rune-') || g.position === null || g.stage !== 'laning' || at <= 0) return true;
  if (id === 'rune-bounty') return g.position === 2 || g.position >= 4;
  return g.position === 2 || g.position === 4;
}

/** На сколько секунд можно опоздать к руне, чтобы она ещё лежала (руну обычно забирают за 10–20 с) */
export const RUNE_LATE_SEC = 20;

/** Секунд бега до ближайшей точки руны (сила и вода — на точках руны силы, богатство — свои точки); null — не руна или позиция неизвестна */
export function runeRunSec(id: string, me: { x: number; y: number } | null): number | null {
  if (!me || !id.startsWith('rune-')) return null;
  const pts = id === 'rune-bounty' ? MAP_POINTS.runes.bounty : MAP_POINTS.runes.power;
  if (!pts.length) return null;
  return Math.round(Math.min(...pts.map((p) => dist(p, me))) / RUN_SPEED);
}

/** Руны, день и ночь, Мучитель, окно Рошана — по механике базы знаний; объявляем за 15 с один раз */
export const timersRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!c.v.inGame || clock === null || clock < -30) return null;
  const evs = upcomingEvents(c.look.mechanics, clock, { roshanDeathAt: c.mem.roshanKilledAt, tormentorDeathAt: c.mem.tormentorKilledAt });
  const out: HintDraft[] = [];
  const g = game(c);
  for (const e of evs) {
    if (e.status !== 'ok' || e.inSec === null || e.at === null) continue;
    if (!['rune-power', 'rune-bounty', 'rune-water', 'day-night', 'tormentor', 'roshan-respawn', 'shrine-of-wisdom'].includes(e.id)) continue;
    if (!runeForMe(e.id, e.at, g)) continue;
    // Руна — живому: мёртвому «бежать 5 с» не к месту (режим тени: 4 из 60 советов)
    if (e.id.startsWith('rune-') && c.v.me.alive.value !== true) continue;
    // «Скоро ночь» — к месту, только когда ночь меняет драку: у врагов Night Stalker (ночью он сильнее и видит дальше)
    if (e.id === 'day-night' && !c.v.enemies.some((x) => x.hero.value === 'night_stalker')) continue;
    // Святилище мудрости — опыт для саппортов (4–5); позиция не известна — как раньше
    if (e.id === 'shrine-of-wisdom' && g.position !== null && g.position < 4) continue;
    const lead = e.id === 'roshan-respawn' || e.id === 'tormentor' ? 30 : 15;
    if (e.inSec > lead || e.inSec < 3) continue;
    // Руна — только если успеваете добежать (время бега до ближайшей точки этой руны ≤ до появления + 20 с);
    // позиция не известна — объявляем, как раньше
    const run = runeRunSec(e.id, c.v.me.pos.value);
    if (run !== null && run > e.inSec + RUNE_LATE_SEC) continue;
    const key = `timer:${e.id}@${e.at}`;
    if (c.mem.once.has(key)) continue;
    c.mem.once.add(key);
    const what = e.id === 'day-night' ? `Скоро ${e.detailRu ?? 'смена суток'}` : run !== null ? `${e.nameRu} через ${Math.round(e.inSec)} с, бежать ${run} с` : `${e.nameRu} через ${Math.round(e.inSec)} с`;
    const verified = e.verification === 'verified';
    out.push(
      draft({
        id: `timing.${e.id}`,
        ruleId: `timing.${e.id}`,
        category: 'timing',
        priority: 'info',
        confidence: verified ? 0.95 : 0.8,
        short: what,
        normal: `${what} (${mmss(e.at)}).`,
        facts: [kbFact(e.id, e.nameRu, mmss(e.at), verified), fact('clock', 'Игровое время, с', c.v.clock)],
        ttlSec: Math.min(15, Math.max(5, Math.round(e.inSec))),
        cooldownSec: 0,
      }),
    );
  }
  return out;
};

/**
 * Аванпосты — координаты из файлов карты Dota 2 (src/data/outposts.json, scripts/extract-outposts.mjs).
 * Чей аванпост сейчас, GSI игрока не сообщает, поэтому подсказка условная: «если он вражеский — захватите».
 */
export const OUTPOSTS: readonly { id: string; x: number; y: number }[] = outpostsJson.outposts;
/** Ближе этого к аванпосту — «рядом» (захват — стоять у него 6 с) */
export const OUTPOST_NEAR_UNITS = 1200;

export const outpostRule: Rule = (c) => {
  const me = c.v.me.pos.value;
  if (!playing(c) || !me || c.v.me.alive.value !== true || c.mem.inFight || nearEnemyCount(c.v) > 0) return null;
  // Только аванпост на половине врага: свой (на своей половине) захватывать не нужно — в матче 9051402480 коуч
  // дважды звал к аванпосту Сил Тьмы, играя за Силы Тьмы. Чей он сейчас, GSI не сообщает — поэтому «если ещё вражеский»
  const team = c.v.team;
  if (!team) return null;
  const o = OUTPOSTS.find((p) => dist(p, me) <= OUTPOST_NEAR_UNITS && mapSide(p, team) === 'enemy');
  if (!o) return null;
  const capture = c.look.mechanicValue('outpost', 'capture');
  const d = Math.round(dist(o, me));
  return draft({
    id: `macro.outpost:${o.id}`,
    ruleId: 'macro.outpost',
    category: 'macro',
    priority: 'info',
    confidence: 0.6,
    short: `Аванпост врага в ${d} ед. — захватите`,
    normal: `Аванпост на стороне врага в ${d} ед. от вас, врагов рядом не видно. Если он ещё вражеский, захватите его${capture !== null ? ` (стоять у него ${capture} с)` : ''}: обзор и телепорт для команды.`,
    facts: [derivedFact('outpost-distance', 'До аванпоста', Math.round(dist(o, me)), 0.9), kbFact('outpost-capture', 'Захват, с', capture, false)],
    ttlSec: 8,
    cooldownSec: 300,
  });
};

/**
 * Напоминание из прошлых игр (ночная задача, этап 4): один раз в начале матча — главная повторяющаяся ошибка по
 * локальной истории коуча («в 4 из 5 последних матчей») и что с ней делать. Нет повторов — молчит.
 */
export const personalStartRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const p = c.look.data.profile?.patterns ?? [];
  if (!c.v.inGame || clock === null || clock < 0 || clock > 120 || !p.length || c.mem.once.has('personal:start')) return null;
  c.mem.once.add('personal:start');
  const top = p[0]!;
  const also = p[1] ? ` Ещё: ${p[1].titleRu} (${p[1].inMatches} из ${p[1].of}).` : '';
  return draft({
    id: 'macro.personal',
    category: 'macro',
    priority: 'info',
    confidence: 0.8,
    short: `Из прошлых игр: ${top.titleRu} (${top.inMatches} из ${top.of})`,
    normal: `${top.adviceRu} В ${top.inMatches} из ${top.of} последних матчей были ${top.titleRu}.${also}`,
    facts: [derivedFact('pattern', 'Повторяющаяся ошибка', top.titleRu, 0.8), derivedFact('pattern-share', 'Матчей с ней', `${top.inMatches} из ${top.of}`, 0.9)],
    ttlSec: 12,
    cooldownSec: 0,
  });
};

/** С этой секунды без уверенной позиции коуч просит выбрать её (к 2:00 линия уже понятна) */
export const POSITION_ASK_AT = 120;

/**
 * Позиция не определилась (герой играет на разных позициях, линия неясна) — один раз за матч просим выбрать её в окне
 * коуча. Окно поверх игры не берёт фокус и не принимает клики, поэтому выбор — там, а не на плашке.
 */
export const positionAskRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!c.v.inGame || clock === null || clock < POSITION_ASK_AT || c.mem.once.has('ask:position')) return null;
  const g = game(c);
  if (g.positionSource === 'settings' || (g.position !== null && g.positionConfidence >= 0.6)) return null;
  c.mem.once.add('ask:position');
  return draft({
    id: 'macro.ask-position',
    category: 'macro',
    priority: 'info',
    confidence: 0.9,
    short: 'Какая у вас позиция? Выберите в окне коуча',
    normal: 'Коуч не уверен в вашей позиции — от неё зависят советы. Окно коуча → «Настройки» → «Моя позиция».',
    facts: [derivedFact('position', 'Позиция (догадка коуча)', g.position, g.positionConfidence)],
    ttlSec: 12,
    cooldownSec: 0,
  });
};

export const MACRO_RULES: Rule[] = [personalStartRule, positionAskRule, helpRule, pushWindowRule, roshanKilledRule, groupRule, outpostRule, timersRule];
