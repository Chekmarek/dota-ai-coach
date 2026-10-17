// Пересчёт оценки драфта по сохранённым ответам (.tmp/draft-eval.json) текущей проверкой src/core/ai/draft-check.ts
//   node --experimental-transform-types tests/ai/draft-rescore.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkDraftAnswer } from '../../src/core/ai/draft-check.ts';
import { realData } from '../unit/coach-sim.ts';

const ROOT = join(import.meta.dirname, '../..');
const set = JSON.parse(readFileSync(join(ROOT, 'tests/ai/draft-questions.json'), 'utf8'));
const res = JSON.parse(readFileSync(join(ROOT, '.tmp/draft-eval.json'), 'utf8'));
const heroes = realData().heroes.map((h) => ({ key: h.key, name: h.name }));
const byId = new Map(set.cases.map((c: { id: string }) => [c.id, c]));
const by: Record<string, { n: number; ok: number; top: number; num: number; hero: number; long: number; mis: number; fmt: number; ms: number[] }> = {};
for (const a of res.answers) {
  const r = (by[a.model] ??= { n: 0, ok: 0, top: 0, num: 0, hero: 0, long: 0, mis: 0, fmt: 0, ms: [] });
  r.n++;
  if (a.error) continue;
  const c = byId.get(a.id) as { facts: string[]; expect: { allowedHeroes: string[]; topHero: string } };
  const ch = checkDraftAnswer({ answer: a.text, facts: c.facts, heroes, allowedHeroes: c.expect.allowedHeroes, topHero: c.expect.topHero });
  r.ok += +ch.ok; r.top += +ch.topFirst; r.num += +(ch.inventedNumbers.length > 0); r.hero += +(ch.inventedHeroes.length > 0); r.long += +ch.tooLong; r.mis += +(ch.misattributed.length > 0); r.fmt += +ch.badFormat; r.ms.push(a.ms);
  if (!ch.ok && process.env.VERBOSE) console.log(a.model, a.id, JSON.stringify(ch), '\n   ', a.text);
}
for (const [m, r] of Object.entries(by)) {
  const s = [...r.ms].sort((x, y) => x - y);
  console.log(`${m.padEnd(11)} годных ${r.ok}/${r.n}  лучший первым ${r.top}  выдуманные числа ${r.num}  выдуманные герои ${r.hero}  число не при своём герое ${r.mis}  формат ${r.fmt}  длинно ${r.long}  ответ: среднее ${(s.reduce((x, y) => x + y, 0) / s.length / 1000).toFixed(1)} с, 90 % ${(s[Math.floor(s.length * 0.9)]! / 1000).toFixed(1)} с`);
}
