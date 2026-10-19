// Все отметки «плохой совет» (горячая клавиша в игре) за сессию — в один Markdown для разбора в Claude Code
// (docs/BAD_ADVICE.md). Сессия — один запуск коуча: папка <папка данных>/bad-advice/<время запуска>/.
//   npm run bad-advice -- [--session <папка> | --all] [--dir <папка bad-advice>] [--out <файл.md>]
// По умолчанию — последняя сессия, папка данных %APPDATA%\Dota AI Coach, файл .tmp/bad-advice-<сессия>.md.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { BAD_ADVICE_SCHEMA, badAdviceReport } from '../src/core/coach/bad-advice.ts';

const root = join(import.meta.dirname, '..');
const args = process.argv.slice(2);
const opt = (k) => (args.includes(k) ? args[args.indexOf(k) + 1] : null);
const dir = resolve(opt('--dir') ?? join(process.env.APPDATA ?? join(process.env.HOME ?? '', '.config'), 'Dota AI Coach', 'bad-advice'));
if (!existsSync(dir)) {
  console.error(`Отметок нет: папки ${dir} не существует (в игре ни разу не нажимали клавишу «плохой совет»).`);
  process.exit(1);
}
const sessions = readdirSync(dir).filter((d) => /^[0-9A-Za-z_-]+$/.test(d)).sort();
const picked = args.includes('--all') ? sessions : [opt('--session') ?? sessions.at(-1)].filter(Boolean);
if (!picked.length || picked.some((s) => !sessions.includes(s))) {
  console.error(`Сессия не найдена. Есть: ${sessions.join(', ') || 'нет'}`);
  process.exit(1);
}
const records = [];
for (const s of picked)
  for (const f of readdirSync(join(dir, s)).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const r = JSON.parse(readFileSync(join(dir, s, f), 'utf8'));
      if (r?.schema === BAD_ADVICE_SCHEMA) records.push(r);
    } catch {
      console.warn(`  пропущен испорченный файл ${s}/${f}`);
    }
  }
records.sort((a, b) => String(a.markedAt).localeCompare(String(b.markedAt)));
const name = args.includes('--all') ? 'all' : picked[0];
const out = resolve(opt('--out') ?? join(root, '.tmp', `bad-advice-${name}.md`));
mkdirSync(join(out, '..'), { recursive: true });
writeFileSync(out, badAdviceReport(records, `Плохие советы — ${args.includes('--all') ? 'все сессии' : `сессия ${name}`}`), 'utf8');
console.log(`Отметок: ${records.length} → ${out}`);
