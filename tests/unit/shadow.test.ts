// «Режим тени» (ночная задача, этап 5): коуч смотрит про-матчи STRATZ глазами каждого из 10 игроков — посекундно
// строится то, что он видел бы (GSI своего героя + мини-карта и полоски здоровья), и считается: сколько советов,
// сколько не к месту (автоматические проверки по тому, что случилось потом), что пропущено (смерти без предупреждения).
// Таймлайны — scripts/fetch-shadow-matches.mjs → .tmp/shadow (не в git). Запуск: DOTACOACH_SHADOW=1 npx vitest run tests/unit/shadow.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CoachEngine, defaultCoachSettings } from '../../src/core/coach/index.ts';
import { CoachLookup, type CoachData } from '../../src/core/coach/data.ts';
import { parseStatsRanked } from '../../src/shared/types/stats-ranked.ts';
import { realData, sim, type SimInput } from './coach-sim.ts';

type Ev<T> = ({ time: number } & T)[];
interface ShadowPlayer {
  heroId: number;
  isRadiant: boolean;
  isVictory: boolean;
  position: string | null;
  experiencePerMinute: number;
  playbackData: {
    playerUpdatePositionEvents: Ev<{ x: number; y: number }>;
    playerUpdateHealthEvents: Ev<{ hp: number; maxHp: number; mp: number; maxMp: number }>;
    playerUpdateLevelEvents: Ev<{ level: number }>;
    playerUpdateGoldEvents: Ev<{ gold: number; networth: number }>;
    inventoryEvents: Ev<Record<string, { itemId: number; charges: number | null } | null>>;
    deathEvents: Ev<{ timeDead: number; isBurst: boolean; isEngagedOnDeath: boolean; hasHealAvailable: boolean; isAttemptTpOut: boolean; isDieBack: boolean }>;
    killEvents: Ev<object>;
    csEvents: Ev<object>;
  };
}
interface ShadowMatch {
  id: number;
  didRadiantWin: boolean;
  durationSeconds: number;
  players: ShadowPlayer[];
}

const DIR = join(import.meta.dirname, '../../.tmp/shadow');
const OUT = join(import.meta.dirname, '../../docs/night');
/** Клетки STRATZ → координаты мира (как xpos/ypos в GSI) */
const world = (c: number) => (c - 128) * 128;
/** «Видно» врага, если рядом с ним (ближе) свой герой — грубая модель тумана войны */
const VISION = 1800;
/** «На экране» (полоска здоровья) — враг ближе к герою */
const SCREEN = 1400;

/** Последнее событие с time ≤ t (события отсортированы по времени) */
function at<T extends { time: number }>(evs: readonly T[], t: number): T | null {
  let lo = 0;
  let hi = evs.length - 1;
  let best: T | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (evs[m]!.time <= t) {
      best = evs[m]!;
      lo = m + 1;
    } else hi = m - 1;
  }
  return best;
}
const countUpTo = (evs: readonly { time: number }[], t: number) => evs.filter((e) => e.time <= t).length;
const deadAt = (p: ShadowPlayer, t: number) => p.playbackData.deathEvents.some((d) => t >= d.time && t < d.time + Math.max(1, d.timeDead));
const posAt = (p: ShadowPlayer, t: number) => {
  const e = at(p.playbackData.playerUpdatePositionEvents, t);
  return e ? { x: world(e.x), y: world(e.y) } : null;
};
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

interface Said {
  match: number;
  hero: string;
  pos: string;
  t: number;
  id: string;
  short: string;
  category: string;
  inFight: boolean;
  hpPct: number;
  enemiesNear: number;
}

function runPlayer(m: ShadowMatch, me: ShadowPlayer, data: CoachData, look: CoachLookup, itemKey: Map<number, string>) {
  const heroKey = look.heroById.get(me.heroId)?.key ?? 'antimage';
  const pos = (me.position ?? '').replace('POSITION_', '');
  let now = 1_000_000;
  const e = new CoachEngine({ data, now: () => now, settings: { ...defaultCoachSettings(), position: /^[1-5]$/.test(pos) ? (pos as '1') : 'auto', aiLive: false } });
  const allies = m.players.filter((p) => p !== me && p.isRadiant === me.isRadiant);
  const enemies = m.players.filter((p) => p.isRadiant !== me.isRadiant);
  const slotOf = (p: ShadowPlayer) => m.players.indexOf(p) + (p.isRadiant ? 0 : 0);
  const lastSeen = new Map<ShadowPlayer, number>();
  const said: Said[] = [];
  const deathsAt = me.playbackData.deathEvents.map((d) => d.time);
  for (let t = 0; t <= m.durationSeconds; t++) {
    now = 1_000_000 + t * 1000;
    const myPos = posAt(me, t);
    const hp = at(me.playbackData.playerUpdateHealthEvents, t);
    const lvl = at(me.playbackData.playerUpdateLevelEvents, t)?.level ?? 1;
    const gold = at(me.playbackData.playerUpdateGoldEvents, t);
    const inv = at(me.playbackData.inventoryEvents, t);
    const alive = !deadAt(me, t);
    const items: NonNullable<SimInput['items']> = [];
    if (inv) {
      for (const [slot, name] of [['item0', 'inv0'], ['item1', 'inv1'], ['item2', 'inv2'], ['item3', 'inv3'], ['item4', 'inv4'], ['item5', 'inv5'], ['teleport0', 'tp'], ['neutral0', 'neutral']] as const) {
        const it = inv[slot];
        const key = it ? itemKey.get(it.itemId) : undefined;
        // перезарядок в таймлайне STRATZ нет: Town Portal Scroll — «не известно» (иначе «можно было уйти по ТП» на всех смертях)
        if (key) items.push({ slot: name, key, charges: it!.charges ?? null, cooldownSec: name === 'tp' ? null : 0 });
      }
    }
    const watchers = [me, ...allies].filter((p) => !deadAt(p, t)).map((p) => posAt(p, t)).filter((x): x is { x: number; y: number } => x !== null);
    const enemyInputs = enemies.map((p, k) => {
      const ep = posAt(p, t);
      const dead = deadAt(p, t);
      const seen = !dead && ep !== null && watchers.some((w) => dist(w, ep) <= VISION);
      if (seen) lastSeen.set(p, t);
      const h = at(p.playbackData.playerUpdateHealthEvents, t);
      const onScreen = seen && myPos !== null && ep !== null && dist(myPos, ep) <= SCREEN;
      return {
        slot: (me.isRadiant ? 5 : 0) + k,
        hero: look.heroById.get(p.heroId)?.key ?? 'axe',
        alive: !dead,
        pos: seen ? ep : dead ? undefined : null,
        missingForSec: seen ? 0 : t - (lastSeen.get(p) ?? 0),
        hpPercent: onScreen && h ? Math.round((h.hp / Math.max(1, h.maxHp)) * 100) : null,
        barLevel: onScreen ? (at(p.playbackData.playerUpdateLevelEvents, t)?.level ?? null) : null,
      };
    });
    const allyInputs = allies.map((p, k) => ({ slot: (me.isRadiant ? 0 : 5) + k + 1, hero: look.heroById.get(p.heroId)?.key ?? 'axe', alive: !deadAt(p, t), pos: posAt(p, t) }));
    const minutes = Math.max(1, t / 60);
    const s = sim({
      wallMs: now,
      clock: t,
      team: me.isRadiant ? 'radiant' : 'dire',
      heroKey,
      heroId: me.heroId,
      level: lvl,
      hp: hp?.hp ?? 600,
      maxHp: hp?.maxHp ?? 600,
      mana: hp?.mp ?? 300,
      maxMana: hp?.maxMp ?? 300,
      gold: gold?.gold ?? 600,
      gpm: Math.round((gold?.networth ?? 600) / minutes),
      xpm: me.experiencePerMinute,
      lastHits: countUpTo(me.playbackData.csEvents, t),
      kills: countUpTo(me.playbackData.killEvents, t),
      deaths: deathsAt.filter((x) => x <= t).length,
      alive,
      respawnSec: alive ? 0 : 20,
      pos: myPos ?? undefined,
      items,
      abilities: [],
      enemies: enemyInputs,
      allies: allyInputs,
      buildings: null,
    });
    void slotOf;
    const u = e.tick(s.state, s.gsi, now);
    for (const h of u.shown) said.push({ match: m.id, hero: heroKey, pos, t, id: h.id, short: h.short, category: h.category, inFight: u.inFight, hpPct: hp ? Math.round((hp.hp / Math.max(1, hp.maxHp)) * 100) : -1, enemiesNear: e.game?.now.enemiesNear ?? 0 });
  }
  return { said, deathReviews: e.mem.deaths.length, reviews: e.journal.filter((j) => j.kind === 'death-review'), heroKey, pos };
}

describe.runIf(process.env.DOTACOACH_SHADOW && existsSync(DIR))('режим тени: про-матчи STRATZ', () => {
  it('прогон и подсчёт', () => {
    const ranked = parseStatsRanked(JSON.parse(readFileSync(join(import.meta.dirname, '../../resources/data/kb/7.41f/stats-ranked.json'), 'utf8')), '7.41f');
    const data: CoachData = { ...realData(), statsRanked: ranked };
    const look = new CoachLookup(data);
    const itemKey = new Map(data.items.map((i) => [i.id, i.key]));
    const files = readdirSync(DIR).filter((f) => f.endsWith('.json'));
    const all: Said[] = [];
    const checks = { total: 0, farmInFight: 0, jungleInLaningCore: 0, retreatThenWon: 0, retreatCount: 0, engageThenDied: 0, engageCount: 0, benchLagPro: 0, deaths: 0, deathsWarned: 0, playerSeconds: 0 };
    const deathCheck: { stratz: string; coach: string }[] = [];
    const examples = { farmInFight: [] as Said[], jungle: [] as Said[] };
    for (const f of files) {
      const m = JSON.parse(readFileSync(join(DIR, f), 'utf8')) as ShadowMatch;
      for (const me of m.players) {
        const r = runPlayer(m, me, data, look, itemKey);
        all.push(...r.said);
        checks.playerSeconds += m.durationSeconds;
        const kills = me.playbackData.killEvents.map((k) => k.time);
        const deaths = me.playbackData.deathEvents;
        for (const s of r.said) {
          checks.total++;
          // «Чужой лес — опасно» — предупреждение, а не совет фармить: не считаем
          if (s.inFight && s.category !== 'danger' && (s.category === 'economy' || s.category === 'laning' || /фарм|лес/i.test(s.short))) {
            checks.farmInFight++;
            if (examples.farmInFight.length < 15) examples.farmInFight.push(s);
          }
          if (/лес/i.test(s.short) && s.category !== 'danger' && /^[123]$/.test(s.pos) && s.t < 600) {
            checks.jungleInLaningCore++;
            if (examples.jungle.length < 15) examples.jungle.push(s);
          }
          const back = /^(Отходи|Не вступать)/.test(s.short);
          const go = /^Вступать/.test(s.short);
          const killedSoon = kills.some((k) => k >= s.t && k <= s.t + 15);
          const diedSoon = deaths.some((d) => d.time >= s.t && d.time <= s.t + 10);
          if (back) {
            checks.retreatCount++;
            if (killedSoon && !diedSoon && me.isVictory) checks.retreatThenWon++;
          }
          if (go) {
            checks.engageCount++;
            if (diedSoon && !killedSoon) checks.engageThenDied++;
          }
          if (s.id === 'laning.bench' && /у сильных игроков|у профи/.test(s.short)) checks.benchLagPro++;
        }
        for (const d of deaths) {
          checks.deaths++;
          // предупреждение: «назад»/опасность за 20 с до смерти
          if (r.said.some((s) => s.t >= d.time - 20 && s.t <= d.time && (s.category === 'danger' || /^(Отходи|Не вступать)/.test(s.short)))) checks.deathsWarned++;
        }
        for (const rv of r.reviews.slice(0, 20)) {
          const d = deaths.find((x) => Math.abs(x.time - (rv.clock ?? -999)) <= 2);
          if (d) deathCheck.push({ stratz: [d.isBurst ? 'быстрый урон' : '', d.isAttemptTpOut ? 'пытался уйти ТП' : '', d.hasHealAvailable ? 'было лечение' : '', d.isEngagedOnDeath ? 'в драке' : ''].filter(Boolean).join(', ') || '—', coach: rv.text });
        }
      }
    }
    mkdirSync(OUT, { recursive: true });
    const byRule = new Map<string, number>();
    for (const s of all) byRule.set(s.id.split(':')[0]!, (byRule.get(s.id.split(':')[0]!) ?? 0) + 1);
    const perMin = all.length / (checks.playerSeconds / 60);
    // Выборка для ручной оценки: 60 случайных (с фиксированным зерном) советов с обстановкой
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const sample = [...all].sort(() => rnd() - 0.5).slice(0, 60);
    writeFileSync(join(OUT, 'shadow-results.json'), JSON.stringify({ matches: files.length, players: files.length * 10, checks, perMin: Math.round(perMin * 100) / 100, byRule: Object.fromEntries([...byRule.entries()].sort((a, b) => b[1] - a[1])), deathCheck: deathCheck.slice(0, 40), examples, sample }, null, 1));
    expect(checks.total).toBeGreaterThan(0);
  }, 3_600_000);
});
