// Поддельный OpenAI-совместимый сервер на 127.0.0.1 для тестов ИИ (unit, e2e, ai:eval на CI).
// Режим по умолчанию — «оракул»: отвечает строками фактов, больше всего похожими на вопрос, т. е. проверяет
// сборку фактов коуча, а не умение модели. Только node:http — без новых зависимостей.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockMode = 'stream' | 'json' | 'status' | 'hang' | 'hang-after-first' | 'stream-error';

export interface MockOptions {
  mode?: MockMode;
  status?: number;
  /** Свой ответ вместо оракула */
  reply?: (req: MockRequest) => string;
  /** Пауза между кусочками потока, мс */
  chunkDelayMs?: number;
}

export interface MockRequest {
  headers: IncomingMessage['headers'];
  body: { model?: string; messages?: { role: string; content: string }[]; max_tokens?: number; stream?: boolean; [k: string]: unknown };
}

export interface MockServer {
  url: string;
  requests: MockRequest[];
  set(opts: MockOptions): void;
  close(): Promise<void>;
}

const words = (s: string) =>
  (s.toLowerCase().match(/[a-zа-яё0-9]+/giu) ?? []).filter((w) => w.length >= 3 && !STOP.has(w)).map((w) => w.slice(0, 5));
const STOP = new Set(['сколько', 'какой', 'какая', 'какие', 'когда', 'что', 'как', 'где', 'это', 'мне', 'мой', 'моя', 'мои', 'у', 'the', 'есть', 'был', 'была', 'для', 'при', 'или']);

/** Оракул: 1–2 строки фактов с наибольшим пересечением слов с вопросом; без пересечения — «не знаю» */
export function oracleReply(req: MockRequest): string {
  const msgs = req.body.messages ?? [];
  const system = msgs.find((m) => m.role === 'system')?.content ?? '';
  const question = [...msgs].reverse().find((m) => m.role === 'user')?.content.replace('/no_think', '') ?? '';
  const facts = system
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2));
  const q = new Set(words(question));
  const scored = facts
    .map((f, i) => ({ f, i, s: words(f).filter((w) => q.has(w)).length }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || a.i - b.i);
  if (!/Факты:\n- /.test(system) || facts.length === 0) return 'Не знаю: в данных коуча этого нет.';
  if (question.includes('разбор')) return facts.slice(0, 10).map((f) => `— ${f}`).join('\n');
  // без общих слов — первая строка: коуч ставит найденное по вопросу в начало
  // (строка «Режим игры» стоит первой всегда — она не «найденное по вопросу», её пропускаем)
  if (scored.length === 0) return facts.find((f) => !f.startsWith('Режим игры:')) ?? facts[0]!;
  return scored
    .slice(0, 2)
    .map((x) => x.f)
    .join('. ');
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let s = '';
    req.setEncoding('utf8');
    req.on('data', (d: string) => (s += d));
    req.on('end', () => resolve(s));
  });
}

export async function startMockOpenAi(initial: MockOptions = {}): Promise<MockServer> {
  let opts: MockOptions = initial;
  const requests: MockRequest[] = [];
  const open = new Set<ServerResponse>();
  const server: Server = createServer(async (req, res) => {
    open.add(res);
    res.on('close', () => open.delete(res));
    const raw = await readBody(req);
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
      res.writeHead(404).end();
      return;
    }
    let body: MockRequest['body'] = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* пусто */
    }
    const r: MockRequest = { headers: req.headers, body };
    requests.push(r);
    const mode = opts.mode ?? 'stream';
    if (mode === 'status') {
      res.writeHead(opts.status ?? 500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'mock error' } }));
      return;
    }
    if (mode === 'hang') return; // не отвечаем вовсе
    const text = (opts.reply ?? oracleReply)(r);
    if (mode === 'json') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const parts = text.match(/\S+\s*/g) ?? [text];
    for (let i = 0; i < parts.length; i++) {
      if (res.destroyed) return;
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: parts[i] } }] })}\n\n`);
      if (mode === 'hang-after-first') return;
      if (mode === 'stream-error' && i === 0) {
        res.end(`data: ${JSON.stringify({ error: { message: 'boom' } })}\n\n`);
        return;
      }
      if (opts.chunkDelayMs) await new Promise((x) => setTimeout(x, opts.chunkDelayMs));
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    set: (o) => (opts = o),
    close: () =>
      new Promise<void>((resolve) => {
        for (const res of open) res.destroy();
        server.close(() => resolve());
      }),
  };
}
