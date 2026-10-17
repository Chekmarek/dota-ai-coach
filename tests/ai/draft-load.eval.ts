// Нагрузка модели драфта для замера FPS Доты (запускать вручную, с открытой Дотой):
//   DOTACOACH_AI_MODELS=qwen3-8b npx vitest run --config vitest.ai.config.ts tests/ai/draft-load.eval.ts
// Фазы: простой → загрузка и непрерывные ответы на ¼ ядер (как при выборе героев) → простой → то же на ½ ядер.
// Окна фаз (время начала и конца), загрузка, первый токен, токены/с и пиковая память — в .tmp/draft-load.json.
// FPS снимается отдельно (счётчик Доты на экране) и сопоставляется с окнами по времени.
import { mkdirSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join, resolve } from 'node:path';
import { it } from 'vitest';
import { localModels, prepareLocal } from './local-runtime';
import { processRamBytes } from '../../src/main/ai/local/sidecar';
import { threadsFor } from '../../src/main/ai/local/manifest';
import { CoachLookup } from '../../src/core/coach/data';
import { draftFacts, enemyThreats, suggestHeroes } from '../../src/core/draft/index';
import { realData } from '../unit/coach-sim';

const ROOT = resolve(import.meta.dirname, '../..');
const IDLE_MS = Number(process.env.DRAFT_LOAD_IDLE_MS ?? 20_000);
const GEN_MS = Number(process.env.DRAFT_LOAD_GEN_MS ?? 45_000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function facts(): string[] {
  const data = realData();
  const look = new CoachLookup(data);
  const enemies = ['bristleback', 'invoker', 'riki'];
  const allies = ['lion'];
  const c = suggestHeroes(look, { allies, enemies, limit: 3 });
  return draftFacts({ candidates: c, name: (k) => look.heroName(k), enemies, allies, position: null, patch: data.stats?.patch ?? null, statsAt: data.stats?.generatedAt ?? null, threats: enemyThreats(enemies, look.invisHeroes), itemName: (k) => look.itemName(k) });
}

it('нагрузка модели драфта: окна фаз и скорость', { timeout: 30 * 60_000 }, async () => {
  const model = localModels()[0]!;
  const f = facts();
  const phases: Record<string, unknown>[] = [];
  const mark = (phase: string, start: number, extra: Record<string, unknown> = {}) => phases.push({ phase, start, end: Date.now(), ...extra });

  let t = Date.now();
  await sleep(IDLE_MS);
  mark('простой', t);

  for (const [label, threads] of [
    ['¼ ядер (выбор героев)', threadsFor(cpus().length, true)],
    ['½ ядер', threadsFor(cpus().length, false)],
  ] as const) {
    const { sidecar, service } = await prepareLocal(model, false, threads);
    try {
      t = Date.now();
      await sidecar.ensure(model);
      mark(`загрузка, ${label}`, t, { threads });
      t = Date.now();
      let n = 0, tokens = 0, genMs = 0, firstMs = 0, peakRam = 0;
      const ramTimer = setInterval(() => void processRamBytes(sidecar.state.pid!).then((b) => (peakRam = Math.max(peakRam, b ?? 0))), 1000);
      let answer = '';
      while (Date.now() - t < GEN_MS) {
        const r = await service.ask({ requestId: `l${n}`, kind: 'draft', facts: f }, () => undefined);
        if (r.error) throw new Error(r.error.message);
        if (r.model !== model) throw new Error(`ответила ${r.model}`);
        n++;
        tokens += r.chunks;
        firstMs += r.firstChunkMs ?? 0;
        genMs += r.totalMs - (r.firstChunkMs ?? 0);
        answer = r.text;
      }
      clearInterval(ramTimer);
      mark(`генерация, ${label}`, t, {
        threads,
        answers: n,
        firstTokenSec: +(firstMs / n / 1000).toFixed(1),
        tokensPerSec: +((tokens - n) / (genMs / 1000)).toFixed(1),
        avgAnswerSec: +((Date.now() - t) / n / 1000).toFixed(1),
        peakRamMb: Math.round(peakRam / 1024 / 1024),
        lastAnswer: answer,
      });
    } finally {
      sidecar.stop();
    }
    t = Date.now();
    await sleep(IDLE_MS / 2);
    mark('простой', t);
  }
  mkdirSync(join(ROOT, '.tmp'), { recursive: true });
  writeFileSync(join(ROOT, '.tmp/draft-load.json'), JSON.stringify({ model, cores: cpus().length, facts: f, phases }, null, 2));
  console.table(phases.map(({ lastAnswer: _, ...p }) => p));
});
