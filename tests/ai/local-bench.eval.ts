// npm run ai:bench — скорость локальной модели на этом ПК: загрузка, первый токен, токены/с, память и нагрузка CPU
// llama-server (доля всех логических ядер). Режим «во время матча» (≤ 120 токенов) и обычный. Итог — .tmp/ai-bench.json.
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, it } from 'vitest';
import { cpuMs, localModels, prepareLocal } from './local-runtime';
import { loadQuestions, promptFacts } from './eval';
import { processRamBytes } from '../../src/main/ai/local/sidecar';
import { threadsFor } from '../../src/main/ai/local/manifest';
import { AI_DRAFT_MODELS } from '../../src/shared/schemas/settings';

const ROOT = resolve(import.meta.dirname, '../..');
const results: Record<string, unknown>[] = [];
afterAll(() => {
  writeFileSync(join(ROOT, '.tmp/ai-bench.json'), JSON.stringify(results, null, 2));
  console.table(results);
});

const ids = ['live-blink-gold', 'mech-roshan', 'live-enemy-dead', 'item-bkb-parts', 'hero-pudge-ms'];

for (const model of localModels()) {
  // Модель драфта: отвечает только на kind = 'draft' и не в матче. Во время выбора героев захват видит Доту —
  // потоков четверть ядер (как в матче); без Доты — половина
  const heavy = (AI_DRAFT_MODELS as readonly string[]).includes(model);
  const kind = heavy ? ('draft' as const) : ('ask' as const);
  const configs = heavy
    ? [
        { label: ' (выбор героев, ¼ ядер)', inMatch: false, threads: threadsFor(cpus().length, true) },
        { label: ' (Дота закрыта, ½ ядер)', inMatch: false, threads: threadsFor(cpus().length, false) },
      ]
    : [
        { label: ' (во время матча)', inMatch: true, threads: undefined },
        { label: '', inMatch: false, threads: undefined },
      ];
  for (const { label, inMatch, threads } of configs) {
    it(`${model}${label}`, async () => {
      const { sidecar, service } = await prepareLocal(model, inMatch, threads);
      try {
        const qs = loadQuestions().filter((q) => ids.includes(q.id));
        const t0 = Date.now();
        await sidecar.ensure(model);
        const loadMs = Date.now() - t0;
        // прогрев
        await service.ask({ requestId: 'warm', kind: 'ask', question: 'Привет', facts: [] }, () => undefined);
        let tokens = 0, genMs = 0, firstMs = 0, cpu = 0, wall = 0;
        for (const q of qs) {
          const pid = sidecar.state.pid!;
          const c0 = await cpuMs(pid);
          const w0 = Date.now();
          const r = await service.ask({ requestId: q.id, kind, question: q.question, facts: promptFacts(q) }, () => undefined);
          if (r.model && r.model !== model) throw new Error(`${q.id}: ответила ${r.model}, а не ${model}`);
          const w1 = Date.now();
          const c1 = await cpuMs(pid);
          if (r.error) throw new Error(`${q.id}: ${r.error.message}`);
          tokens += r.chunks;
          firstMs += r.firstChunkMs ?? 0;
          genMs += r.totalMs - (r.firstChunkMs ?? 0);
          if (c0 !== null && c1 !== null) {
            cpu += c1 - c0;
            wall += w1 - w0;
          }
        }
        const ram = await processRamBytes(sidecar.state.pid!);
        results.push({
          model,
          mode: label.trim() || 'обычный',
          inMatch,
          threads: sidecar.state.threads,
          cores: cpus().length,
          loadSec: +(loadMs / 1000).toFixed(1),
          firstTokenSec: +(firstMs / qs.length / 1000).toFixed(1),
          tokensPerSec: +((tokens - qs.length) / (genMs / 1000)).toFixed(1),
          avgTokens: Math.round(tokens / qs.length),
          ramMb: ram ? Math.round(ram / 1024 / 1024) : null,
          // доля всего процессора (все логические ядра) во время ответа
          cpuPercentOfAll: wall ? Math.round((cpu / wall / cpus().length) * 100) : null,
        });
      } finally {
        sidecar.stop();
      }
    });
  }
}
