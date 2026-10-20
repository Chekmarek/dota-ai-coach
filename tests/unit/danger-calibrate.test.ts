// Порог и пауза модели опасности — настоящим коучем (docs/EXAM.md, круг 3). На экзамене круга 2 модель давала на
// 15–25% меньше тревог, чем при подборе в danger2-train: там тревоги считались прямо по риску, а в приложении их
// проходит арбитр (и пауза была общей на оба режима). Здесь каждый кандидат прогоняется через весь CoachService, как
// на экзамене, только на части «val» обучающих матчей (.tmp/danger, .tmp/danger-turbo), без экзаменационных.
// Условие то же: тревог не больше, чем у старых правил на тех же героях; наибольшая доля смертей с предупреждением.
//   $env:DOTACOACH_DANGER_CAL='1'; $env:DANGER_CAL_WRITE='1'; npx vitest run tests/unit/danger-calibrate.test.ts
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('electron', () => ({ app: { getAppPath: () => join(import.meta.dirname, '../..'), isPackaged: false, getVersion: () => 'cal' } }));

import { CoachService } from '../../src/main/coach/service';
import { KbStore } from '../../src/main/knowledge/kb-store';
import { defaultSettings } from '../../src/shared/schemas/settings';
import { RISK_RULES, parseDangerModel, type DangerModel } from '../../src/core/coach/danger-model.ts';
import { GamePipeline, readXMatch, rng, type XMatch } from './exam-lib.ts';

const root = join(import.meta.dirname, '../..');
const MODEL_FILE = join(root, 'src/data/danger-model.json');
const MAX = process.env.DANGER_CAL_MAX ? Number(process.env.DANGER_CAL_MAX) : 100;
const KB_CACHE = join(process.env.APPDATA ?? '', 'Dota AI Coach', 'kb-cache');
// Окно 8–20 с — docs/WARNING_WINDOW.md
const WARN_FROM = 20, WARN_TO = 8;
const DANGER_IDS = new Set<string>([...RISK_RULES, 'danger.model']);
const COOLDOWNS = [10, 15, 20, 30];
const split = (id: number) => {
  const h = (id * 2654435761) % 100;
  return h < 70 ? 'train' : h < 80 ? 'val' : 'test';
};
const files = (dir: string) => (existsSync(join(root, '.tmp', dir)) ? readdirSync(join(root, '.tmp', dir)).filter((f) => f.endsWith('.json.gz')).map((f) => join(root, '.tmp', dir, f)) : []);
const examIds = new Set(readdirSync(join(root, '.tmp'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('exam')).flatMap((d) => files(d.name).map((f) => f.split(/[\\/]/).pop()!)));
const idOf = (f: string) => Number(/(\d+)\.json\.gz$/.exec(f)![1]);

describe.runIf(process.env.DOTACOACH_DANGER_CAL)('модель опасности: порог через настоящий коуч', () => {
  it('подбор по режимам', () => {
    const kb = new KbStore({ cacheDir: KB_CACHE });
    const kbData = kb.get();
    if ('error' in kbData) throw new Error(kbData.error);
    const itemKey = new Map(kbData.items.map((i) => [i.id, i.key]));
    const raw = JSON.parse(readFileSync(MODEL_FILE, 'utf8'));
    const model = parseDangerModel(raw);
    if (!model) throw new Error('файл модели не разбирается');

    /** Тревоги о риске за матч героя (секунды игры) */
    function alertsOf(m: XMatch, meIdx: number, turbo: boolean, dm: DangerModel | null): number[] {
      let now = 0;
      const svc = new CoachService({
        settings: { get: () => defaultSettings() },
        kb,
        aiProvider: () => null,
        history: { save() {}, recent: () => [] },
        onHints: () => {},
        now: () => now,
        dangerModel: dm,
      });
      const pipe = new GamePipeline(m, meIdx, turbo, itemKey, m.id * 7 + meIdx);
      const out: number[] = [];
      for (let t = pipe.startClock; t <= m.durationSeconds; t++) {
        const input = pipe.tick(t);
        now = input.gsiWallMs!;
        const u = svc.ingest(input);
        if (t >= 0 && u?.shown.some((h) => DANGER_IDS.has(h.id.split(':')[0]!))) out.push(t);
      }
      return out;
    }

    const result: Record<string, { threshold: number; cooldownSec: number }> = {};
    for (const [mode, dir] of [['normal', 'danger'], ['turbo', 'danger-turbo']] as const) {
      const turbo = mode === 'turbo';
      const heroes = files(dir)
        .filter((f) => !examIds.has(f.split(/[\\/]/).pop()!) && split(idOf(f)) === 'val')
        .slice(0, MAX)
        .map((f) => {
          const m = readXMatch(f);
          const meIdx = Math.floor(rng(m.id + 2)() * 10);
          return { m, meIdx, deaths: m.players[meIdx]!.playbackData.deathEvents.map((d) => d.time).filter((t) => t > WARN_FROM) };
        });
      const deaths = heroes.reduce((s, h) => s + h.deaths.length, 0);
      const score = (dm: DangerModel | null) => {
        let alerts = 0, warned = 0;
        for (const h of heroes) {
          const a = alertsOf(h.m, h.meIdx, turbo, dm);
          alerts += a.length;
          warned += h.deaths.filter((d) => a.some((t) => t >= d - WARN_FROM && t <= d - WARN_TO)).length;
        }
        return { alerts, recall: deaths ? warned / deaths : 0 };
      };
      const t0 = Date.now();
      const rules = score(null);
      const cur = model[mode];
      const was = score(model);
      console.log(`${mode}: героев ${heroes.length}, смертей ${deaths}; старые правила ${(100 * rules.recall).toFixed(1)}%, тревог ${rules.alerts}; модель как есть (порог ${cur.threshold}, пауза ${cur.cooldownSec ?? model.cooldownSec}) ${(100 * was.recall).toFixed(1)}%, тревог ${was.alerts} (${Math.round((Date.now() - t0) / 1000)} с)`);
      let best = { threshold: cur.threshold, cooldownSec: cur.cooldownSec ?? model.cooldownSec, ...was, ok: was.alerts <= rules.alerts };
      const grid = Array.from({ length: 50 }, (_, i) => Math.round((0.03 + i * 0.01) * 100) / 100);
      for (const cd of COOLDOWNS) {
        // Тревог тем меньше, чем выше порог: двоичный поиск самого низкого порога, при котором их не больше, чем у правил
        let lo = 0, hi = grid.length - 1, found: (typeof best) | null = null;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const dm: DangerModel = { ...model, [mode]: { ...cur, threshold: grid[mid]!, cooldownSec: cd } };
          const s = score(dm);
          console.log(`  пауза ${cd} с, порог ${grid[mid]}: ${(100 * s.recall).toFixed(1)}%, тревог ${s.alerts}`);
          if (s.alerts <= rules.alerts) {
            if (!found || s.recall > found.recall) found = { threshold: grid[mid]!, cooldownSec: cd, ...s, ok: true };
            hi = mid - 1;
          } else lo = mid + 1;
        }
        if (found && (!best.ok || found.recall > best.recall)) best = found;
      }
      console.log(`  → порог ${best.threshold}, пауза ${best.cooldownSec} с: ${(100 * best.recall).toFixed(1)}%, тревог ${best.alerts} против ${rules.alerts} (${Math.round((Date.now() - t0) / 1000)} с)`);
      result[mode] = { threshold: best.threshold, cooldownSec: best.cooldownSec };
    }
    if (process.env.DANGER_CAL_WRITE) {
      for (const mode of ['normal', 'turbo'] as const) Object.assign(raw[mode], result[mode]);
      writeFileSync(MODEL_FILE, JSON.stringify(raw, null, 1) + '\n');
      console.log('Записано в src/data/danger-model.json');
    }
    expect(Object.keys(result)).toHaveLength(2);
  }, 4 * 3600_000);
});
