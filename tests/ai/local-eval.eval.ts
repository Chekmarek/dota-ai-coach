// npm run ai:eval — оценка настоящей локальной модели по tests/ai/questions.json. Итог — .tmp/ai-eval-<модель>.json.
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { it } from 'vitest';
import { localModels, prepareLocal } from './local-runtime';
import { loadQuestions, promptFacts, scoreAnswer, type EvalScore } from './eval';

const ROOT = resolve(import.meta.dirname, '../..');

for (const model of localModels()) {
  it(`оценка ${model}`, async () => {
    const { sidecar, service } = await prepareLocal(model);
    try {
      const scores: (EvalScore & { ms: number })[] = [];
      for (const q of loadQuestions()) {
        const r = await service.ask({ requestId: q.id, kind: 'ask', question: q.question, facts: promptFacts(q) }, () => undefined);
        const s = scoreAnswer(q, r.error ? `ОШИБКА ${r.error.message}` : r.text, r.facts);
        scores.push({ ...s, ms: r.totalMs });
        console.log(`${s.pass ? '✓' : '✗'} ${q.id}: ${r.text.replace(/\n/g, ' ').slice(0, 160)}${s.pass ? '' : `  ← ${s.why}`}`);
      }
      const passed = scores.filter((s) => s.pass).length;
      const grounded = scores.filter((s) => s.grounded).length;
      const summary = { model, total: scores.length, passed, score: Math.round((passed / scores.length) * 100), grounded, avgSec: +(scores.reduce((a, s) => a + s.ms, 0) / scores.length / 1000).toFixed(1) };
      console.log(JSON.stringify(summary));
      writeFileSync(join(ROOT, `.tmp/ai-eval-${model}.json`), JSON.stringify({ summary, scores }, null, 2));
    } finally {
      sidecar.stop();
    }
  });
}
