// Охота: вражеский кор показался один — соберитесь и убейте. Не «помогите в драке» (это macro.help), а окно
// для нападения: цель видна прямо сейчас (мини-карта, не старше 3 с), рядом с ней никого из врагов, пропавших врагов
// не больше одного (иначе это может быть засада), и до неё могут дойти минимум двое из нашей команды.
// Коуч ничего не пишет в игру (ввод в игру запрещён политикой): позвать команду игрок может сам — меткой на карте.
import { MAP_ZONE_RU, mapZone } from '../../match-state/map-zones.ts';
import { tpReady } from '../memory.ts';
import { dist, isOwnBase } from '../geo.ts';
import { derivedFact } from '../view.ts';
import { draft, playing, plural, type Rule, type RuleContext } from './context.ts';
import type { ViewPlayer } from '../view.ts';

/** Рядом с целью нет врагов ближе этого (ед. карты) */
export const PICKOFF_LONELY_UNITS = 2500;
/** Союзник «успеет», если ближе этого к цели (≈ 15–20 с бега) */
export const PICKOFF_REACH_UNITS = 5000;
/** Позиция цели свежая — не старше, с */
const FRESH_SEC = 3;
/** Минимум нападающих (вместе с игроком) */
export const PICKOFF_MIN_HUNTERS = 2;

const fresh = (p: ViewPlayer) => p.pos.value !== null && (p.pos.ageSec ?? 99) <= FRESH_SEC;

/** Кор врага: где его играют сильные игроки рейтинга (позиции 1–3) или главная роль базы знаний — Carry */
export function isCore(c: RuleContext, key: string): 'carry' | 'core' | null {
  const ranked = c.look.data.statsRanked?.heroes.find((h) => h.key === key);
  const total = ranked ? Object.values(ranked.matches).reduce((a, b) => a + b, 0) : 0;
  if (ranked && total >= 300) {
    const share = (p: string) => (ranked.matches[p] ?? 0) / total;
    if (share('1') >= 0.4) return 'carry';
    if (share('1') + share('2') + share('3') >= 0.6) return 'core';
    return null;
  }
  const role = c.look.heroByKey.get(key)?.roles[0];
  return role === 'Carry' ? 'carry' : null;
}

export const pickoffRule: Rule = (c) => {
  const clock = c.v.clock.value;
  const me = c.v.me.pos.value;
  const team = c.v.team;
  if (!playing(c) || clock === null || clock < 6 * 60 || !me || !team || c.mem.inFight) return null;
  const hp = c.v.me.hp.value;
  if (hp !== null && hp.max > 0 && hp.current / hp.max < 0.5) return null;
  const alive = c.v.enemies.filter((e) => e.alive.value !== false);
  // Пропавших (живых, но не видно) больше одного — может быть засада: не зовём
  const missing = alive.filter((e) => e.missing === true).length;
  if (missing > 1) return null;
  const visible = alive.filter(fresh);
  for (const target of visible) {
    const key = target.hero.value;
    if (!key) continue;
    const core = isCore(c, key);
    if (!core) continue;
    const at = target.pos.value!;
    // Рядом с целью никого из её команды
    if (visible.some((e) => e !== target && dist(e.pos.value!, at) <= PICKOFF_LONELY_UNITS)) continue;
    // У себя на базе его не поймать (фонтан, башни 4-го уровня)
    const zone = mapZone(at.x, at.y);
    const enemyTeam = team === 'radiant' ? 'dire' : 'radiant';
    if (isOwnBase(zone, enemyTeam)) continue;
    // Кто успеет: живые союзники со свежей позицией рядом с целью, и я — дойду или телепортируюсь
    const allies = c.v.allies.filter((a) => a.alive.value !== false && fresh(a) && dist(a.pos.value!, at) <= PICKOFF_REACH_UNITS);
    const meReach = dist(me, at) <= PICKOFF_REACH_UNITS || tpReady(c.v) === true;
    const hunters = allies.length + (meReach ? 1 : 0);
    if (!meReach || hunters < PICKOFF_MIN_HUNTERS) continue;
    const name = c.look.heroName(key);
    const where = MAP_ZONE_RU[zone];
    const who = core === 'carry' ? 'Керри врага' : 'Кор врага';
    const close = dist(me, at) <= PICKOFF_REACH_UNITS;
    const others = allies.length ? `вы и ${allies.length} ${plural(allies.length, 'союзник', 'союзника', 'союзников')}` : 'вы';
    return draft({
      id: `macro.pickoff:${key}`,
      ruleId: 'macro.pickoff',
      category: 'macro',
      priority: 'advice',
      confidence: missing === 0 ? 0.75 : 0.62,
      short: `${name} один — убить`,
      normal: `${who} ${name} один: ${where}, рядом никого. Успеют ${others}${close ? '' : ' (у вас готов ТП)'}. Отметьте его на карте для команды и нападайте вместе.`,
      facts: [
        derivedFact('target', who, name, 0.8),
        derivedFact('where', 'Где', where, 0.75),
        derivedFact('hunters', 'Успеют напасть', hunters, 0.7),
        derivedFact('missing', 'Пропавших врагов', missing, 0.75),
      ],
      ttlSec: 8,
      cooldownSec: 90,
      zone: 'decision',
      icon: `hero:${key}`,
    });
  }
  return null;
};
