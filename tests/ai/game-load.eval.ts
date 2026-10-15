// Имитация игры (npm run ai:bench): 4 потока обычного приоритета считают «кадр» с целью 144 к/с; замеряются
// средние к/с и 1 % худших кадров без ИИ и пока llama-server отвечает (короткие ответы, как во время матча).
// Это приближение: настоящая Dota нагружает ещё и видеокарту; замер FPS в самой Доте — отдельно.
import { Worker } from 'node:worker_threads';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { it } from 'vitest';
import { localModels, prepareLocal } from './local-runtime';
import { loadQuestions, promptFacts } from './eval';

const ROOT = resolve(import.meta.dirname, '../..');
const TARGET_FPS = 144;
const THREADS = 4;
/** Доля кадра, занятая счётом в каждом потоке (остальное — ожидание следующего кадра) */
const BUSY_SHARE = 0.6;

const workerSrc = `
const { parentPort, workerData } = require('node:worker_threads');
const frameMs = 1000 / workerData.fps;
const sab = new Int32Array(new SharedArrayBuffer(4));
function work(n) { let x = 0; for (let j = 0; j < n; j++) for (let i = 0; i < 1000; i++) x += Math.sqrt(i * j); return x; }
let sink = 0;
parentPort.on('message', ({ durMs, iters: fixed }) => {
  // разогрев 2 с: подбираем объём счёта так, чтобы он занимал busy-долю кадра (если объём не задан)
  let iters = fixed || 50;
  if (!fixed) {
    const warmEnd = performance.now() + 2000;
    while (performance.now() < warmEnd) {
      const t = performance.now(); sink += work(iters); const busy = performance.now() - t;
      iters = Math.max(1, Math.round(iters * Math.min(2, (frameMs * workerData.busy) / Math.max(busy, 0.01))));
    }
  }
  const frames = []; const end = performance.now() + durMs; let next = performance.now();
  while (performance.now() < end) {
    const f0 = performance.now();
    sink += work(iters);
    next += frameMs;
    const wait = next - performance.now();
    // таймер Windows грубый (~15 мс): спим с запасом, остаток дожидаемся циклом — как игра с ограничением к/с
    if (wait > 0) { if (wait > 3) Atomics.wait(sab, 0, 0, wait - 3); while (performance.now() < next); } else next = performance.now();
    frames.push(performance.now() - f0);
  }
  parentPort.postMessage({ frames, iters, sink });
});`;

async function runGame(ms: number, iters: number[] | null): Promise<{ fps: number; low1: number; iters: number[] }> {
  const workers = Array.from({ length: THREADS }, () => new Worker(workerSrc, { eval: true, workerData: { fps: TARGET_FPS, busy: BUSY_SHARE } }));
  const res = await Promise.all(
    workers.map((w, k) => new Promise<{ frames: number[]; iters: number }>((r) => (w.once('message', r), w.postMessage({ durMs: ms, iters: iters?.[k] ?? 0 })))),
  );
  for (const w of workers) void w.terminate();
  // кадры всех потоков вместе (потоки не синхронизированы): средние к/с и 1 % худших кадров
  const frames = res.flatMap((r) => r.frames);
  const n = frames.length;
  const sorted = [...frames].sort((a, b) => b - a);
  const worst = sorted.slice(0, Math.max(1, Math.floor(n / 100)));
  return {
    fps: +(1000 / (frames.reduce((a, b) => a + b, 0) / n)).toFixed(1),
    low1: +(1000 / (worst.reduce((a, b) => a + b, 0) / worst.length)).toFixed(1),
    iters: res.map((r) => r.iters),
  };
}

it('имитация игры: к/с без ИИ и во время ответа', async () => {
  const model = localModels()[0]!;
  const { sidecar, service } = await prepareLocal(model, true);
  try {
    await sidecar.ensure(model);
    // разогрев и подбор объёма счёта, затем по два чередующихся прогона по 10 с: без ИИ / с ИИ
    const iters = (await runGame(3_000, null)).iters;
    let busy = false;
    const qs = loadQuestions().filter((q) => q.context !== 'none');
    let answers = 0;
    let stop = false;
    const load = (async () => {
      for (let i = 0; !stop; i++) {
        if (!busy) {
          await new Promise((r) => setTimeout(r, 100));
          continue;
        }
        const q = qs[i % qs.length]!;
        await service.ask({ requestId: `g${i}`, kind: 'ask', question: q.question, facts: promptFacts(q) }, () => undefined);
        answers++;
      }
    })();
    const runs: { ai: boolean; fps: number; low1: number }[] = [];
    for (const ai of [false, true, false, true]) {
      busy = ai;
      const g = await runGame(10_000, iters);
      runs.push({ ai, fps: g.fps, low1: g.low1 });
    }
    stop = true;
    await load;
    const avg = (ai: boolean, k: 'fps' | 'low1') => +(runs.filter((x) => x.ai === ai).reduce((s, x) => s + x[k], 0) / 2).toFixed(1);
    const base = { fps: avg(false, 'fps'), low1: avg(false, 'low1') };
    const withAi = { fps: avg(true, 'fps'), low1: avg(true, 'low1') };
    const r = { model, targetFps: TARGET_FPS, threads: THREADS, runs, base, withAi, answersDuring: answers, fpsDropPct: Math.round((1 - withAi.fps / base.fps) * 100), low1DropPct: Math.round((1 - withAi.low1 / base.low1) * 100) };
    console.log(JSON.stringify(r));
    writeFileSync(join(ROOT, '.tmp/ai-game-load.json'), JSON.stringify(r, null, 2));
  } finally {
    sidecar.stop();
  }
});
