// E. Макро и цели: окно для пуша (враги мертвы), сбор команды, помощь в драке союзников, Рошан, тайминги карты.
import { upcomingEvents } from '../../knowledge-base/timers.ts';
import { MAP_ZONE_RU, mapZone } from '../../match-state/map-zones.ts';
import { tpReady } from '../memory.ts';
import { NEAR_UNITS, dist } from '../geo.ts';
import { derivedFact, fact, kbFact } from '../view.ts';
import { draft, mmss, playing, plural, type Rule } from './context.ts';
import type { HintDraft } from '../types.ts';

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
      id: `macro.help:${a.slot}`,
      ruleId: 'macro.help',
      category: 'macro',
      priority: 'advice',
      confidence: 0.6,
      short: `Бой: ${zone} — ${tp ? 'ТП' : 'помогите'}`,
      normal: `Возле ${name} ${around.length} врага (${zone}).${tp ? ' ТП готов — можно успеть.' : ' Идите на помощь.'}`,
      facts: [derivedFact('enemies-around-ally', 'Врагов у союзника', around.length, 0.7), derivedFact('distance', 'До союзника', Math.round(d), 0.7), derivedFact('tp', 'ТП готов', tp, 0.9)],
      ttlSec: 8,
      cooldownSec: 30,
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

/** Руны, день и ночь, Мучитель, окно Рошана — по механике базы знаний; объявляем за 15 с один раз */
export const timersRule: Rule = (c) => {
  const clock = c.v.clock.value;
  if (!c.v.inGame || clock === null || clock < -30) return null;
  const evs = upcomingEvents(c.look.data.mechanics, clock, { roshanDeathAt: c.mem.roshanKilledAt, tormentorDeathAt: c.mem.tormentorKilledAt });
  const out: HintDraft[] = [];
  for (const e of evs) {
    if (e.status !== 'ok' || e.inSec === null || e.at === null) continue;
    if (!['rune-power', 'rune-bounty', 'rune-water', 'day-night', 'tormentor', 'roshan-respawn', 'shrine-of-wisdom'].includes(e.id)) continue;
    const lead = e.id === 'roshan-respawn' || e.id === 'tormentor' ? 30 : 15;
    if (e.inSec > lead || e.inSec < 3) continue;
    const key = `timer:${e.id}@${e.at}`;
    if (c.mem.once.has(key)) continue;
    c.mem.once.add(key);
    const what = e.id === 'day-night' ? `Скоро ${e.detailRu ?? 'смена суток'}` : `${e.nameRu} через ${Math.round(e.inSec)} с`;
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

export const MACRO_RULES: Rule[] = [helpRule, pushWindowRule, roshanKilledRule, groupRule, timersRule];
