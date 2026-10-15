// Клиент OpenAI-совместимого /v1/chat/completions с потоковой выдачей (SSE). Им пользуются и облако
// (ключ пользователя), и локальный llama-server на 127.0.0.1. Без Electron — проверяется unit-тестами.
// Ключ уходит только в заголовке Authorization и никогда не попадает в тексты ошибок и журнал.
import { AiError, type AiProvider, type AiProviderId, type AiRequest } from '@core/ai/provider.ts';
import { SseDecoder, ThinkStripper, parseChatDelta } from '@core/ai/stream.ts';

export interface OpenAiClientOptions {
  id: AiProviderId;
  /** Например https://api.example.com/v1 или http://127.0.0.1:8080/v1 */
  baseUrl: string;
  model: string;
  apiKey: string | null;
  /** Дополнительные поля тела запроса (локальной модели — выключить размышления Qwen3) */
  extraBody?: Record<string, unknown>;
  fetchImpl?: typeof fetch;
}

/** Адрес запроса из базового: «…/v1» → «…/v1/chat/completions»; лишние «/» в конце убираются */
export function chatCompletionsUrl(baseUrl: string): string {
  const b = baseUrl.trim().replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

/** Код ответа HTTP → ошибка для пользователя */
export function httpError(status: number): AiError {
  if (status === 401 || status === 403) return new AiError('bad-key');
  if (status === 429) return new AiError('rate-limit');
  if (status >= 500) return new AiError('server', `Ошибка на стороне сервера ИИ (код ${status})`);
  if (status === 404) return new AiError('bad-response', 'Сервер ИИ не нашёл адрес или модель (код 404) — проверьте адрес и имя модели');
  return new AiError('bad-response', `Сервер ИИ отклонил запрос (код ${status})`);
}

/** Ошибка, с которой прервали запрос (таймаут или «Стоп»), иначе — «нет интернета» */
function abortOr(signal: AbortSignal | undefined, fallback: AiError): AiError {
  if (signal?.aborted) return signal.reason instanceof AiError ? signal.reason : new AiError('cancelled');
  return fallback;
}

export function openAiCompatibleProvider(opts: OpenAiClientOptions): AiProvider {
  const doFetch = opts.fetchImpl ?? fetch;
  return {
    id: opts.id,
    async *generate(req: AiRequest): AsyncIterable<string> {
      const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'text/event-stream' };
      if (opts.apiKey) headers.authorization = `Bearer ${opts.apiKey}`;
      const body = {
        model: opts.model,
        messages: [{ role: 'system', content: req.system }, ...req.messages],
        max_tokens: req.maxTokens,
        temperature: req.temperature,
        stream: true,
        ...opts.extraBody,
      };
      let res: Response;
      try {
        res = await doFetch(chatCompletionsUrl(opts.baseUrl), { method: 'POST', headers, body: JSON.stringify(body), signal: req.signal });
      } catch {
        throw abortOr(req.signal, new AiError('offline'));
      }
      if (!res.ok) {
        // тело ошибки не читаем в журнал: в нём бывает эхо запроса
        void res.body?.cancel().catch(() => undefined);
        throw httpError(res.status);
      }
      const think = new ThinkStripper();
      const type = res.headers.get('content-type') ?? '';
      if (!type.includes('text/event-stream')) {
        // сервер не умеет поток — обычный JSON целиком
        let text: string;
        try {
          text = await res.text();
        } catch {
          throw abortOr(req.signal, new AiError('offline'));
        }
        const d = parseChatDelta(text);
        if (d.kind === 'error') throw new AiError('server');
        if (d.kind !== 'text') throw new AiError('bad-response');
        const out = think.push(d.text) + think.end();
        if (out) yield out;
        return;
      }
      if (!res.body) throw new AiError('bad-response');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const sse = new SseDecoder();
      try {
        for (;;) {
          let r: ReadableStreamReadResult<Uint8Array>;
          try {
            r = await reader.read();
          } catch {
            throw abortOr(req.signal, new AiError('offline'));
          }
          const events = r.done ? sse.push(decoder.decode()).concat(sse.end()) : sse.push(decoder.decode(r.value, { stream: true }));
          for (const data of events) {
            const d = parseChatDelta(data);
            if (d.kind === 'done') {
              const rest = think.end();
              if (rest) yield rest;
              return;
            }
            if (d.kind === 'error') throw new AiError('server');
            if (d.kind === 'text') {
              const t = think.push(d.text);
              if (t) yield t;
            }
          }
          if (r.done) break;
        }
        const rest = think.end();
        if (rest) yield rest;
      } finally {
        reader.cancel().catch(() => undefined);
      }
    },
  };
}
