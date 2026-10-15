// Факты после матча (этап 4): из записанной сессии GSI или из модели матча, построенной «Разбором записи».
// Смерти со временем, кривая уровня и золота, предметы со временем, простои; руны и пропущенные события —
// честно «неизвестно», если данных о них нет. ИИ пишет разбор только по этим строкам; без ИИ строки показываются как есть.
// Чистое ядро.
import type { GsiReading } from '../gsi/map.ts';
import type { MatchState } from '../match-state/types.ts';
import { mmss } from './facts.ts';

export interface AfterMatchFacts {
  hero: string | null;
  durationSec: number | null;
  lines: string[];
}

/** Отметки кривой уровня и золота, минуты */
export const CURVE_MARKS_MIN = [5, 10, 15, 20, 25, 30, 40, 50, 60];
/** Простой: жив, не пауза, сдвинулся меньше чем на IDLE_RADIUS за IDLE_MIN_SEC и дольше */
export const IDLE_MIN_SEC = 60;
export const IDLE_RADIUS = 300;
/** Сколько простоев показывать */
const MAX_IDLE = 5;

const IGNORED_ITEMS = new Set(['tpscroll', 'ward_observer', 'ward_sentry', 'ward_dispenser', 'tango', 'flask', 'clarity', 'smoke_of_deceit', 'dust', 'faerie_fire', 'enchanted_mango', 'blood_grenade']);

export function afterMatchFromGsi(readings: readonly GsiReading[]): AfterMatchFacts {
  const rs = readings.filter((r) => r.clock !== null && r.phase === 'in-progress');
  if (!rs.length) return { hero: null, durationSec: null, lines: ['Нет данных матча: в записи нет идущей игры'] };
  const hero = rs.find((r) => r.hero.name)?.hero.name ?? rs[0]!.hero.key;
  const last = rs[rs.length - 1]!;
  const duration = Math.round(last.clock!);
  const lines: string[] = [];
  lines.push(`Герой: ${hero}; длительность записи: ${mmss(duration)}${last.kda ? `; итог У/С/П: ${last.kda.kills}/${last.kda.deaths}/${last.kda.assists}` : ''}`);

  // Смерти: переход «жив → мёртв» (или рост счётчика смертей)
  const deaths: string[] = [];
  let prevAlive: boolean | null = null;
  let prevDeaths: number | null = null;
  for (const r of rs) {
    const died = (prevAlive === true && r.hero.alive === false) || (prevDeaths !== null && r.kda && r.kda.deaths > prevDeaths && r.hero.alive !== true && prevAlive !== false);
    if (died) deaths.push(`${mmss(r.clock!)}${r.hero.level !== null ? ` (уровень ${r.hero.level}${r.gold !== null ? `, золото ${r.gold}` : ''})` : ''}`);
    if (r.hero.alive !== null) prevAlive = r.hero.alive;
    if (r.kda) prevDeaths = r.kda.deaths;
  }
  lines.push(deaths.length ? `Смерти (${deaths.length}): ${deaths.join('; ')}` : 'Смертей в записи нет');

  // Кривая уровня, золота и добивания
  const curve: string[] = [];
  for (const m of CURVE_MARKS_MIN) {
    const at = m * 60;
    if (at > duration) break;
    const r = rs.find((x) => x.clock! >= at);
    if (!r) break;
    const bits = [r.hero.level !== null ? `уровень ${r.hero.level}` : null, r.gold !== null ? `золото ${r.gold}` : null, r.farm ? `добито ${r.farm.lastHits}` : null].filter(Boolean);
    if (bits.length) curve.push(`${m}:00 — ${bits.join(', ')}`);
  }
  if (curve.length) lines.push(`По минутам: ${curve.join('; ')}`);
  const lvl = last.hero.level;
  lines.push(`В конце записи: ${[lvl !== null ? `уровень ${lvl}` : null, last.gold !== null ? `золото ${last.gold}` : null, last.farm ? `добито ${last.farm.lastHits}, не отдано ${last.farm.denies}` : null].filter(Boolean).join(', ') || 'нет данных'}`);

  // Предметы: когда впервые появились (без расходников)
  const seenItems = new Map<string, { name: string; clock: number }>();
  let anyItems = false;
  for (const r of rs) {
    if (!r.items) continue;
    anyItems = true;
    for (const it of r.items) {
      if (!it.key || it.slot.startsWith('stash') || it.slot === 'tp' || IGNORED_ITEMS.has(it.key) || it.key.startsWith('recipe_')) continue;
      if (!seenItems.has(it.key)) seenItems.set(it.key, { name: it.name ?? it.key, clock: r.clock! });
    }
  }
  const items = [...seenItems.values()].filter((x) => x.clock > 0).sort((a, b) => a.clock - b.clock);
  const start = [...seenItems.values()].filter((x) => x.clock <= 0);
  if (!anyItems) lines.push('Предметы: неизвестно (в данных игры нет блока предметов)');
  else {
    if (start.length) lines.push(`Стартовые предметы: ${start.map((x) => x.name).join(', ')}`);
    lines.push(items.length ? `Предметы по времени: ${items.map((x) => `${x.name} — ${mmss(x.clock)}`).join('; ')}` : 'Новых предметов после горна нет');
  }

  // Простои
  const idle: { from: number; to: number }[] = [];
  let anchor: GsiReading | null = null;
  const close = (end: GsiReading | null) => {
    if (anchor && end && end.clock! - anchor.clock! >= IDLE_MIN_SEC) idle.push({ from: anchor.clock!, to: end.clock! });
  };
  let prev: GsiReading | null = null;
  let hasPos = false;
  for (const r of rs) {
    const ok = r.hero.alive === true && !r.paused && r.hero.x !== null && r.hero.y !== null;
    if (r.hero.x !== null) hasPos = true;
    if (!ok) {
      close(prev);
      anchor = null;
    } else if (!anchor) anchor = r;
    else if (Math.hypot(r.hero.x! - anchor.hero.x!, r.hero.y! - anchor.hero.y!) > IDLE_RADIUS) {
      close(prev);
      anchor = r;
    }
    prev = r;
  }
  close(prev);
  if (!hasPos) lines.push('Простои: неизвестно (нет координат героя)');
  else if (!idle.length) lines.push(`Простоев дольше ${IDLE_MIN_SEC} с нет`);
  else {
    const top = idle.sort((a, b) => b.to - b.from - (a.to - a.from)).slice(0, MAX_IDLE).sort((a, b) => a.from - b.from);
    lines.push(`Простои (живой герой стоял на месте ${IDLE_MIN_SEC} с и дольше): ${top.map((p) => `${mmss(p.from)}–${mmss(p.to)} (${Math.round(p.to - p.from)} с)`).join('; ')}`);
  }
  lines.push('Руны и пропущенные события карты: неизвестно (данные игры о рунах не приходят)');
  return { hero, durationSec: duration, lines };
}

/** Из модели матча «Разбора записи»: только то, что есть в журнале событий и текущих значениях */
export function afterMatchFromState(s: MatchState): AfterMatchFacts {
  const hero = s.hero.identity.value?.name ?? null;
  const clock = s.match.clock.value;
  const lines: string[] = [];
  lines.push(`Герой: ${hero ?? 'не определён'}; время в записи: ${clock !== null ? mmss(clock) : 'неизвестно'}`);
  const at = (c: number | null) => (c !== null ? mmss(c) : 'время неизвестно');
  const deaths = s.events.filter((e) => e.type === 'death');
  lines.push(deaths.length ? `Смерти (${deaths.length}): ${deaths.map((e) => at(e.clock)).join('; ')}` : 'Смертей в записи не замечено');
  const lv = s.events.filter((e) => e.type === 'level-up');
  if (lv.length) lines.push(`Уровни: ${lv.map((e) => `${(e.data as { to?: number }).to} — ${at(e.clock)}`).join('; ')}`);
  const items = s.events.filter((e) => e.type === 'item-gained' && !IGNORED_ITEMS.has(String((e.data as { key?: string }).key)));
  if (items.length) lines.push(`Предметы по времени: ${items.map((e) => `${(e.data as { name?: string }).name ?? (e.data as { key?: string }).key} — ${at(e.clock)}`).join('; ')}`);
  const g = s.hero.gold.value;
  lines.push(g !== null ? `Золото в конце: ${g}` : 'Золото: неизвестно');
  lines.push('Кривая золота, простои и руны: неизвестно (в разборе записи их нет)');
  return { hero, durationSec: clock !== null ? Math.round(clock) : null, lines };
}
