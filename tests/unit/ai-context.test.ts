import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AI_CONTEXT_SCHEMA, AI_CONTEXT_VERSION, buildAiContext, fact, type AiContext, type Fact } from '../../src/core/ai/context.ts';
import { mapGsi } from '../../src/core/gsi/index.ts';
import { MatchStateModel, mapZone } from '../../src/core/match-state/index.ts';
import { parseMechanics } from '../../src/shared/types/mechanics.ts';
import type { TopBarReading } from '../../src/core/vision/top-bar.ts';

const ROOT = join(import.meta.dirname, '../..');
const gsi = (name: string) => {
  const r = mapGsi(JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/gsi', `${name}.json`), 'utf8')));
  if (!r) throw new Error(name);
  return r;
};
const patch = JSON.parse(readFileSync(join(ROOT, 'resources/data/kb/current.json'), 'utf8')).patch as string;
const mechanics = parseMechanics(JSON.parse(readFileSync(join(ROOT, 'resources/data/kb', patch, 'mechanics.json'), 'utf8'))).file!.entries;

/** Каждое значение схемы — либо известно (value, confidence, ageSec, tag, source), либо null с причиной */
function expectFactShape(f: Fact<unknown>, path: string) {
  if (f.value === null) {
    expect(typeof (f as { reason?: unknown }).reason, `${path}: у неизвестного должна быть причина`).toBe('string');
    expect(Object.keys(f).sort(), path).toEqual(['reason', 'value']);
  } else {
    expect(Object.keys(f).sort(), path).toEqual(['ageSec', 'confidence', 'source', 'tag', 'value']);
    expect(['visible', 'remembered', 'inferred'], path).toContain((f as { tag: string }).tag);
  }
}

function allFacts(c: AiContext): [string, Fact<unknown>][] {
  const out: [string, Fact<unknown>][] = [];
  for (const [k, v] of Object.entries(c.match)) if (k !== 'paused') out.push([`match.${k}`, v as Fact<unknown>]);
  for (const [k, v] of Object.entries(c.myHero)) out.push([`myHero.${k}`, v as Fact<unknown>]);
  for (const p of c.players) for (const k of ['hero', 'alive', 'respawnAtSec', 'position', 'hpPercent'] as const) out.push([`players[${p.slot}].${k}`, p[k]]);
  return out;
}

const topBar = (deadSlot: number | null = null): TopBarReading => ({
  supported: true,
  durationMs: 1,
  slots: Array.from({ length: 10 }, (_, slot) => ({
    slot,
    team: slot < 5 ? ('radiant' as const) : ('dire' as const),
    side: null,
    heroKey: ['antimage', 'nevermore', 'pudge', 'lion', 'axe', 'juggernaut', 'lina', 'earthshaker', 'witch_doctor', 'zuus'][slot]!,
    heroConfidence: 0.9,
    alive: slot !== deadSlot,
    aliveConfidence: 0.9,
    respawnSec: slot === deadSlot ? 20 : null,
    respawnConfidence: 0.9,
  })),
});

describe('контекст для ИИ: схема', () => {
  it('пустая модель: всё неизвестно и с причиной, ничего не угадано', () => {
    const c = buildAiContext(new MatchStateModel().snapshot(1000), null);
    expect(c).toMatchObject({ schema: AI_CONTEXT_SCHEMA, version: AI_CONTEXT_VERSION, players: [] });
    expect(c.myHero.hero).toEqual({ value: null, reason: 'hero-not-identified' });
    expect(c.myTeam).toEqual({ value: null, reason: 'team-unknown' });
    expect(c.match.clockSec).toEqual({ value: null, reason: 'never-observed' });
    expect(c.timers).toEqual({ value: null, reason: 'no-knowledge-base' });
    for (const [path, f] of allFacts(c)) expectFactShape(f, path);
  });

  it('данные из игры и верхняя панель: свой герой и команда из GSI, игроки с экрана, таймеры из базы знаний', () => {
    const m = new MatchStateModel();
    m.ingestGsi(gsi('laning'), 1000);
    for (let i = 0; i < 6; i++) m.ingest({ ...(baseHud() as object), topBar: topBar(6) } as never, 1100 + i * 200);
    const c = buildAiContext(m.snapshot(2500), mechanics);
    expect(c.myHero.hero.value).not.toBeNull();
    expect(c.myHero.level).toMatchObject({ source: 'gsi', ageSec: 1.5 });
    expect(c.myTeam.value).not.toBeNull();
    expect(c.players).toHaveLength(10);
    const dead = c.players[6]!;
    expect(dead.alive).toMatchObject({ value: false, source: 'screen' });
    expect(dead.respawnAtSec.value).not.toBeNull();
    // Живому время возрождения не нужно; здоровье без привязанной полоски — «не привязано», а не 100 %
    expect(c.players[0]!.respawnAtSec).toEqual({ value: null, reason: 'not-applicable' });
    expect(c.players[0]!.hpPercent).toEqual({ value: null, reason: 'not-linked' });
    expect(c.players[0]!.position).toEqual({ value: null, reason: 'never-observed' });
    expect('upcoming' in c.timers && c.timers.upcoming.length).toBeGreaterThan(0);
    for (const [path, f] of allFacts(c)) expectFactShape(f, path);
    // Схема — обычный JSON: переживает сериализацию без потерь
    expect(JSON.parse(JSON.stringify(c))).toEqual(c);
  });

  it('устаревшее значение — «expired», а не последнее известное', () => {
    expect(fact({ value: null, confidence: 0, tag: 'unknown', lastSeenWallMs: 500, firstSeenWallMs: 500, source: 'screen' }, 1000)).toEqual({
      value: null,
      reason: 'expired',
    });
    expect(fact({ value: 7, confidence: 0.876, tag: 'remembered', lastSeenWallMs: 1000, firstSeenWallMs: 900, source: 'screen' }, 4000)).toEqual({
      value: 7,
      confidence: 0.88,
      ageSec: 3,
      tag: 'remembered',
      source: 'screen',
    });
  });

  it('область карты по координатам', () => {
    expect(mapZone(-7000, -6500)).toBe('radiant-base');
    expect(mapZone(6800, 6200)).toBe('dire-base');
    expect(mapZone(0, 0)).toBe('mid-lane');
    expect(mapZone(-6500, 3000)).toBe('top-lane');
    expect(mapZone(6500, -3000)).toBe('bot-lane');
    expect(mapZone(-3000, 3000)).toBe('river');
    expect(mapZone(-4000, -1000)).toBe('radiant-jungle');
    expect(mapZone(3500, 300)).toBe('dire-jungle');
  });
});

/** Чтение HUD без полей (всё «не прочитано»): нужно только для верхней панели */
function baseHud() {
  const none = { value: null, confidence: 0, validity: 'unreadable' as const, rect: { x: 0, y: 0, w: 0, h: 0 } };
  return {
    layoutId: 't',
    frameSize: { w: 1920, h: 1080 },
    supported: true,
    fields: new Proxy({}, { get: () => none }),
    selectedUnit: none,
    heroName: none,
    dayNight: none,
    abilities: null,
    items: null,
    heroNameCandidates: [],
    durationMs: 1,
  };
}
