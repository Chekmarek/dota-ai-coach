// Экзамен коуча (docs/EXAM.md): свежие матчи STRATZ, которых не было ни в обучении, ни в прошлых проверках.
// Каждый матч — секунда за секундой через ВЕСЬ коуч, как в игре: GSI своего героя + зрение с туманом войны и
// ошибками → MatchStateModel → CoachService (база знаний и кэш STRATZ, модели, правила, арбитр — те же, что в
// приложении). Коуч играет за одного случайного героя матча; будущее не видит. Второй прогон того же матча — со
// старыми правилами опасности вместо модели (для сравнения).
//   $env:DOTACOACH_EXAM='1'; $env:EXAM_DIRS='exam1-ap,exam1-turbo'; $env:EXAM_OUT='.tmp/exam1-result.json'; npx vitest run tests/unit/exam.test.ts
import { describe, expect, it, vi } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('electron', () => ({ app: { getAppPath: () => join(import.meta.dirname, '../..'), isPackaged: false, getVersion: () => 'exam' } }));

import { CoachService } from '../../src/main/coach/service';
import { KbStore } from '../../src/main/knowledge/kb-store';
import { defaultSettings } from '../../src/shared/schemas/settings';
import { buildView } from '../../src/core/coach/view.ts';
import { nearEnemyCount } from '../../src/core/coach/memory.ts';
import { RISK_RULES } from '../../src/core/coach/danger-model.ts';
import { deadAt, dist, fightsOf, GamePipeline, levelAt, networthAt, posAt, readXMatch, rng, visionRange, type Fight, type P, type XMatch } from './exam-lib.ts';
import { calibrationTable } from './lr.ts';

const root = join(import.meta.dirname, '../..');
const DIRS = (process.env.EXAM_DIRS ?? 'exam1-ap,exam1-turbo').split(',');
const OUT = process.env.EXAM_OUT ?? '.tmp/exam-result.json';
const MAX = process.env.EXAM_MAX ? Number(process.env.EXAM_MAX) : 10_000;
const KB_CACHE = join(process.env.APPDATA ?? '', 'Dota AI Coach', 'kb-cache');
/** Предупреждение о смерти засчитывается, если было за 10–20 с до неё */
// Окно 8–20 с (docs/WARNING_WINDOW.md): игроку нужно ~2 с заметить подсказку и решить; за 8 с до смерти уйти ещё можно
// примерно в четверти случаев, позже 20 с польза почти не растёт, а ложных тревог больше. Окно 10–20 с — для сравнения.
const WARN_FROM = 20, WARN_TO = 8, WARN_TO_OLD = 10;
const DANGER_IDS = new Set<string>([...RISK_RULES, 'danger.model']);

interface FightRec {
  match: number;
  mode: string;
  t: number;
  hero: string;
  level: number;
  size: number;
  equal: boolean;
  ours: number;
  theirs: number;
  won: boolean;
  coach: number | null;
  rules: number | null;
  /** Простые подсказчики по тому же, что видит коуч */
  seenAllies: number;
  seenEnemies: number;
  seenLevelAdv: number | null;
  /** Полная правда (для справки): уровни и ценность участников */
  levelSum: [number, number];
  networthSum: [number, number];
  hp: number | null;
}
interface DeathRec {
  match: number;
  mode: string;
  t: number;
  hero: string;
  level: number;
  warnedModel: boolean;
  warnedRules: boolean;
  /** То же в окне прошлых кругов 10–20 с */
  warnedModel10: boolean;
  warnedRules10: boolean;
  /** В окне враг рядом (≤ 2 500) был хоть раз в обзоре своей команды — коуч мог его увидеть */
  visible: boolean;
  /** За сколько секунд до смерти были тревоги (1–30 с) — для подбора окна (docs/WARNING_WINDOW.md) */
  leadsModel: number[];
  leadsRules: number[];
  maxRisk: number | null;
}

describe.runIf(process.env.DOTACOACH_EXAM)('экзамен коуча на свежих матчах', () => {
  it('прогон и отчёт', () => {
    const kb = new KbStore({ cacheDir: KB_CACHE });
    const kbData = kb.get();
    if ('error' in kbData) throw new Error(kbData.error);
    const itemKey = new Map(kbData.items.map((i) => [i.id, i.key]));
    const fights: FightRec[] = [];
    const deaths: DeathRec[] = [];
    const alerts: Record<string, { model: number; rules: number; aliveSec: number; falseModel: number; falseRules: number }> = {};
    const files = DIRS.flatMap((d) => (existsSync(join(root, '.tmp', d)) ? readdirSync(join(root, '.tmp', d)).filter((f) => f.endsWith('.json.gz')).map((f) => ({ f: join(root, '.tmp', d, f), turbo: d.includes('turbo') })) : [])).slice(0, MAX);
    console.log(`Матчей: ${files.length}`);
    const t0 = Date.now();

    function run(m: XMatch, meIdx: number, turbo: boolean, oldRules: boolean, fightTimes: Set<number>) {
      let now = 0;
      const svc = new CoachService({
        settings: { get: () => defaultSettings() },
        kb,
        aiProvider: () => null,
        history: { save() {}, recent: () => [] },
        onHints: () => {},
        now: () => now,
        ...(oldRules ? { dangerModel: null } : {}),
      });
      const pipe = new GamePipeline(m, meIdx, turbo, itemKey, m.id * 7 + meIdx);
      const out = { alerts: [] as number[], risk: new Map<number, number>(), at: new Map<number, { coach: number | null; rules: number | null; view: ReturnType<typeof buildView> }>(), aliveSec: 0 };
      for (let t = pipe.startClock; t <= m.durationSeconds; t++) {
        const input = pipe.tick(t);
        now = input.gsiWallMs!;
        const u = svc.ingest(input);
        if (t < 0) continue;
        const alive = !m.players[meIdx]!.playbackData.deathEvents.some((d) => t >= d.time && t < d.time + Math.max(1, d.timeDead));
        if (alive) out.aliveSec++;
        if (u?.shown.some((h) => DANGER_IDS.has(h.id.split(':')[0]!))) out.alerts.push(t);
        if (!oldRules) {
          const f = svc.forecast();
          if (f?.risk !== null && f?.risk !== undefined) out.risk.set(t, f.risk);
          if (fightTimes.has(t)) out.at.set(t, { coach: f?.fightWin ?? null, rules: f?.fightWinRules ?? null, view: buildView(input.state, input.gsi, input.gsiWallMs) });
        }
      }
      return out;
    }

    for (const [k, { f, turbo }] of files.entries()) {
      const m = readXMatch(f);
      const mode = turbo ? 'turbo' : 'normal';
      const meIdx = Math.floor(rng(m.id)() * 10);
      const me = m.players[meIdx]!;
      const team = me.isRadiant ? 'radiant' : 'dire';
      const hero = kbData.heroes.find((h) => h.id === me.heroId)?.key ?? String(me.heroId);
      const myFights = fightsOf(m).filter((x: Fight) => (team === 'radiant' ? x.radiant : x.dire).includes(meIdx) && x.tp >= 0);
      const a = run(m, meIdx, turbo, false, new Set(myFights.map((x) => x.tp)));
      const b = run(m, meIdx, turbo, true, new Set());
      const st = (alerts[mode] ??= { model: 0, rules: 0, aliveSec: 0, falseModel: 0, falseRules: 0 });
      st.model += a.alerts.length;
      st.rules += b.alerts.length;
      st.aliveSec += a.aliveSec;
      const myDeaths = me.playbackData.deathEvents.map((d) => d.time).filter((t) => t > WARN_FROM);
      st.falseModel += a.alerts.filter((t) => !myDeaths.some((d) => d > t && d <= t + WARN_FROM)).length;
      st.falseRules += b.alerts.filter((t) => !myDeaths.some((d) => d > t && d <= t + WARN_FROM)).length;
      for (const d of myDeaths) {
        const win = (al: number[], to = WARN_TO) => al.some((t) => t >= d - WARN_FROM && t <= d - to);
        const leadsOf = (al: number[]) => al.filter((t) => t >= d - 30 && t <= d - 1).map((t) => d - t);
        let visible = false;
        for (let t = d - WARN_FROM; t <= d - WARN_TO && !visible; t++) {
          const my = posAt(me, t);
          if (!my) continue;
          const watchers = m.players.filter((p) => p.isRadiant === me.isRadiant && !deadAt(p, t)).map((p) => posAt(p, t)).filter((q): q is P => q !== null);
          visible = m.players.some((e) => e.isRadiant !== me.isRadiant && !deadAt(e, t) && posAt(e, t) !== null && dist(posAt(e, t)!, my) <= 2500 && watchers.some((w) => dist(w, posAt(e, t)!) <= visionRange(t)));
        }
        let maxRisk: number | null = null;
        for (let t = d - WARN_FROM; t <= d - WARN_TO; t++) if (a.risk.has(t)) maxRisk = Math.max(maxRisk ?? 0, a.risk.get(t)!);
        deaths.push({ match: m.id, mode, t: d, hero, level: levelAt(me, d), warnedModel: win(a.alerts), warnedRules: win(b.alerts), warnedModel10: win(a.alerts, WARN_TO_OLD), warnedRules10: win(b.alerts, WARN_TO_OLD), visible, leadsModel: leadsOf(a.alerts), leadsRules: leadsOf(b.alerts), maxRisk });
      }
      for (const x of myFights) {
        if (!x.winner) continue;
        const atTp = a.at.get(x.tp);
        if (!atTp) continue;
        const v = atTp.view;
        const myPos = v.me.pos.value;
        const seenAllies = myPos ? v.allies.filter((p) => p.alive.value !== false && p.pos.value && (p.pos.ageSec ?? 99) <= 3 && dist(p.pos.value, myPos) <= 2500).length + 1 : 1;
        const seenEnemies = nearEnemyCount(v);
        // Уровни врагов, которые видит коуч: полоски врагов к героям не привязываются — со всех вражеских полосок на экране
        const linked = myPos ? v.enemies.filter((p) => p.pos.value && (p.pos.ageSec ?? 99) <= 3 && dist(p.pos.value, myPos) <= 2500 && p.barLevel !== null).map((p) => p.barLevel!) : [];
        const lvls = linked.length ? linked : v.screen.meOnScreen ? v.screen.enemyBars.map((b) => b.level).filter((l): l is number => l !== null) : [];
        const ours = team === 'radiant' ? x.radiant : x.dire, theirs = team === 'radiant' ? x.dire : x.radiant;
        const sum = (ids: number[], f2: (p: (typeof m.players)[number], t: number) => number) => ids.reduce((s, i) => s + f2(m.players[i]!, x.tp), 0);
        const hpPool = v.me.hp.value;
        fights.push({
          match: m.id,
          mode,
          t: x.tp,
          hero,
          level: levelAt(me, x.tp),
          size: x.radiant.length + x.dire.length,
          equal: x.radiant.length === x.dire.length,
          ours: ours.length,
          theirs: theirs.length,
          won: x.winner === team,
          coach: atTp.coach,
          rules: atTp.rules,
          seenAllies,
          seenEnemies,
          seenLevelAdv: lvls.length ? (v.me.level.value ?? 1) - lvls.reduce((s, l) => s + l, 0) / lvls.length : null,
          levelSum: [sum(ours, levelAt), sum(theirs, levelAt)],
          networthSum: [sum(ours, networthAt), sum(theirs, networthAt)],
          hp: hpPool ? Math.round((100 * hpPool.current) / hpPool.max) : null,
        });
      }
      void posAt;
      if ((k + 1) % 25 === 0) console.log(`  ${k + 1}/${files.length} (${Math.round((Date.now() - t0) / 60000)} мин)`);
    }

    // ---------- Подсчёт ----------
    const acc = (rows: FightRec[], pred: (r: FightRec) => number | null) => {
      let s = 0;
      for (const r of rows) {
        const p = pred(r);
        s += p === null || p === 0.5 ? 0.5 : (p > 0.5) === r.won ? 1 : 0;
      }
      return rows.length ? (100 * s) / rows.length : null;
    };
    const sign = (a: number, b: number) => (a > b ? 1 : a < b ? 0 : 0.5);
    const predictors: Record<string, (r: FightRec) => number | null> = {
      'коуч (модель драк)': (r) => r.coach,
      'старые правила (шанс «Вступать»)': (r) => r.rules,
      монетка: () => 0.5,
      'кого больше (видно коучу)': (r) => sign(r.seenAllies, r.seenEnemies),
      'у кого выше уровень (видно коучу)': (r) => (r.seenLevelAdv === null ? 0.5 : sign(r.seenLevelAdv, 0)),
      'кого больше (полная правда)': (r) => sign(r.ours, r.theirs),
      'сумма уровней (полная правда)': (r) => sign(r.levelSum[0], r.levelSum[1]),
      'ценность героев (полная правда)': (r) => sign(r.networthSum[0], r.networthSum[1]),
    };
    const SAME_INFO = ['монетка', 'кого больше (видно коучу)', 'у кого выше уровень (видно коучу)', 'старые правила (шанс «Вступать»)'];
    /** 95% интервал разницы точности «коуч − подсказчик» (бутстреп по матчам) */
    function diffCI(rows: FightRec[], other: (r: FightRec) => number | null) {
      const by = new Map<number, FightRec[]>();
      for (const r of rows) by.set(r.match, [...(by.get(r.match) ?? []), r]);
      const groups = [...by.values()];
      const rnd = rng(99);
      const ds: number[] = [];
      for (let i = 0; i < 1000; i++) {
        const sample = Array.from({ length: groups.length }, () => groups[Math.floor(rnd() * groups.length)]!).flat();
        ds.push((acc(sample, (r) => r.coach) ?? 0) - (acc(sample, other) ?? 0));
      }
      ds.sort((a, b) => a - b);
      return { lo: ds[25]!, hi: ds[974]! };
    }
    const stage = (l: number) => (l <= 6 ? '1–6' : l <= 15 ? '7–15' : '16+');
    const sizeOf = (n: number) => (n <= 4 ? '2–4' : n <= 7 ? '5–7' : '8–10');
    const report: Record<string, unknown> = { matches: files.length, minutes: Math.round((Date.now() - t0) / 60000) };
    for (const mode of ['normal', 'turbo']) {
      const F = fights.filter((r) => r.mode === mode), D = deaths.filter((r) => r.mode === mode), A = alerts[mode];
      if (!F.length || !A) continue;
      const eq = F.filter((r) => r.equal);
      const table = Object.fromEntries(Object.entries(predictors).map(([n, p]) => [n, { all: acc(F, p), equal: acc(eq, p) }]));
      const coachP = F.filter((r) => r.coach !== null);
      const cal = calibrationTable(coachP.map((r) => r.coach!), coachP.map((r) => (r.won ? 1 : 0)));
      const rulesP = F.filter((r) => r.rules !== null);
      const calRules = calibrationTable(rulesP.map((r) => r.rules!), rulesP.map((r) => (r.won ? 1 : 0)));
      const groups = (key: (r: FightRec) => string) => Object.fromEntries([...new Set(F.map(key))].sort().map((g) => [g, { n: F.filter((r) => key(r) === g).length, coach: acc(F.filter((r) => key(r) === g), predictors['коуч (модель драк)']!), best: Math.max(...SAME_INFO.map((n) => acc(F.filter((r) => key(r) === g), predictors[n]!) ?? 0)) }]));
      const ciEq = Object.fromEntries(SAME_INFO.map((n) => [n, diffCI(eq, predictors[n]!)]));
      const bestEq = Math.max(...SAME_INFO.map((n) => table[n]!.equal ?? 0));
      const dangerModel = D.filter((d) => d.warnedModel).length / Math.max(1, D.length), dangerRules = D.filter((d) => d.warnedRules).length / Math.max(1, D.length);
      const share = (xs: DeathRec[], f: (d: DeathRec) => boolean) => xs.filter(f).length / Math.max(1, xs.length);
      const V = D.filter((d) => d.visible);
      const extra = {
        window: `${WARN_TO}–${WARN_FROM}`,
        visibleShare: share(D, (d) => d.visible),
        warnedVisibleModel: share(V, (d) => d.warnedModel),
        warnedVisibleRules: share(V, (d) => d.warnedRules),
        warnedModel10: share(D, (d) => d.warnedModel10),
        warnedRules10: share(D, (d) => d.warnedRules10),
        falseShareModel: A.falseModel / Math.max(1, A.model),
        falseShareRules: A.falseRules / Math.max(1, A.rules),
      };
      const pass = {
        equalFights: (table['коуч (модель драк)']!.equal ?? 0) >= bestEq + 5 && SAME_INFO.every((n) => ciEq[n]!.lo > 0),
        calibration: cal.ece <= 5,
        danger: dangerModel >= 0.8 && A.model <= A.rules,
      };
      // Грубые ошибки: коуч уверен (≥ 80% или ≤ 20%), а вышло наоборот — самые уверенные
      const gross = coachP.filter((r) => (r.coach! >= 0.8 && !r.won) || (r.coach! <= 0.2 && r.won)).sort((x, y) => Math.abs(y.coach! - 0.5) - Math.abs(x.coach! - 0.5)).slice(0, 10);
      const missed = D.filter((d) => !d.warnedModel).sort((x, y) => (x.maxRisk ?? 0) - (y.maxRisk ?? 0)).slice(0, 5);
      report[mode] = {
        fights: F.length,
        equalFights: eq.length,
        draws: 'ничьи в драках не считаются',
        accuracy: table,
        ciEqual: ciEq,
        byStage: groups((r) => stage(r.level)),
        bySize: groups((r) => sizeOf(r.size)),
        calibration: cal,
        calibrationRules: calRules,
        danger: { deaths: D.length, warnedModel: dangerModel, warnedRules: dangerRules, alertsModel: A.model, alertsRules: A.rules, perMinModel: A.model / (A.aliveSec / 60), perMinRules: A.rules / (A.aliveSec / 60), falseModel: A.falseModel, falseRules: A.falseRules, ...extra },
        pass,
        gross,
        missed,
      };
      console.log(`\n${mode}: драк ${F.length} (равных ${eq.length}); смертей ${D.length}`);
      for (const [n, v] of Object.entries(table)) console.log(`  ${n.padEnd(38)} все ${v.all?.toFixed(1)}%  равные ${v.equal?.toFixed(1)}%`);
      console.log(`  честность процентов: отклонение ${cal.ece.toFixed(1)} п.п. (старые правила ${calRules.ece.toFixed(1)})`);
      console.log(`  опасность: предупреждено за ${extra.window} с — модель ${(100 * dangerModel).toFixed(1)}%, старые правила ${(100 * dangerRules).toFixed(1)}%; тревог ${A.model} против ${A.rules}; ложных ${A.falseModel} против ${A.falseRules}; из видимых смертей ${(100 * extra.warnedVisibleModel).toFixed(1)}% (видимых ${(100 * extra.visibleShare).toFixed(1)}%)`);
      console.log(`  проходной балл: равные драки ${pass.equalFights ? 'да' : 'НЕТ'}, проценты ${pass.calibration ? 'да' : 'НЕТ'}, опасность ${pass.danger ? 'да' : 'НЕТ'}`);
    }
    writeFileSync(join(root, OUT), JSON.stringify({ report, fights, deaths }, null, 1));
    expect(files.length).toBeGreaterThan(0);
  }, 48 * 3_600_000);
});
