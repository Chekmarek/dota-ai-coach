// Окно предупреждения для новичка (docs/WARNING_WINDOW.md): что происходит за L секунд до смерти. Только обучающие
// матчи (.tmp/danger, .tmp/danger-turbo, часть «val»), экзаменационные отброшены. Для каждого L: драка уже идёт
// (враг вплотную, здоровье уже сбито), враг рядом есть и виден своей команде, ещё можно уйти.
//   $env:DOTACOACH_WINDOW_WHY='1'; npx vitest run tests/unit/window-why.test.ts
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { at, deadAt, dist, posAt, readXMatch, rng, visionRange, type P, type XMatch, type XPlayer } from './exam-lib.ts';

const root = join(import.meta.dirname, '../..');
const MAX = process.env.WINDOW_MAX ? Number(process.env.WINDOW_MAX) : 300;
const LEADS = [1, 2, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30];
/** Вплотную: дальность атаки и большинства способностей */
const ENGAGED = 800;
const NEAR = 2500;
const split = (id: number) => {
  const h = (id * 2654435761) % 100;
  return h < 70 ? 'train' : h < 80 ? 'val' : 'test';
};
const files = (dir: string) => (existsSync(join(root, '.tmp', dir)) ? readdirSync(join(root, '.tmp', dir)).filter((f) => f.endsWith('.json.gz')).map((f) => join(root, '.tmp', dir, f)) : []);
const examIds = new Set(readdirSync(join(root, '.tmp'), { withFileTypes: true }).filter((d) => d.isDirectory() && d.name.startsWith('exam')).flatMap((d) => files(d.name).map((f) => f.split(/[\\/]/).pop()!)));
const idOf = (f: string) => Number(/(\d+)\.json\.gz$/.exec(f)![1]);
const hpPct = (p: XPlayer, t: number) => {
  const h = at(p.playbackData.playerUpdateHealthEvents, t);
  return h ? (100 * h.hp) / Math.max(1, h.maxHp) : 100;
};

describe.runIf(process.env.DOTACOACH_WINDOW_WHY)('окно предупреждения: что происходит до смерти', () => {
  it('по обучающим матчам', () => {
    const esc: Record<string, [number, number][]> = {};
    for (const dir of ['danger', 'danger-turbo']) {
      const list = files(dir).filter((f) => !examIds.has(f.split(/[\\/]/).pop()!) && split(idOf(f)) === 'val').slice(0, MAX);
      const c = Object.fromEntries(LEADS.map((L) => [L, { engaged: 0, hurt: 0, hit: 0, near: 0, visible: 0, escapable: 0 }]));
      let deaths = 0;
      for (const f of list) {
        const m: XMatch = readXMatch(f);
        const me = m.players[Math.floor(rng(m.id + 3)() * 10)]!;
        const allies = m.players.filter((p) => p.isRadiant === me.isRadiant);
        const enemies = m.players.filter((p) => p.isRadiant !== me.isRadiant);
        for (const d of me.playbackData.deathEvents.map((x) => x.time).filter((t) => t > 40)) {
          // Смерть сразу после возрождения (герой был мёртв за 30 с до неё) — пропускаем: L там не к чему мерить
          if (LEADS.some((L) => deadAt(me, d - L))) continue;
          deaths++;
          for (const L of LEADS) {
            const t = d - L;
            const my = posAt(me, t);
            if (!my) continue;
            const watchers = allies.filter((p) => !deadAt(p, t)).map((p) => posAt(p, t)).filter((q): q is P => q !== null);
            const ds = enemies.filter((e) => !deadAt(e, t)).map((e) => posAt(e, t)).filter((q): q is P => q !== null).map((q) => ({ q, d: dist(q, my) }));
            const nearest = Math.min(Infinity, ...ds.map((x) => x.d));
            const hp = hpPct(me, t);
            const k = c[L]!;
            const engaged = nearest <= ENGAGED;
            const hit = hpPct(me, t - 3) - hp >= 10;
            if (engaged) k.engaged++;
            if (hp < 50) k.hurt++;
            if (hit) k.hit++;
            if (nearest <= NEAR) k.near++;
            if (ds.some((x) => x.d <= NEAR && watchers.some((w) => dist(w, x.q) <= visionRange(t)))) k.visible++;
            // Ещё можно уйти ногами: враг не вплотную, здоровья хватает, урон ещё не пошёл
            if (!engaged && hp >= 50 && !hit) k.escapable++;
          }
        }
      }
      const pc = (x: number) => `${((100 * x) / Math.max(1, deaths)).toFixed(0)}%`;
      console.log(`\n${dir}: матчей ${list.length}, смертей ${deaths}`);
      console.log('| За сколько с до смерти | Враг вплотную (≤ 800) | Здоровье < 50% | Урон идёт (−10% за 3 с) | Враг рядом (≤ 2 500) | Враг рядом и виден | Ещё можно уйти |');
      console.log('|---|---|---|---|---|---|---|');
      for (const L of LEADS) {
        const k = c[L]!;
        console.log(`| ${L} | ${pc(k.engaged)} | ${pc(k.hurt)} | ${pc(k.hit)} | ${pc(k.near)} | ${pc(k.visible)} | ${pc(k.escapable)} |`);
      }
      // Таблица «ещё можно уйти за L с» для отчёта scripts/window-report.mjs (польза предупреждения)
      esc[dir === 'danger-turbo' ? 'turbo' : 'normal'] = [[0, 0], ...LEADS.filter((L) => L <= 20).map((L) => [L, Math.round((100 * c[L]!.escapable) / Math.max(1, deaths))] as [number, number])];
    }
    writeFileSync(join(root, '.tmp/esc.json'), JSON.stringify({ writtenAt: new Date().toISOString(), ...esc }, null, 1) + '\n');
    expect(true).toBe(true);
  }, 3_600_000);
});
