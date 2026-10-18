// npm run ai:eval (DOTACOACH_AI_TEST=tests/ai/draft-eval.eval.ts) — ИИ на 34 ситуациях драфта (draft-questions.json):
// числа и герои только из фактов, первым назван лучший кандидат правил, длина уведомления, время ответа.
// Модели: DOTACOACH_AI_MODELS=qwen3-1.7b,qwen3-4b,qwen3-8b. Потоки — половина ядер (как при выборе героев).
// Итог — .tmp/draft-eval.json (каждый ответ) и таблица в консоли.
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, it } from 'vitest';
import { localModels, prepareLocal } from './local-runtime';
import { threadsFor } from '../../src/main/ai/local/manifest';
import { checkDraftAnswer } from '../../src/core/ai/draft-check';
import { realData } from '../unit/coach-sim';

const ROOT = resolve(import.meta.dirname, '../..');
interface Case {
  id: string;
  facts: string[];
  expect: { topHero: string; topName: string; allowedHeroes: string[] };
}
// Набор: DOTACOACH_DRAFT_SET (например tests/ai/draft-questions-turbo.json — те же ситуации по статистике Турбо)
const SET = process.env.DOTACOACH_DRAFT_SET ?? 'tests/ai/draft-questions.json';
const set = JSON.parse(readFileSync(join(ROOT, SET), 'utf8')) as { cases: Case[] };
const OUT = SET.includes('turbo') ? '.tmp/draft-eval-turbo.json' : '.tmp/draft-eval.json';
const heroes = realData().heroes.map((h) => ({ key: h.key, name: h.name }));
const rows: Record<string, unknown>[] = [];
const answers: Record<string, unknown>[] = [];
afterAll(() => {
  writeFileSync(join(ROOT, OUT), JSON.stringify({ rows, answers }, null, 2));
  console.table(rows);
});

for (const model of localModels()) {
  it(model, async () => {
    const { sidecar, service } = await prepareLocal(model, false, threadsFor(cpus().length, false));
    try {
      const t0 = Date.now();
      await sidecar.ensure(model);
      const loadMs = Date.now() - t0;
      let ok = 0, top = 0, invNum = 0, invHero = 0, long = 0, promise = 0, mode = 0, errors = 0, total = 0, first = 0;
      const times: number[] = [];
      for (const c of set.cases) {
        const r = await service.ask({ requestId: c.id, kind: 'draft', facts: c.facts }, () => undefined);
        if (r.error) {
          errors++;
          answers.push({ model, id: c.id, error: r.error.message });
          continue;
        }
        if (r.model !== model) throw new Error(`${c.id}: ответила ${r.model}`);
        const ch = checkDraftAnswer({ answer: r.text, facts: r.facts, heroes, allowedHeroes: c.expect.allowedHeroes, topHero: c.expect.topHero });
        ok += +ch.ok;
        top += +ch.topFirst;
        invNum += +(ch.inventedNumbers.length > 0);
        invHero += +(ch.inventedHeroes.length > 0);
        long += +ch.tooLong;
        promise += +ch.promises;
        mode += +(ch.wrongMode.length > 0);
        total += r.totalMs;
        first += r.firstChunkMs ?? 0;
        times.push(r.totalMs);
        answers.push({ model, id: c.id, ok: ch.ok, text: r.text, check: ch, ms: r.totalMs });
      }
      const n = set.cases.length - errors;
      times.sort((a, b) => a - b);
      rows.push({
        model,
        ситуаций: set.cases.length,
        'годных ответов': ok,
        'лучший первым': top,
        'выдуманные числа': invNum,
        'выдуманные герои': invHero,
        'слишком длинно': long,
        'обещание победы': promise,
        'чужой режим': mode,
        ошибок: errors,
        'загрузка, с': +(loadMs / 1000).toFixed(1),
        'первый токен, с': n ? +(first / n / 1000).toFixed(1) : null,
        'ответ, с (среднее)': n ? +(total / n / 1000).toFixed(1) : null,
        'ответ, с (90 %)': times.length ? +(times[Math.floor(times.length * 0.9)]! / 1000).toFixed(1) : null,
      });
    } finally {
      sidecar.stop();
    }
  });
}
