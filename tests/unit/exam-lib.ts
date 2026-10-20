// Экзамен коуча (docs/EXAM.md) и обучение прогноза драк: матч STRATZ → то, что коуч получал бы в настоящей игре.
// Свой герой — тело GSI (через тот же readGsi, что в движке, и тот же GameModeTracker); враги и союзники — чтения
// «зрения» (верхняя панель, мини-карта, полоски здоровья) с туманом войны по данным матча и ошибками зрения, как
// измерено на ваших записях (docs/VISION_ACCURACY.md); всё это — в ту же модель состояния матча (MatchStateModel).
// Будущего коуч не видит: на секунде t — только события до t.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import { GameModeTracker } from '../../src/core/gsi/index.ts';
import { readGsi } from '../../src/engine/gsi.ts';
import { recognizeHud, type HudReading } from '../../src/core/vision/recognize-hud.ts';
import type { TopBarReading } from '../../src/core/vision/top-bar.ts';
import type { MinimapReading } from '../../src/core/vision/minimap.ts';
import type { HealthBarsReading } from '../../src/core/vision/health-bars.ts';
import type { CoachInput } from '../../src/shared/types/coach-input.ts';
import heroNames from '../../src/data/hero-names.json';

const root = join(import.meta.dirname, '../..');
const data = (f: string) => JSON.parse(readFileSync(join(root, 'src/data', f), 'utf8'));

type Ev<T> = ({ time: number } & T)[];
type InvSlot = { itemId: number; charges: number | null } | null;
export interface XPlayer {
  heroId: number;
  isRadiant: boolean;
  position: string | null;
  playbackData: {
    playerUpdatePositionEvents: Ev<{ x: number; y: number }>;
    playerUpdateHealthEvents: Ev<{ hp: number; maxHp: number; mp: number; maxMp: number }>;
    playerUpdateLevelEvents: Ev<{ level: number }>;
    playerUpdateGoldEvents: Ev<{ gold: number; networth: number }>;
    purchaseEvents: Ev<{ itemId: number }>;
    deathEvents: Ev<{ timeDead: number }>;
    killEvents: Ev<object>;
    inventoryEvents?: Ev<Record<string, InvSlot>>;
  };
}
export interface XMatch {
  id: number;
  durationSeconds: number;
  didRadiantWin?: boolean;
  players: XPlayer[];
}

/** Матч + инвентарь (в самом файле или в соседней папке inv/) */
export function readXMatch(file: string): XMatch {
  const m = JSON.parse(gunzipSync(readFileSync(file)).toString('utf8')) as XMatch;
  const invFile = join(file, '..', 'inv', file.split(/[\\/]/).pop()!);
  if (existsSync(invFile) && !m.players.some((p) => p.playbackData.inventoryEvents)) {
    const inv = JSON.parse(gunzipSync(readFileSync(invFile)).toString('utf8')) as { players: { heroId: number; playbackData: { inventoryEvents: Ev<Record<string, InvSlot>> } | null }[] };
    for (const p of m.players) p.playbackData.inventoryEvents = inv.players.find((q) => q.heroId === p.heroId)?.playbackData?.inventoryEvents;
  }
  return m;
}

// --- Таймлайн ---
export const world = (c: number) => c * 128 - 16240;
export function at<T extends { time: number }>(evs: readonly T[] | undefined, t: number): T | null {
  if (!evs) return null;
  let lo = 0, hi = evs.length - 1, best: T | null = null;
  while (lo <= hi) {
    const m = (lo + hi) >> 1;
    if (evs[m]!.time <= t) (best = evs[m]!), (lo = m + 1);
    else hi = m - 1;
  }
  return best;
}
export type P = { x: number; y: number };
export const deadAt = (p: XPlayer, t: number) => p.playbackData.deathEvents.some((d) => t >= d.time && t < d.time + Math.max(1, d.timeDead));
export const respawnIn = (p: XPlayer, t: number) => {
  const d = p.playbackData.deathEvents.find((x) => t >= x.time && t < x.time + Math.max(1, x.timeDead));
  return d ? Math.ceil(d.time + d.timeDead - t) : 0;
};
export const posAt = (p: XPlayer, t: number): P | null => {
  const e = at(p.playbackData.playerUpdatePositionEvents, t);
  return e ? { x: world(e.x), y: world(e.y) } : null;
};
export const levelAt = (p: XPlayer, t: number) => at(p.playbackData.playerUpdateLevelEvents, t)?.level ?? 1;
export const networthAt = (p: XPlayer, t: number) => at(p.playbackData.playerUpdateGoldEvents, t)?.networth ?? 0;
export const dist = (a: P, b: P) => Math.hypot(a.x - b.x, a.y - b.y);
/** День 0:00–5:00, ночь 5:00–10:00 и т. д. */
export const isNight = (t: number) => Math.floor(Math.max(0, t) / 300) % 2 === 1;
/** Обзор героя: днём ~1800, ночью ~800 ед. (вардов и зданий в данных нет — обзор скорее меньше настоящего) */
export const visionRange = (t: number) => (isNight(t) ? 800 : 1800);
/** Номер ячейки верхней панели (0–4 Силы Света, 5–9 Силы Тьмы): в данных STRATZ игроки идут по порядку слотов */
export const slotOf = (m: XMatch, p: XPlayer) => {
  const team = m.players.filter((q) => q.isRadiant === p.isRadiant);
  return (p.isRadiant ? 0 : 5) + team.indexOf(p);
};

// --- Драки (правда по данным матча, с будущим — только для оценки) ---
export interface Fight {
  /** Момент прогноза: за PREDICT_LEAD с до первой смерти */
  tp: number;
  first: number;
  last: number;
  center: P;
  /** Участники — индексы игроков в m.players */
  radiant: number[];
  dire: number[];
  deaths: { radiant: number; dire: number };
  /** Победитель — команда, потерявшая меньше героев; ничья — null */
  winner: 'radiant' | 'dire' | null;
}
/** Прогноз — за столько секунд до первой смерти (драка уже назревает, но исход ещё не ясен) */
export const PREDICT_LEAD = 8;
const FIGHT_GAP = 20, FIGHT_RADIUS = 2500, PARTICIPANT_RADIUS = 1800;

export function fightsOf(m: XMatch): Fight[] {
  const deaths = m.players
    .flatMap((p, i) => p.playbackData.deathEvents.map((d) => ({ t: d.time, i, pos: posAt(p, d.time) })))
    .filter((d): d is { t: number; i: number; pos: P } => d.pos !== null && d.t > 0)
    .sort((a, b) => a.t - b.t);
  const groups: { t0: number; t1: number; ds: typeof deaths }[] = [];
  for (const d of deaths) {
    const g = groups.at(-1);
    const c = g ? { x: g.ds.reduce((s, q) => s + q.pos.x, 0) / g.ds.length, y: g.ds.reduce((s, q) => s + q.pos.y, 0) / g.ds.length } : null;
    if (g && c && d.t - g.t1 <= FIGHT_GAP && dist(c, d.pos) <= FIGHT_RADIUS) {
      g.ds.push(d);
      g.t1 = d.t;
    } else groups.push({ t0: d.t, t1: d.t, ds: [d] });
  }
  return groups.map((g) => {
    const center = { x: g.ds.reduce((s, q) => s + q.pos.x, 0) / g.ds.length, y: g.ds.reduce((s, q) => s + q.pos.y, 0) / g.ds.length };
    const tp = g.t0 - PREDICT_LEAD;
    // Участник — жив в момент прогноза и хотя бы раз за драку был ближе PARTICIPANT_RADIUS к её центру
    const part = m.players
      .map((p, i) => ({ p, i }))
      .filter(({ p }) => !deadAt(p, tp))
      .filter(({ p }) => {
        for (let t = tp; t <= g.t1; t += 2) {
          const q = posAt(p, t);
          if (q && dist(q, center) <= PARTICIPANT_RADIUS) return true;
        }
        return false;
      });
    const radiant = part.filter((x) => x.p.isRadiant).map((x) => x.i), dire = part.filter((x) => !x.p.isRadiant).map((x) => x.i);
    const dr = g.ds.filter((d) => m.players[d.i]!.isRadiant).length, dd = g.ds.length - dr;
    return { tp, first: g.t0, last: g.t1, center, radiant, dire, deaths: { radiant: dr, dire: dd }, winner: dr < dd ? 'radiant' : dd < dr ? 'dire' : null };
  });
}

// --- Ошибки зрения (docs/VISION_ACCURACY.md, свой матч 2026-10-18) ---
export const VISION_NOISE = {
  /** Значок видимого врага на мини-карте не найден (пропущено 3,2% + отброшено) */
  minimapMissEnemy: 0.04,
  minimapMissAlly: 0.02,
  /** Разброс позиции значка, ед. */
  minimapJitter: 80,
  /** Полоска врага рядом не найдена (перекрытия, эффекты): 22,8% */
  barMissEnemy: 0.23,
  barMissOwn: 0.1,
  /** Уровень на найденной полоске не прочитан: ~30% */
  levelUnread: 0.3,
  /** Ошибка HP полоски, п.п. (медиана 2) */
  hpJitter: 2,
};

/** Детерминированный генератор случайных чисел (одинаковый экзамен при повторе) */
export function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

let blankHud: HudReading | null = null;
/** Нижняя панель и часы: настоящее распознавание пустого кадра — всё «не прочитано», остальное даёт GSI */
function blankReading(): HudReading {
  if (!blankHud) {
    const frame = { width: 1920, height: 1080, read: (r: { w: number; h: number }) => ({ width: r.w, height: r.h, data: new Uint8ClampedArray(r.w * r.h * 4) }) };
    blankHud = recognizeHud(frame as never, data('hud-layouts/dota2-default-16x9.json'), data('hud-layouts/glyphs-default.json'), 0);
  }
  return blankHud;
}

const heroKeyById = new Map((heroNames.names as { id: number; key: string }[]).map((h) => [h.id, h.key]));
const INV = [['item0', 'slot0'], ['item1', 'slot1'], ['item2', 'slot2'], ['item3', 'slot3'], ['item4', 'slot4'], ['item5', 'slot5'], ['backPack0', 'slot6'], ['backPack1', 'slot7'], ['backPack2', 'slot8'], ['teleport0', 'teleport0'], ['neutral0', 'neutral0']] as const;

/**
 * Путь «как в игре» для одного героя матча: на каждой секунде — тело GSI своего героя и чтение зрения → модель
 * состояния матча → вход коуча (CoachInput, как его шлёт движок в main).
 */
export class GamePipeline {
  private readonly model = new MatchStateModel();
  private readonly modeTracker = new GameModeTracker();
  private readonly lastSeen = new Map<number, number>();
  private readonly rnd: () => number;
  readonly me: XPlayer;
  readonly meIdx: number;
  readonly team: 'radiant' | 'dire';

  constructor(
    readonly m: XMatch,
    meIdx: number,
    readonly turbo: boolean,
    private readonly itemKey: Map<number, string>,
    seed: number,
    private readonly noise = VISION_NOISE,
  ) {
    this.meIdx = meIdx;
    this.me = m.players[meIdx]!;
    this.team = this.me.isRadiant ? 'radiant' : 'dire';
    this.rnd = rng(seed);
  }

  /** Первая секунда: подготовка (часы −90 в обычной игре, −60 в Турбо — по ним коуч узнаёт режим) */
  get startClock(): number {
    return this.turbo ? -60 : -90;
  }

  wallMs(t: number): number {
    return 2_000_000_000_000 + (t + 100) * 1000;
  }

  /** Тело GSI своего героя на секунде t (без ников и steamid — как пишет Dota, они коучу не нужны) */
  gsiBody(t: number): Record<string, unknown> {
    const me = this.me, m = this.m;
    const pos = posAt(me, t);
    const hp = at(me.playbackData.playerUpdateHealthEvents, t);
    const gold = at(me.playbackData.playerUpdateGoldEvents, t);
    const kills = (radiant: boolean) => m.players.filter((p) => p.isRadiant === radiant).reduce((s, p) => s + p.playbackData.killEvents.filter((k) => k.time <= t).length, 0);
    const dead = deadAt(me, t);
    const key = heroKeyById.get(me.heroId) ?? 'antimage';
    const inv = at(me.playbackData.inventoryEvents, t);
    const items: Record<string, unknown> = {};
    for (const [from, slot] of INV) {
      const it = inv?.[from];
      const k = it ? this.itemKey.get(it.itemId) : undefined;
      // Перезарядок в данных STRATZ нет: предметы «готовы», Town Portal Scroll — без перезарядки неизвестно
      items[slot] = k ? { name: `item_${k}`, purchaser: 0, can_cast: true, passive: false, charges: it!.charges ?? undefined, cooldown: slot === 'teleport0' ? undefined : 0 } : { name: 'empty' };
    }
    const teamSlot = slotOf(m, me) % 5;
    return {
      provider: { name: 'Dota 2', appid: 570, version: 47, timestamp: Math.floor(this.wallMs(t) / 1000) },
      map: {
        name: 'start',
        matchid: String(m.id),
        game_time: t + (this.turbo ? 60 : 90),
        clock_time: t,
        daytime: !isNight(t),
        nightstalker_night: false,
        radiant_score: kills(true),
        dire_score: kills(false),
        game_state: t < 0 ? 'DOTA_GAMERULES_STATE_PRE_GAME' : 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
        paused: false,
        win_team: 'none',
        customgamename: '',
        ward_purchase_cooldown: 0,
      },
      player: {
        activity: 'playing',
        kills: me.playbackData.killEvents.filter((k) => k.time <= t).length,
        deaths: me.playbackData.deathEvents.filter((d) => d.time <= t).length,
        assists: 0,
        last_hits: 0,
        denies: 0,
        kill_streak: 0,
        commands_issued: 0,
        kill_list: {},
        team_name: this.team,
        player_slot: teamSlot + (this.team === 'dire' ? 5 : 0),
        team_slot: teamSlot,
        gold: gold?.gold ?? 600,
        gold_reliable: 0,
        gold_unreliable: gold?.gold ?? 600,
        gpm: t > 60 ? Math.round(((gold?.networth ?? 600) / t) * 60) : 0,
        xpm: 0,
      },
      hero: {
        xpos: pos ? Math.round(pos.x) : 0,
        ypos: pos ? Math.round(pos.y) : 0,
        id: me.heroId,
        name: `npc_dota_hero_${key}`,
        level: levelAt(me, t),
        alive: !dead,
        respawn_seconds: respawnIn(me, t),
        buyback_cost: 0,
        buyback_cooldown: 0,
        health: dead ? 0 : (hp?.hp ?? 600),
        max_health: hp?.maxHp ?? 600,
        health_percent: dead ? 0 : Math.round(((hp?.hp ?? 600) / Math.max(1, hp?.maxHp ?? 600)) * 100),
        mana: hp?.mp ?? 300,
        max_mana: hp?.maxMp ?? 300,
        mana_percent: Math.round(((hp?.mp ?? 300) / Math.max(1, hp?.maxMp ?? 300)) * 100),
        silenced: false,
        stunned: false,
        disarmed: false,
        magicimmune: false,
        hexed: false,
        muted: false,
        break: false,
        smoked: false,
        has_debuff: false,
      },
      // Нет инвентаря в данных STRATZ — предметов в теле нет (коуч честно «не знает» их), а не пустые слоты:
      // пустые слоты значили бы «предметов нет», и признак «стадия по предметам» учился бы на неправде
      ...(me.playbackData.inventoryEvents?.length ? { items } : {}),
    };
  }

  /** Что «увидело бы» зрение на секунде t: туман войны по обзору своих героев, камера у своего героя, ошибки зрения */
  vision(t: number): { topBar: TopBarReading; minimap: MinimapReading; healthBars: HealthBarsReading } {
    const m = this.m, me = this.me, n = this.noise, r = this.rnd;
    const myPos = posAt(me, t);
    const meAlive = !deadAt(me, t);
    const allies = m.players.filter((p) => p.isRadiant === me.isRadiant);
    const watchers = allies.filter((p) => !deadAt(p, t)).map((p) => posAt(p, t)).filter((x): x is P => x !== null);
    const range = visionRange(t);
    const side = (p: XPlayer) => (p.isRadiant === me.isRadiant ? 'ally' : 'enemy') as 'ally' | 'enemy';
    const topBar: TopBarReading = {
      supported: true,
      durationMs: 0,
      slots: m.players.map((p) => {
        const dead = deadAt(p, t);
        return { slot: slotOf(m, p), team: p.isRadiant ? 'radiant' : 'dire', side: side(p), heroKey: heroKeyById.get(p.heroId) ?? null, heroConfidence: 0.9, alive: !dead, aliveConfidence: 0.95, respawnSec: dead ? respawnIn(p, t) : null, respawnConfidence: dead ? 0.9 : 0 };
      }),
    };
    const heroes: MinimapReading['heroes'] = [];
    const bars: HealthBarsReading['bars'] = [];
    m.players.forEach((p, i) => {
      if (deadAt(p, t)) return;
      const q = posAt(p, t);
      if (!q) return;
      const ally = p.isRadiant === me.isRadiant;
      const seen = ally || watchers.some((w) => dist(w, q) <= range);
      if (!seen) return;
      if (r() >= (ally ? n.minimapMissAlly : n.minimapMissEnemy)) {
        const jx = (r() - 0.5) * 2 * n.minimapJitter, jy = (r() - 0.5) * 2 * n.minimapJitter;
        heroes.push({ slot: slotOf(m, p), team: p.isRadiant ? 'radiant' : 'dire', x: q.x + jx, y: q.y + jy, px: 0, py: 0, confidence: 0.8, ambiguous: false, others: [] });
      }
      // Полоска — герой на экране (камера у своего героя, ~1400 ед.), сам герой жив
      if (!meAlive || !myPos || dist(q, myPos) > 1400) return;
      if (r() < (i === this.meIdx ? n.barMissOwn : ally ? n.barMissOwn : n.barMissEnemy)) return;
      const h = at(p.playbackData.playerUpdateHealthEvents, t);
      const hpPct = h ? (100 * h.hp) / Math.max(1, h.maxHp) : 100;
      const lvl = r() < n.levelUnread ? null : levelAt(p, t);
      bars.push({ color: ally ? 'green' : 'red', hpPercent: Math.max(0, Math.min(100, Math.round(hpPct + (r() - 0.5) * 2 * n.hpJitter))), level: lvl, levelConfidence: lvl === null ? 0 : 0.8, x: 0, y: 0, length: 100, confidence: 0.9 });
    });
    return { topBar, minimap: { supported: true, heroes, rect: null, durationMs: 0 }, healthBars: { supported: true, bars, durationMs: 0 } };
  }

  /** Одна секунда: GSI → зрение → снимок матча → вход коуча */
  tick(t: number): CoachInput {
    const w = this.wallMs(t);
    const body = this.gsiBody(t);
    // Как в настоящей игре: перед подготовкой Dota присылает выбор героев — по переходу и часам −1:00 коуч узнаёт
    // Турбо (без него Турбо оставался «неизвестным», и экзамены кругов 1–2 шли в Турбо с моделью All Pick)
    if (t === this.startClock) this.modeTracker.feed({ ...body, map: { ...(body.map as object), game_state: 'DOTA_GAMERULES_STATE_STRATEGY_TIME' } }, w - 1000);
    const mode = this.modeTracker.feed(body, w);
    const raw = readGsi(body);
    const reading = raw ? { ...raw, gameMode: mode } : null;
    if (reading) this.model.ingestGsi(reading, w);
    const v = this.vision(t);
    this.model.ingest({ ...blankReading(), ...v, durationMs: 0 }, w + 5);
    return { state: this.model.snapshot(w + 5), gsi: reading, gsiWallMs: w, notOwnMatch: false } as CoachInput;
  }
}
