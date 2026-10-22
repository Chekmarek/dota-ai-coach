// Звуковые сигналы на настоящих записях GSI (tests/fixtures/gsi/recorded): весь путь коуча, как в main
// (режим игры → модель матча → CoachService со звуком). Проверка «не раздражает»: сколько сигналов в минуту,
// промежутки, пачек нет. Журнал сигналов — с DOTACOACH_SOUND_LOG=1 (в консоль и .tmp/sound-replay-<запись>.md).
import { describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { GameModeTracker, mapGsi, type GsiReading } from '../../src/core/gsi/index.ts';
import { MatchStateModel } from '../../src/core/match-state/index.ts';
import { CoachService } from '../../src/main/coach/service';
import { defaultSettings } from '../../src/shared/schemas/settings.ts';
import { SOUND_CUE_IDS, SOUND_CUES, type SoundCueId } from '../../src/core/sound/cues.ts';
import { SOUND_MIN_GAP_MS } from '../../src/core/sound/director.ts';
import { realData } from './coach-sim.ts';

const root = join(import.meta.dirname, '../..');
const data = realData();
const kb = { get: () => ({ meta: { patch: '7.41f', verification: 'imported-unverified' }, heroes: data.heroes, items: data.items, mechanics: data.mechanics }) as never, stats: () => data.stats };

interface Played {
  ms: number;
  clock: number | null;
  cue: SoundCueId;
}

function replay(file: string) {
  const entries = readFileSync(join(root, 'tests/fixtures/gsi/recorded', file), 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { t: number; body: unknown });
  const tracker = new GameModeTracker();
  const model = new MatchStateModel();
  const settings = defaultSettings();
  let now = 0;
  let clock: number | null = null;
  const played: Played[] = [];
  const svc = new CoachService({ settings: { get: () => settings }, kb, aiProvider: () => null, history: { save() {} }, onHints: () => {}, onSound: (cue) => played.push({ ms: now, clock, cue }), now: () => now });
  let last: GsiReading | null = null;
  let lastMs: number | null = null;
  let firstClock: number | null = null;
  for (const e of entries) {
    now = e.t;
    const mode = tracker.feed(e.body, e.t);
    const r = mapGsi(e.body);
    if (r) {
      model.ingestGsi({ ...r, gameMode: mode }, e.t);
      last = r;
      lastMs = e.t;
      clock = r.clock ?? clock;
      if (r.clock !== null && r.clock >= 0 && firstClock === null) firstClock = r.clock;
    }
    svc.ingest({ state: model.snapshot(e.t), gsi: last, gsiWallMs: lastMs });
  }
  const minutes = clock !== null && firstClock !== null ? (clock - firstClock) / 60 : 0;
  return { played, minutes };
}

const mmss = (c: number | null) => (c === null ? '—' : `${c < 0 ? '−' : ''}${Math.floor(Math.abs(c) / 60)}:${String(Math.round(Math.abs(c) % 60)).padStart(2, '0')}`);

function report(name: string, r: ReturnType<typeof replay>): string {
  const by = Object.fromEntries(SOUND_CUE_IDS.map((id) => [id, r.played.filter((p) => p.cue === id).length]));
  const lines = [
    `# Звуковые сигналы: ${name}`,
    '',
    `Минут игры: ${r.minutes.toFixed(1)}; сигналов: ${r.played.length}; в минуту: ${(r.played.length / Math.max(1, r.minutes)).toFixed(2)}`,
    '',
    '| Сигнал | Сколько | В минуту |',
    '|---|---|---|',
    ...SOUND_CUE_IDS.map((id) => `| ${SOUND_CUES[id].nameRu} | ${by[id]} | ${(by[id]! / Math.max(1, r.minutes)).toFixed(2)} |`),
    '',
    '| Время игры | Сигнал |',
    '|---|---|',
    ...r.played.map((p) => `| ${mmss(p.clock)} | ${SOUND_CUES[p.cue].nameRu} |`),
  ];
  return lines.join('\n');
}

describe.each(['turbo-bristleback.jsonl', 'demo-antimage.jsonl'])('звуковые сигналы на записи %s', (file) => {
  const r = replay(file);
  if (process.env.DOTACOACH_SOUND_LOG) {
    const text = report(file, r);
    mkdirSync(join(root, '.tmp'), { recursive: true });
    writeFileSync(join(root, `.tmp/sound-replay-${file.replace('.jsonl', '')}.md`), text);
    console.log(text);
  }
  it('промежуток между сигналами — не меньше 1,5 с; в 10 с — не больше 3 сигналов', () => {
    for (let i = 1; i < r.played.length; i++) expect(r.played[i]!.ms - r.played[i - 1]!.ms).toBeGreaterThanOrEqual(SOUND_MIN_GAP_MS);
    for (const p of r.played) expect(r.played.filter((q) => q.ms >= p.ms && q.ms < p.ms + 10_000).length).toBeLessThanOrEqual(3);
  });
  it('в среднем не больше 2 сигналов в минуту', () => {
    if (r.minutes < 1) return;
    expect(r.played.length / r.minutes).toBeLessThanOrEqual(2);
  });
});
