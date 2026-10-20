// Раздел отчёта экзамена (docs/EXAM.md) из результата tests/unit/exam.test.ts.
//   node scripts/exam-report.mjs .tmp/exam1-result.json "Круг 1" > .tmp/exam1.md
import { readFileSync } from 'node:fs';

const [file, title = 'Экзамен'] = process.argv.slice(2);
const { report, fights } = JSON.parse(readFileSync(file, 'utf8'));
const pct = (x) => (x === null || x === undefined ? '—' : `${x.toFixed(1)}%`);
const MODE = { normal: 'All Pick', turbo: 'Турбо' };
const out = [`## ${title}`, '', `Матчей: ${report.matches} (по одному случайному герою в каждом). Прогон занял ${report.minutes} мин.`, ''];

for (const mode of ['normal', 'turbo']) {
  const r = report[mode];
  if (!r) continue;
  const p = r.pass;
  out.push(`### ${MODE[mode]}: ${p.equalFights && p.calibration && p.danger ? '**сдал**' : '**не сдал**'}`, '');
  out.push(`| Условие | Итог |`, `|---|---|`);
  out.push(`| Равные драки: коуч заметно лучше простых подсказчиков (≥ 5 п.п. и интервал выше нуля) | ${p.equalFights ? 'да' : 'нет'} |`);
  out.push(`| Проценты честные (отклонение ≤ 5 п.п.) | ${p.calibration ? 'да' : 'нет'} — ${r.calibration.ece.toFixed(1)} п.п. |`);
  out.push(`| 80%+ смертей с предупреждением за ${r.danger.window ?? '10–20'} с, тревог не больше старых правил | ${p.danger ? 'да' : 'нет'} — ${(100 * r.danger.warnedModel).toFixed(1)}%, тревог ${r.danger.alertsModel} против ${r.danger.alertsRules} |`, '');
  out.push(`**Драки:** ${r.fights}, из них равных по числу участников — ${r.equalFights} (ничьи не считаются).`, '');
  out.push('| Кто предсказывает | Все драки | Равные драки |', '|---|---|---|');
  for (const [n, v] of Object.entries(r.accuracy)) out.push(`| ${n} | ${pct(v.all)} | ${pct(v.equal)} |`);
  out.push('', 'Разница «коуч − подсказчик» в равных драках, 95% интервал (бутстреп по матчам):', '');
  for (const [n, c] of Object.entries(r.ciEqual)) out.push(`- ${n}: ${c.lo.toFixed(1)}…${c.hi.toFixed(1)} п.п.`);
  out.push('', '| Стадия (уровень героя) | Драк | Коуч | Лучший простой (то же, что видит коуч) |', '|---|---|---|---|');
  for (const [g, v] of Object.entries(r.byStage)) out.push(`| ${g} | ${v.n} | ${pct(v.coach)} | ${pct(v.best)} |`);
  out.push('', '| Размер драки (участников) | Драк | Коуч | Лучший простой |', '|---|---|---|---|');
  for (const [g, v] of Object.entries(r.bySize)) out.push(`| ${g} | ${v.n} | ${pct(v.coach)} | ${pct(v.best)} |`);
  out.push('', `**Честность процентов** (коуч; отклонение ${r.calibration.ece.toFixed(1)} п.п., у старых правил ${r.calibrationRules.ece.toFixed(1)}):`, '', '| Коуч говорит | Драк | В среднем говорит | Выиграно на деле |', '|---|---|---|---|');
  for (const row of r.calibration.rows) if (row.n) out.push(`| ${row.range} | ${row.n} | ${row.predicted.toFixed(1)}% | ${row.actual.toFixed(1)}% |`);
  const d = r.danger;
  out.push('', `**Опасность** (смертей ${d.deaths}; предупреждение засчитывается за ${d.window ?? '10–20'} с до смерти):`, '', '| | Коуч | Старые правила |', '|---|---|---|');
  out.push(`| смертей с предупреждением | ${(100 * d.warnedModel).toFixed(1)}% | ${(100 * d.warnedRules).toFixed(1)}% |`);
  out.push(`| тревог всего (в минуту) | ${d.alertsModel} (${d.perMinModel.toFixed(2)}) | ${d.alertsRules} (${d.perMinRules.toFixed(2)}) |`);
  out.push(`| ложных (смерти в 20 с нет) | ${d.falseModel} | ${d.falseRules} |`);
  if (d.visibleShare !== undefined) {
    out.push(`| доля ложных среди тревог | ${(100 * d.falseShareModel).toFixed(1)}% | ${(100 * d.falseShareRules).toFixed(1)}% |`);
    out.push(`| из смертей, где врага рядом можно было увидеть (${(100 * d.visibleShare).toFixed(1)}% всех) | ${(100 * d.warnedVisibleModel).toFixed(1)}% | ${(100 * d.warnedVisibleRules).toFixed(1)}% |`);
    out.push(`| для сравнения: окно прошлых кругов 10–20 с | ${(100 * d.warnedModel10).toFixed(1)}% | ${(100 * d.warnedRules10).toFixed(1)}% |`);
  }
  out.push('');
  out.push('**Самые грубые ошибки прогноза драк** (коуч уверен, вышло наоборот):', '', '| Матч | Время | Герой (ур.) | Коуч | Вышло | Видно: свои/враги | На деле: свои/враги | Уровни (сумма) | Ценность, тыс. | HP |', '|---|---|---|---|---|---|---|---|---|---|');
  for (const g of r.gross) out.push(`| ${g.match} | ${Math.floor(g.t / 60)}:${String(g.t % 60).padStart(2, '0')} | ${g.hero} (${g.level}) | ${Math.round(100 * g.coach)}% | ${g.won ? 'победа' : 'поражение'} | ${g.seenAllies}/${g.seenEnemies} | ${g.ours}/${g.theirs} | ${g.levelSum[0]}/${g.levelSum[1]} | ${Math.round(g.networthSum[0] / 1000)}/${Math.round(g.networthSum[1] / 1000)} | ${g.hp ?? '—'}% |`);
  out.push('', `**Пропущенные смерти с самым низким риском** (за ${r.danger.window ?? '10–20'} с до смерти):`, '', '| Матч | Время | Герой (ур.) | Наибольший риск по модели |', '|---|---|---|---|');
  for (const m of r.missed) out.push(`| ${m.match} | ${Math.floor(m.t / 60)}:${String(m.t % 60).padStart(2, '0')} | ${m.hero} (${m.level}) | ${m.maxRisk === null ? '—' : `${Math.round(100 * m.maxRisk)}%`} |`);
  out.push('');
}
void fights;
console.log(out.join('\n'));
