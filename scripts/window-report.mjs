// Какое окно предупреждения о смерти выбрать (docs/WARNING_WINDOW.md): доля смертей с предупреждением коуча и старых
// правил для разных окон «за A–B с до смерти» по результату экзамена (tests/unit/exam.test.ts пишет leadsModel/leadsRules).
//   node scripts/window-report.mjs .tmp/exam3w2-result.json
import { existsSync, readFileSync } from 'node:fs';

const { deaths } = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const WINDOWS = [[1, 20], [2, 20], [3, 20], [4, 20], [5, 20], [6, 20], [7, 20], [8, 20], [10, 20], [5, 15], [6, 15], [6, 25], [6, 30]];
const MODE = { normal: 'All Pick', turbo: 'Турбо' };
// «Ещё можно уйти» за L с до смерти (tests/unit/window-why.test.ts, обучающие матчи) и время реакции игрока ~2 с:
// польза предупреждения за L с — доля «ещё можно уйти» на L − 2 с; позже 20 с не прибавляется (docs/WARNING_WINDOW.md)
// Таблицы пишет tests/unit/window-why.test.ts в .tmp/esc.json; нет файла — встроенные (замер 2026-10-20)
const ESC_BUILTIN = {
  normal: [[0, 0], [1, 3], [2, 6], [3, 10], [4, 16], [5, 22], [6, 27], [7, 34], [8, 39], [10, 49], [12, 54], [15, 64], [20, 73]],
  turbo: [[0, 0], [1, 0], [2, 2], [3, 5], [4, 9], [5, 13], [6, 14], [7, 21], [8, 25], [10, 36], [12, 48], [15, 62], [20, 67]],
};
const escFile = new URL('../.tmp/esc.json', import.meta.url);
const ESC = (() => {
  try {
    const j = existsSync(escFile) ? JSON.parse(readFileSync(escFile, 'utf8')) : null;
    return j?.normal?.length && j?.turbo?.length ? { normal: j.normal, turbo: j.turbo } : ESC_BUILTIN;
  } catch {
    return ESC_BUILTIN;
  }
})();
const REACTION = 2;
function value(mode, lead) {
  const x = Math.min(20, lead) - REACTION;
  const t = ESC[mode];
  if (x <= 0) return 0;
  for (let i = 1; i < t.length; i++) if (x <= t[i][0]) return (t[i - 1][1] + ((x - t[i - 1][0]) / (t[i][0] - t[i - 1][0])) * (t[i][1] - t[i - 1][1])) / 100;
  return t.at(-1)[1] / 100;
}
const out = [];
for (const mode of ['normal', 'turbo']) {
  const D = deaths.filter((d) => d.mode === mode && d.leadsModel);
  const share = (f) => `${((100 * D.filter(f).length) / Math.max(1, D.length)).toFixed(1)}%`;
  out.push(`### ${MODE[mode]} (смертей ${D.length})`, '', '| Окно, с до смерти | Коуч | Старые правила |', '|---|---|---|');
  for (const [a, b] of WINDOWS) {
    const hit = (leads) => leads.some((l) => l >= a && l <= b);
    out.push(`| ${a}–${b} | ${share((d) => hit(d.leadsModel))} | ${share((d) => hit(d.leadsRules))} |`);
  }
  const saved = (key) => D.reduce((a, d) => a + Math.max(0, ...d[key].map((l) => value(mode, l))), 0) / Math.max(1, D.length);
  out.push('', `**Польза:** доля смертей, которых подсказка могла бы избежать, если игрок отреагирует за 2 с — коуч ${(100 * saved('leadsModel')).toFixed(1)}%, старые правила ${(100 * saved('leadsRules')).toFixed(1)}%.`);
  // Первое предупреждение: за сколько секунд до смерти (медиана среди предупреждённых за 1–30 с)
  const first = D.map((d) => (d.leadsModel.length ? Math.max(...d.leadsModel) : null)).filter((x) => x !== null).sort((x, y) => x - y);
  out.push('', `Самое раннее предупреждение коуча перед смертью (если было за 1–30 с): медиана ${first[Math.floor(first.length / 2)] ?? '—'} с.`, '');
}
console.log(out.join('\n'));
