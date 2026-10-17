import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalInstaller } from '../../src/main/ai/local/installer';
import { LlamaSidecar } from '../../src/main/ai/local/sidecar';
import { MODELS, RUNTIME, threadsFor } from '../../src/main/ai/local/manifest';
import { openAiCompatibleProvider } from '../../src/main/ai/openai-client';
import { AiError, collect } from '../../src/core/ai/provider';
import type { AiLocalModel } from '../../src/shared/schemas/settings';

// Поддельный «Hugging Face»: отдаёт файлы с поддержкой Range; первый запрос модели обрывает на середине
const MODEL = Buffer.alloc(256 * 1024, 7);
const ZIP = Buffer.from('zip-bytes');
let server: Server;
let base = '';
let modelRequests: string[] = [];
let breakFirst = true;

beforeAll(async () => {
  server = createServer((req, res) => {
    const data = req.url === '/model.gguf' ? MODEL : req.url === '/runtime.zip' ? ZIP : null;
    if (!data) return void res.writeHead(404).end();
    const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
    const from = range ? Number(range[1]) : 0;
    if (req.url === '/model.gguf') modelRequests.push(req.headers.range ?? 'full');
    res.writeHead(range ? 206 : 200, { 'content-length': data.length - from });
    if (req.url === '/model.gguf' && breakFirst) {
      breakFirst = false;
      res.write(data.subarray(from, from + 100_000));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(data.subarray(from));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

function files(modelSha = sha(MODEL)) {
  const m = (id: AiLocalModel) => ({ ...MODELS[id], url: `${base}/model.gguf`, sizeBytes: MODEL.length, sha256: modelSha });
  return {
    runtime: { ...RUNTIME, url: `${base}/runtime.zip`, sizeBytes: ZIP.length, sha256: sha(ZIP) },
    models: { 'qwen3-1.7b': m('qwen3-1.7b'), 'qwen3-4b': m('qwen3-4b') },
  };
}

/** Распаковка-заглушка: кладёт llama-server.exe */
const fakeExtract = async (_zip: string, dir: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'llama-server.exe'), 'exe');
};

describe('скачивание локального ИИ', () => {
  it('обрыв связи → докачка с места обрыва (Range), проверка SHA-256, отметка «проверено»', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-ai-'));
    modelRequests = [];
    breakFirst = true;
    const progress: string[] = [];
    const inst = new LocalInstaller(dir, (p) => progress.push(p.status), { extract: fakeExtract, retryDelayMs: 10, files: files() });
    expect(inst.runtimeInstalled()).toBe(false);
    await inst.install('qwen3-1.7b', new AbortController().signal);
    expect(inst.runtimeInstalled()).toBe(true);
    expect(inst.modelInstalled('qwen3-1.7b')).toBe(true);
    expect(inst.modelInstalled('qwen3-4b')).toBe(false);
    expect(modelRequests[0]).toBe('full');
    expect(modelRequests[1]).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(modelRequests[1]!)![0])).toBeGreaterThan(0);
    expect(sha(readFileSync(inst.modelPath('qwen3-1.7b')))).toBe(sha(MODEL));
    expect(progress).toContain('verifying');
    expect(progress.at(-1)).toBe('done');
    // архив после распаковки удалён, .part не осталось
    expect(existsSync(join(dir, 'ai', RUNTIME.fileName))).toBe(false);
    expect(existsSync(`${inst.modelPath('qwen3-1.7b')}.part`)).toBe(false);
    inst.removeAll();
    expect(existsSync(join(dir, 'ai'))).toBe(false);
  });

  it('SHA-256 не совпал — файл не принимается, ошибка по-русски', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-ai-'));
    breakFirst = false;
    const inst = new LocalInstaller(dir, () => undefined, { extract: fakeExtract, retryDelayMs: 1, files: files('0'.repeat(64)) });
    await expect(inst.install('qwen3-1.7b', new AbortController().signal)).rejects.toThrow(/SHA-256 не совпал/);
    expect(inst.modelInstalled('qwen3-1.7b')).toBe(false);
    expect(inst.progress.status).toBe('error');
  });

  it('не удаётся записать файл (на месте .part папка) — ошибка по-русски, а не вечное «скачивается»', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-ai-'));
    breakFirst = false;
    const inst = new LocalInstaller(dir, () => undefined, { extract: fakeExtract, retryDelayMs: 1, files: files() });
    mkdirSync(`${inst.modelPath('qwen3-1.7b')}.part`, { recursive: true });
    const hang = new Promise<string>((r) => setTimeout(() => r('завис'), 5000));
    const res = await Promise.race([inst.install('qwen3-1.7b', new AbortController().signal).then(() => 'установлено', (e: Error) => e.message), hang]);
    expect(res).toMatch(/^Не удалось записать .+ на диск/);
    expect(inst.progress.status).toBe('error');
    expect(inst.modelInstalled('qwen3-1.7b')).toBe(false);
  });

  it('манифест: закреплённые версии, размеры и SHA-256; потоки — половина ядер, не меньше 2', () => {
    expect(RUNTIME.url).toContain('/releases/download/b');
    for (const m of Object.values(MODELS)) {
      expect(m.url).toMatch(/huggingface\.co\/.+\/resolve\/[0-9a-f]{40}\/.+Q4_K_M\.gguf$/);
      expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(m.license).toBe('Apache-2.0');
    }
    expect([threadsFor(1), threadsFor(4), threadsFor(12), threadsFor(16)]).toEqual([2, 2, 6, 8]);
    // во время матча — четверть ядер, не меньше 2
    expect([threadsFor(4, true), threadsFor(12, true), threadsFor(16, true)]).toEqual([2, 3, 4]);
  });
});

describe('llama-server (поддельный, на node)', () => {
  const fake = join(import.meta.dirname, '../ai/fake-llama-server.mjs');
  const make = (opts: { idleStopMs?: number; installed?: boolean; crash?: boolean } = {}) =>
    new LlamaSidecar({
      exe: () => 'llama-server.exe',
      modelPath: () => 'model.gguf',
      installed: () => opts.installed ?? true,
      idleStopMs: opts.idleStopMs,
      threads: 3,
      command: (_exe, args) => ({ file: process.execPath, args: [fake, ...args, ...(opts.crash ? ['--crash'] : [])] }),
    });

  it('запуск на 127.0.0.1 со случайным портом, ответ через тот же клиент, остановка', async () => {
    const sc = make();
    const url = await sc.ensure('qwen3-1.7b');
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    expect(sc.state).toMatchObject({ status: 'ready', model: 'qwen3-1.7b', threads: 3 });
    expect(sc.state.loadMs).toBeGreaterThanOrEqual(250);
    // повторный вызов — тот же сервер
    expect(await sc.ensure('qwen3-1.7b')).toBe(url);
    const p = openAiCompatibleProvider({ id: 'local', baseUrl: url, model: 'qwen3-1.7b', apiKey: null });
    expect(await collect(p.generate({ system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 10, temperature: 0 }))).toBe('Ответ локальной модели.');
    sc.stop();
    expect(sc.state.status).toBe('stopped');
  });

  it('останавливается после простоя', async () => {
    const sc = make({ idleStopMs: 200 });
    await sc.ensure('qwen3-1.7b');
    await new Promise((r) => setTimeout(r, 500));
    expect(sc.state.status).toBe('stopped');
  });

  it('модель не скачана / процесс упал — понятные ошибки', async () => {
    await expect(make({ installed: false }).ensure('qwen3-4b')).rejects.toMatchObject({ code: 'local-missing' });
    const err = await make({ crash: true }).ensure('qwen3-1.7b').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe('local-failed');
  });
});
