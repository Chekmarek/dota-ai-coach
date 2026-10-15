// Данные для тестов ИИ: база знаний из resources/data/kb и состояния матча (GSI-фикстуры и «кадры» записи).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KbHero, KbItem, KbMeta, KnowledgeBase } from '../../src/shared/types/kb';
import { parseMechanics } from '../../src/shared/types/mechanics';
import { auditItems } from '../../src/core/knowledge-base/audit';
import { mapGsi } from '../../src/core/gsi/index';
import { MatchStateModel, type MatchState } from '../../src/core/match-state/index';
import type { TopBarReading } from '../../src/core/vision/top-bar';
import heroNames from '../../src/data/hero-names.json';
import itemTemplates from '../../src/data/item-templates.json';

const ROOT = join(import.meta.dirname, '../..');
const json = <T>(f: string): T => JSON.parse(readFileSync(join(ROOT, f), 'utf8')) as T;

let kbCache: KnowledgeBase | null = null;
export function loadKb(): KnowledgeBase {
  if (kbCache) return kbCache;
  const patch = json<{ patch: string }>('resources/data/kb/current.json').patch;
  const dir = `resources/data/kb/${patch}`;
  const items = json<KbItem[]>(`${dir}/items.json`);
  const mech = parseMechanics(json<unknown>(`${dir}/mechanics.json`));
  kbCache = {
    meta: json<KbMeta>(`${dir}/meta.json`),
    heroes: json<KbHero[]>(`${dir}/heroes.json`),
    items,
    audit: auditItems(items),
    copy: 'asar',
    mechanics: mech.file?.entries ?? [],
    mechanicsWarnings: mech.warnings,
  };
  return kbCache;
}

const itemName = new Map((itemTemplates as unknown as { items: { key: string; name: string }[] }).items.map((i) => [i.key, i.name]));
const heroByKey = new Map((heroNames.names as { id: number; key: string; name: string }[]).map((h) => [h.key, { id: h.id, name: h.name }]));

export function gsiReading(name: string) {
  const r = mapGsi(json(`tests/fixtures/gsi/${name}.json`), (k) => itemName.get(k), (k) => heroByKey.get(k));
  if (!r) throw new Error(name);
  return r;
}

const HEROES = ['antimage', 'nevermore', 'pudge', 'lion', 'axe', 'juggernaut', 'lina', 'earthshaker', 'witch_doctor', 'zuus'];

function topBar(deadSlot: number | null): TopBarReading {
  return {
    supported: true,
    durationMs: 1,
    slots: HEROES.map((heroKey, slot) => ({
      slot,
      team: slot < 5 ? ('radiant' as const) : ('dire' as const),
      side: null,
      heroKey,
      heroConfidence: 0.9,
      alive: slot !== deadSlot,
      aliveConfidence: 0.9,
      respawnSec: slot === deadSlot ? 20 : null,
      respawnConfidence: 0.9,
    })),
  };
}

const none = { value: null, confidence: 0, validity: 'unreadable' as const, rect: { x: 0, y: 0, w: 0, h: 0 }, raw: '' };
const ok = <T>(value: T) => ({ value, confidence: 0.97, validity: 'valid' as const, rect: { x: 0, y: 0, w: 1, h: 1 }, raw: '' });

/** Чтение экрана: только перечисленные поля видны */
function hud(fields: Record<string, unknown>, hero: { id: number; name: string } | null, deadSlot: number | null = null) {
  return {
    layoutId: 't',
    frameSize: { w: 1920, h: 1080 },
    supported: true,
    fields: new Proxy({}, { get: (_t, k: string) => (k in fields ? ok(fields[k]) : none) }),
    selectedUnit: hero ? ok('ally') : none,
    heroName: hero ? ok(hero) : none,
    dayNight: none,
    abilities: null,
    items: null,
    heroNameCandidates: [],
    durationMs: 1,
    topBar: topBar(deadSlot),
  } as never;
}

/** Живая игра: GSI «линия» (Shadow Fiend, 8:05) + верхняя панель, Lina (ячейка 6) мертва */
export function laningState(): MatchState {
  const m = new MatchStateModel();
  m.ingestGsi(gsiReading('laning'), 1000);
  for (let i = 0; i < 6; i++) m.ingest(hud({}, null, 6), 1100 + i * 200);
  return m.snapshot(2500);
}

/** Свой герой мёртв (GSI) */
export function deadState(): MatchState {
  const m = new MatchStateModel();
  m.ingestGsi(gsiReading('laning'), 1000);
  m.ingestGsi(gsiReading('dead-respawn'), 2000);
  return m.snapshot(2500);
}

/** «Разбор записи»: только экран (без GSI) — часы, золото, уровень, У/С/П; уровень 7 → 8 и одна смерть */
export function replayState(): MatchState {
  const m = new MatchStateModel();
  const sf = heroByKey.get('nevermore')!;
  let t = 0;
  for (let i = 0; i < 12; i++, t += 1000)
    m.ingest(hud({ gameClock: 600 + i, gold: 900 + i * 10, level: 7, kda: { kills: 2, deaths: 0, assists: 1 }, farm: { lastHits: 40, denies: 6 } }, sf), t);
  for (let i = 0; i < 12; i++, t += 1000)
    m.ingest(hud({ gameClock: 612 + i, gold: 1100, level: 8, kda: { kills: 2, deaths: 1, assists: 1 }, farm: { lastHits: 41, denies: 6 } }, sf), t);
  return m.snapshot(t);
}

export type EvalContext = 'none' | 'laning' | 'dead' | 'replay';

export function stateFor(c: EvalContext): MatchState | null {
  if (c === 'laning') return laningState();
  if (c === 'dead') return deadState();
  if (c === 'replay') return replayState();
  return null;
}
