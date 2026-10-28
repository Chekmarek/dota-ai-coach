// Экран выбора героев: чтение больших портретов (vision/draft-screen.ts) и составы команд в модели (match-state/draft.ts).
// Настоящие кадры — две записи драфта владельца (полоса портретов, без ников): tests/fixtures/hud/draft-*. Они не в
// общем репозитории — без них эта часть пропускается, а проверки на искусственных чтениях идут всегда.
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodePng } from '../../scripts/png.mjs';
import { frameAccessFromImage } from '../../src/core/vision/image.ts';
import { readDraftScreen, type DraftScreenReading } from '../../src/core/vision/draft-screen.ts';
import type { HudLayout } from '../../src/core/vision/hud-layout.ts';
import type { PortraitTemplates } from '../../src/core/vision/top-bar.ts';
import { DraftTrack, DRAFT_NEW_AFTER_MS } from '../../src/core/match-state/draft.ts';

const ROOT = join(import.meta.dirname, '../..');
const json = (f: string) => JSON.parse(readFileSync(join(ROOT, f), 'utf8'));
const layout: HudLayout = json('src/data/hud-layouts/dota2-default-16x9.json');
const portraits: PortraitTemplates = json('src/data/hero-portraits.json');

/** Искусственное чтение: index → герой */
function reading(heroes: Record<number, string>): DraftScreenReading {
  return {
    supported: true,
    durationMs: 0,
    slots: Array.from({ length: 10 }, (_, index) => ({ index, team: index < 5 ? 'radiant' : 'dire', heroKey: heroes[index] ?? null, confidence: heroes[index] ? 0.9 : 0.1 })),
  };
}

describe('составы команд с экрана драфта', () => {
  it('герой принимается со второго одинакового чтения', () => {
    const d = new DraftTrack();
    d.ingest(reading({ 5: 'kez' }), 1000);
    expect(d.snapshot()).toBeNull();
    d.ingest(reading({ 5: 'kez' }), 2000);
    expect(d.snapshot()?.dire).toEqual(['kez']);
  });

  it('случайное совпадение на одном кадре не принимается', () => {
    const d = new DraftTrack();
    d.ingest(reading({ 2: 'razor' }), 1000);
    d.ingest(reading({}), 2000);
    d.ingest(reading({ 2: 'lina' }), 3000);
    expect(d.snapshot()).toBeNull();
  });

  it('своя команда — та, чьи пики видны, пока у другой все места закрыты; GSI важнее', () => {
    const d = new DraftTrack();
    for (let i = 0; i < 4; i++) d.ingest(reading({ 6: 'kez', 7: 'phantom_assassin' }), 1000 * i);
    expect(d.snapshot()?.ourTeam).toBe('dire');
    expect(d.snapshot()?.ourTeamSource).toBe('screen');
    d.setOurTeam('radiant');
    expect(d.snapshot()?.ourTeam).toBe('radiant');
    expect(d.snapshot()?.ourTeamSource).toBe('gsi');
  });

  it('после долгой паузы — новый драфт, прежние герои забыты', () => {
    const d = new DraftTrack();
    d.ingest(reading({ 0: 'lina' }), 0);
    d.ingest(reading({ 0: 'lina' }), 1000);
    const t = 1000 + DRAFT_NEW_AFTER_MS + 1;
    d.ingest(reading({ 1: 'rubick' }), t);
    d.ingest(reading({ 1: 'rubick' }), t + 1000);
    expect(d.snapshot()?.radiant).toEqual(['rubick']);
  });

  it('без раскладки или не 16:9 — «не поддерживается»', () => {
    const img = { width: 1280, height: 1024, data: new Uint8ClampedArray(1280 * 1024 * 4) };
    expect(readDraftScreen(frameAccessFromImage(img), layout, portraits).supported).toBe(false);
  });
});

const FIX = join(ROOT, 'tests/fixtures/hud');
const RECORDS = [
  {
    dir: 'draft-turbo',
    radiant: ['lina', 'nevermore', 'rubick', 'dark_willow', 'disruptor'],
    dire: ['kez', 'ogre_magi', 'phantom_assassin', 'storm_spirit', 'shadow_shaman'],
    // во время пиков видны только свои (Силы Тьмы), вражеские закрыты флажками
    ourTeam: 'dire',
  },
  {
    dir: 'draft-allpick',
    radiant: ['nevermore', 'earthshaker', 'bounty_hunter', 'skywrath_mage', 'luna'],
    dire: ['bloodseeker', 'bristleback', 'lion', 'death_prophet', 'crystal_maiden'],
    // запись началась с последних секунд пиков: своя команда по экрану не определяется (нужен GSI)
    ourTeam: null,
  },
] as const;

describe.skipIf(!existsSync(join(FIX, RECORDS[0].dir)))('настоящие записи драфта', () => {
  for (const r of RECORDS) {
    it(`${r.dir}: все 10 героев, без ошибок, своя команда`, () => {
      const d = new DraftTrack();
      const files = readdirSync(join(FIX, r.dir)).filter((f) => f.endsWith('.png')).sort();
      let wrong = 0;
      for (const f of files) {
        const res = readDraftScreen(frameAccessFromImage(decodePng(readFileSync(join(FIX, r.dir, f)))), layout, portraits);
        for (const s of res.slots) if (s.heroKey && !(r[s.team] as readonly string[]).includes(s.heroKey)) wrong++;
        d.ingest(res, Number(f.slice(1, 4)) * 1000);
      }
      expect(wrong).toBe(0);
      const snap = d.snapshot()!;
      expect([...snap.radiant].sort()).toEqual([...r.radiant].sort());
      expect([...snap.dire].sort()).toEqual([...r.dire].sort());
      expect(snap.ourTeam).toBe(r.ourTeam);
    }, 60_000);
  }
});
