// Разбор провала по опасности (docs/EXAM.md): за 10–20 с до смерти — видны ли были враги рядом коучу (туман войны),
// сколько врагов рядом на деле, и что видел коуч. Только чтение матчей экзамена, без обучения.
//   $env:DOTACOACH_EXAM_WHY='1'; $env:EXAM_DIRS='exam1-ap,exam1-turbo'; npx vitest run tests/unit/exam-why.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { deadAt, dist, posAt, readXMatch, rng, visionRange, type P } from './exam-lib.ts';

const root = join(import.meta.dirname, '../..');
const DIRS = (process.env.EXAM_DIRS ?? 'exam1-ap,exam1-turbo').split(',');

describe.runIf(process.env.DOTACOACH_EXAM_WHY)('опасность: что было видно до смерти', () => {
  it('разбор', () => {
    for (const d of DIRS) {
      const files = existsSync(join(root, '.tmp', d)) ? readdirSync(join(root, '.tmp', d)).filter((f) => f.endsWith('.json.gz')) : [];
      const c = { deaths: 0, visibleAny: 0, nearAny: 0, nearInvisibleOnly: 0, visibleAtDeath: 0, nobodyNear: 0, killerNear20: 0 };
      for (const f of files) {
        const m = readXMatch(join(root, '.tmp', d, f));
        const meIdx = Math.floor(rng(m.id)() * 10);
        const me = m.players[meIdx]!;
        const allies = m.players.filter((p) => p.isRadiant === me.isRadiant);
        const enemies = m.players.filter((p) => p.isRadiant !== me.isRadiant);
        for (const dt of me.playbackData.deathEvents.map((x) => x.time).filter((t) => t > 20)) {
          c.deaths++;
          let vis = false, near = false;
          for (let t = dt - 20; t <= dt - 10; t++) {
            const my = posAt(me, t);
            if (!my) continue;
            const watchers = allies.filter((p) => !deadAt(p, t)).map((p) => posAt(p, t)).filter((x): x is P => x !== null);
            for (const e of enemies) {
              if (deadAt(e, t)) continue;
              const q = posAt(e, t);
              if (!q || dist(q, my) > 2500) continue;
              near = true;
              if (watchers.some((w) => dist(w, q) <= visionRange(t))) vis = true;
            }
          }
          const my0 = posAt(me, dt);
          const visNow = my0 ? enemies.some((e) => !deadAt(e, dt) && posAt(e, dt) && dist(posAt(e, dt)!, my0) <= 1500) : false;
          if (vis) c.visibleAny++;
          if (near) c.nearAny++;
          if (near && !vis) c.nearInvisibleOnly++;
          if (!near) c.nobodyNear++;
          if (visNow) c.visibleAtDeath++;
        }
      }
      const pc = (x: number) => `${((100 * x) / Math.max(1, c.deaths)).toFixed(1)}%`;
      console.log(`${d}: смертей ${c.deaths}. За 10–20 с до смерти: враг рядом (≤ 2 500) был в ${pc(c.nearAny)}, из них виден коучу хоть раз — ${pc(c.visibleAny)}; рядом, но только в тумане — ${pc(c.nearInvisibleOnly)}; врагов рядом не было совсем — ${pc(c.nobodyNear)}`);
    }
    expect(true).toBe(true);
  });
});
