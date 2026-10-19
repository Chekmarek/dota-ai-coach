// «Плохой совет»: игрок нажал горячую клавишу — коуч сохраняет, что было на экране и что он знал о матче
// за последние 15 с (для разбора). Снимок собирается только из перечисленных полей CoachView: ников, steamid,
// чата и сырых тел GSI в нём нет и быть не может (в CoachView их тоже нет, но список полей — вторая защита).
import type { CoachView, ViewPlayer } from './view.ts';
import type { GameContext } from './game-context.ts';
import { nearEnemyCount } from './memory.ts';
import type { HudHint } from '../../shared/types/hud.ts';

/** Сколько секунд состояния матча до нажатия сохраняется */
export const BAD_ADVICE_WINDOW_MS = 15_000;
export const BAD_ADVICE_SCHEMA = 'dota-coach.bad-advice';

const r1 = (n: number | null | undefined) => (typeof n === 'number' && Number.isFinite(n) ? Math.round(n * 10) / 10 : null);
const pt = (p: { x: number; y: number } | null) => (p ? { x: Math.round(p.x), y: Math.round(p.y) } : null);

export interface BadAdvicePlayer {
  slot: number;
  side: 'ally' | 'enemy' | null;
  hero: string | null;
  alive: boolean | null;
  pos: { x: number; y: number } | null;
  /** Секунд с последнего подтверждения позиции */
  posAgeSec: number | null;
  hpPercent: number | null;
  missing: boolean | null;
  missingForSec: number | null;
  barLevel: number | null;
}

export interface BadAdviceSnapshot {
  wallMs: number;
  clock: number | null;
  inGame: boolean;
  sources: { gsi: boolean; screen: boolean };
  stage: string | null;
  position: number | null;
  me: {
    hero: string | null;
    level: number | null;
    alive: boolean | null;
    respawnSec: number | null;
    hp: { current: number; max: number } | null;
    mana: { current: number; max: number } | null;
    gold: number | null;
    pos: { x: number; y: number } | null;
    zone: string | null;
    items: { slot: string; key: string; cooldownSec: number | null }[];
    abilities: { key: string | null; level: number | null; state: string | null; cooldownSec: number | null }[];
  };
  allies: BadAdvicePlayer[];
  enemies: BadAdvicePlayer[];
  /** Врагов рядом — как считает коуч (мини-карта и полоски) */
  enemiesNear: number;
  screen: { meOnScreen: boolean; enemyBars: { hpPercent: number; level: number | null }[] };
}

function player(p: ViewPlayer): BadAdvicePlayer {
  return {
    slot: p.slot,
    side: p.side,
    hero: p.hero.value,
    alive: p.alive.value,
    pos: pt(p.pos.value),
    posAgeSec: r1(p.pos.ageSec),
    hpPercent: r1(p.hpPercent.value),
    missing: p.missing,
    missingForSec: r1(p.missingForSec),
    barLevel: p.barLevel,
  };
}

/** Снимок для отметки — только перечисленные поля */
export function badAdviceSnapshot(v: CoachView, g: GameContext | null): BadAdviceSnapshot {
  const hp = v.me.hp.value, mana = v.me.mana.value;
  return {
    wallMs: v.wallMs,
    clock: r1(v.clock.value),
    inGame: v.inGame,
    sources: { gsi: v.sources.gsi, screen: v.sources.screen },
    stage: g?.stage ?? null,
    position: g?.position ?? null,
    me: {
      hero: v.me.hero.value?.key ?? null,
      level: v.me.level.value,
      alive: v.me.alive.value,
      respawnSec: v.me.respawnSec.value,
      hp: hp ? { current: Math.round(hp.current), max: Math.round(hp.max) } : null,
      mana: mana ? { current: Math.round(mana.current), max: Math.round(mana.max) } : null,
      gold: v.me.gold.value,
      pos: pt(v.me.pos.value),
      zone: v.me.zone,
      items: v.me.items.map((i) => ({ slot: i.slot, key: i.key, cooldownSec: r1(i.cooldownSec) })),
      abilities: v.me.abilities.map((a) => ({ key: a.key, level: a.level, state: a.state, cooldownSec: r1(a.cooldownSec) })),
    },
    allies: v.allies.map(player),
    enemies: v.enemies.map(player),
    enemiesNear: nearEnemyCount(v),
    screen: { meOnScreen: v.screen.meOnScreen, enemyBars: v.screen.enemyBars.map((b) => ({ hpPercent: Math.round(b.hpPercent), level: b.level })) },
  };
}

/** Последние снимки за окно BAD_ADVICE_WINDOW_MS */
export class SnapshotRing {
  private items: BadAdviceSnapshot[] = [];
  push(s: BadAdviceSnapshot): void {
    this.items.push(s);
    const from = s.wallMs - BAD_ADVICE_WINDOW_MS;
    while (this.items.length && this.items[0]!.wallMs < from) this.items.shift();
  }
  /** Снимки не старше окна к моменту now */
  window(now: number): BadAdviceSnapshot[] {
    return this.items.filter((s) => s.wallMs >= now - BAD_ADVICE_WINDOW_MS && s.wallMs <= now);
  }
  clear(): void {
    this.items = [];
  }
}

export interface BadAdviceHint {
  seq: number;
  category: string;
  priority: string;
  title: string;
  text: string;
  percent: number | null;
  source: string;
  icon: string | null;
}

export const toBadAdviceHint = (h: HudHint): BadAdviceHint => ({
  seq: h.seq,
  category: h.category,
  priority: h.priority,
  title: h.title,
  text: h.text,
  percent: h.percent?.value ?? null,
  source: h.source,
  icon: h.icon,
});

export interface BadAdviceRecord {
  schema: typeof BAD_ADVICE_SCHEMA;
  version: 1;
  /** Имя файла без .json: <время отметки>-<id матча> */
  id: string;
  /** Запуск коуча, в котором сделана отметка */
  sessionId: string;
  markedAt: string;
  appVersion: string | null;
  matchId: string | null;
  /** Файл матча в «Истории советов» */
  historyId: string | null;
  hero: string | null;
  gameMode: string | null;
  /** Игровое время нажатия, с */
  clock: number | null;
  /** Подсказки на экране в момент нажатия */
  onScreen: BadAdviceHint[];
  /** Все подсказки, показанные за последние 15 с (могли исчезнуть до нажатия) */
  recent: BadAdviceHint[];
  snapshots: BadAdviceSnapshot[];
}

/** Краткая запись об отметке в файле матча «Истории советов» */
export interface BadAdviceMark {
  id: string;
  markedAt: string;
  clock: number | null;
  titles: string[];
}

const mmss = (s: number | null) => (s === null ? '—' : `${s < 0 ? '-' : ''}${Math.floor(Math.abs(s) / 60)}:${String(Math.floor(Math.abs(s) % 60)).padStart(2, '0')}`);

/**
 * Все отметки в один Markdown для разбора (scripts/collect-bad-advice.mjs): по каждой — подсказки, кратко
 * последнее состояние и полный JSON снимков.
 */
export function badAdviceReport(records: BadAdviceRecord[], title: string): string {
  const out = [`# ${title}`, '', `Отметок: ${records.length}. Формат каждой: что было на экране, кратко последнее состояние, полный JSON (снимки за 15 с до нажатия, примерно 2 в секунду).`, ''];
  records.forEach((r, i) => {
    const last = r.snapshots.at(-1) ?? null;
    out.push(`## ${i + 1}. ${mmss(r.clock)} — ${r.hero ?? 'герой ?'} (матч ${r.matchId ?? '?'}, ${r.gameMode ?? 'режим ?'})`, '');
    out.push(`Отмечено: ${r.markedAt}; история: ${r.historyId ?? '—'}`, '');
    out.push('**На экране:**');
    if (!r.onScreen.length) out.push('- (пусто)');
    for (const h of r.onScreen) out.push(`- [${h.category}/${h.priority}] ${h.title}${h.text ? ` — ${h.text}` : ''}${h.percent !== null ? ` (${h.percent}%)` : ''}`);
    const gone = r.recent.filter((h) => !r.onScreen.some((o) => o.seq === h.seq));
    if (gone.length) {
      out.push('', '**Показаны за 15 с до нажатия и уже исчезли:**');
      for (const h of gone) out.push(`- [${h.category}/${h.priority}] ${h.title}${h.text ? ` — ${h.text}` : ''}`);
    }
    if (last) {
      const me = last.me;
      out.push('', '**Последнее состояние:**');
      out.push(`- стадия ${last.stage ?? '?'}, позиция ${last.position ?? '?'}; источники: GSI ${last.sources.gsi ? 'да' : 'нет'}, экран ${last.sources.screen ? 'да' : 'нет'}`);
      out.push(`- я: ${me.hero ?? '?'} ур. ${me.level ?? '?'}, ${me.alive === false ? `мёртв (${me.respawnSec ?? '?'} с)` : 'жив'}, HP ${me.hp ? `${me.hp.current}/${me.hp.max}` : '?'}, мана ${me.mana ? `${me.mana.current}/${me.mana.max}` : '?'}, золото ${me.gold ?? '?'}, место ${me.pos ? `${me.pos.x},${me.pos.y}` : '?'} (${me.zone ?? '?'})`);
      out.push(`- врагов рядом (по коучу): ${last.enemiesNear}; полоски врагов на экране: ${last.screen.enemyBars.map((b) => `${b.hpPercent}%/ур.${b.level ?? '?'}`).join(', ') || 'нет'}`);
      out.push(`- враги: ${last.enemies.map((e) => `${e.hero ?? '?'}${e.alive === false ? ' (мёртв)' : ''}${e.pos ? ` @${e.pos.x},${e.pos.y} (${e.posAgeSec ?? '?'} с)` : e.missing ? ` пропал ${e.missingForSec ?? '?'} с` : ''}`).join('; ') || '?'}`);
    }
    out.push('', '<details><summary>JSON</summary>', '', '```json', JSON.stringify(r, null, 1), '```', '', '</details>', '');
  });
  return out.join('\n');
}
