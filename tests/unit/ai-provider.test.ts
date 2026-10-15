import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockOpenAi, type MockServer } from '../ai/mock-openai';
import { openAiCompatibleProvider, chatCompletionsUrl } from '../../src/main/ai/openai-client';
import { AiService, type AiServiceDeps } from '../../src/main/ai/service';
import { KeyStore, type Encryptor } from '../../src/main/ai/keys';
import { SseDecoder, ThinkStripper, parseChatDelta, cleanAnswer } from '../../src/core/ai/stream';
import { AiError, collect } from '../../src/core/ai/provider';
import { applySettingsPatch, defaultSettings, settingsPatchSchema, settingsSchema, type Settings } from '../../src/shared/schemas/settings';

const KEY = 'sk-test-SECRET-1234567890';

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOpenAi();
});
afterAll(() => mock.close());
afterEach(() => {
  mock.set({});
  mock.requests.length = 0;
});

function cloudSettings(over: Partial<Settings['ai']> = {}): Settings {
  const s = defaultSettings();
  return { ...s, ai: { ...s.ai, provider: 'openai-compatible', cloud: { baseUrl: mock.url, model: 'mock-model' }, sendToCloudConsent: true, ...over } };
}

function service(settings: () => Settings, log: string[] = [], timeouts?: AiServiceDeps['timeouts']) {
  return new AiService({ getSettings: settings, keys: { get: () => KEY }, local: null, inMatch: () => false, log: (l) => log.push(l), timeouts });
}

describe('разбор потока SSE', () => {
  it('события, разрезанные на куски, собираются', () => {
    const d = new SseDecoder();
    const a = d.push('data: {"choices":[{"delta":{"content":"При"}}]}\n');
    const b = d.push('\ndata: {"choices":[{"delta":{"content":"вет"}}]}\r\n\r\ndata: [DO');
    const c = d.push('NE]\n\n');
    expect(a).toHaveLength(0); // событие ещё не закончено пустой строкой
    expect([...a, ...b, ...c].map(parseChatDelta)).toEqual([
      { kind: 'text', text: 'При' },
      { kind: 'text', text: 'вет' },
      { kind: 'done' },
    ]);
  });

  it('размышления Qwen3 вырезаются даже при разрезанных тегах', () => {
    const t = new ThinkStripper();
    const out = ['Отв', '<thi', 'nk>секрет', ' мысли</th', 'ink>ет', ' готов'].map((x) => t.push(x)).join('') + t.end();
    expect(out).toBe('Ответ готов');
    expect(cleanAnswer('<think>\n</think>\n\nДа.')).toBe('Да.');
  });

  it('адрес запроса', () => {
    expect(chatCompletionsUrl('https://x.ru/v1/')).toBe('https://x.ru/v1/chat/completions');
    expect(chatCompletionsUrl('https://x.ru/v1/chat/completions')).toBe('https://x.ru/v1/chat/completions');
  });
});

describe('OpenAI-совместимый клиент (поддельный сервер 127.0.0.1)', () => {
  it('потоковый ответ приходит кусочками, ключ — в заголовке', async () => {
    mock.set({ reply: () => 'Блинк стоит 2250 золота.' });
    const p = openAiCompatibleProvider({ id: 'openai-compatible', baseUrl: mock.url, model: 'm', apiKey: KEY });
    const chunks: string[] = [];
    for await (const c of p.generate({ system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 50, temperature: 0.2 })) chunks.push(c);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join('')).toBe('Блинк стоит 2250 золота.');
    expect(mock.requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(mock.requests[0]!.body.stream).toBe(true);
    expect(mock.requests[0]!.body.max_tokens).toBe(50);
  });

  it('сервер без потока (обычный JSON) тоже понимается', async () => {
    mock.set({ mode: 'json', reply: () => 'Да.' });
    const p = openAiCompatibleProvider({ id: 'openai-compatible', baseUrl: mock.url, model: 'm', apiKey: null });
    expect(await collect(p.generate({ system: 's', messages: [], maxTokens: 5, temperature: 0 }))).toBe('Да.');
    expect(mock.requests[0]!.headers.authorization).toBeUndefined();
  });

  it.each([
    [401, 'bad-key', 'Неверный ключ'],
    [403, 'bad-key', 'Неверный ключ'],
    [429, 'rate-limit', 'Лимит запросов'],
    [500, 'server', 'сервера ИИ'],
  ])('код %i → %s по-русски', async (status, code, text) => {
    mock.set({ mode: 'status', status });
    const p = openAiCompatibleProvider({ id: 'openai-compatible', baseUrl: mock.url, model: 'm', apiKey: KEY });
    const err = await collect(p.generate({ system: 's', messages: [], maxTokens: 5, temperature: 0 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).code).toBe(code);
    expect((err as AiError).message).toContain(text);
    expect((err as AiError).message).not.toContain(KEY);
  });

  it('сервер недоступен → «нет интернета»', async () => {
    const p = openAiCompatibleProvider({ id: 'openai-compatible', baseUrl: 'http://127.0.0.1:1/v1', model: 'm', apiKey: KEY });
    const err = (await collect(p.generate({ system: 's', messages: [], maxTokens: 5, temperature: 0 })).catch((e: unknown) => e)) as AiError;
    expect(err.code).toBe('offline');
    expect(err.message).toContain('Нет интернета');
  });

  it('ошибка внутри потока', async () => {
    mock.set({ mode: 'stream-error', reply: () => 'раз два три' });
    const p = openAiCompatibleProvider({ id: 'openai-compatible', baseUrl: mock.url, model: 'm', apiKey: KEY });
    const err = (await collect(p.generate({ system: 's', messages: [], maxTokens: 5, temperature: 0 })).catch((e: unknown) => e)) as AiError;
    expect(err.code).toBe('server');
  });
});

describe('сервис ИИ: настройки, таймауты, «Стоп», один запрос', () => {
  it('ответ по фактам, в журнале нет ни ключа, ни вопроса', async () => {
    mock.set({ mode: 'status', status: 401 });
    const log: string[] = [];
    const svc = service(() => cloudSettings(), log);
    const r = await svc.ask({ requestId: 'a', kind: 'ask', question: 'Секретный вопрос?', facts: ['Цена Blink Dagger: 2250 золота'] }, () => undefined);
    expect(r.error?.code).toBe('bad-key');
    expect(log.join('\n')).not.toContain(KEY);
    expect(log.join('\n')).not.toContain('Секретный');
    mock.set({});
    const chunks: string[] = [];
    const ok = await svc.ask({ requestId: 'b', kind: 'ask', question: 'Сколько стоит Blink Dagger?', facts: ['Цена Blink Dagger: 2250 золота', 'Ночь начинается в 05:00'] }, (c) => chunks.push(c));
    expect(ok.error).toBeNull();
    expect(ok.text).toBe('Цена Blink Dagger: 2250 золота');
    expect(chunks.join('')).toBe(ok.text);
    expect(ok.facts).toHaveLength(2);
    // факты — в системной подсказке, вопрос — последним сообщением
    const msgs = mock.requests.at(-1)!.body.messages!;
    expect(msgs[0]!.role).toBe('system');
    expect(msgs[0]!.content).toContain('- Цена Blink Dagger: 2250 золота');
    expect(msgs.at(-1)!.content).toBe('Сколько стоит Blink Dagger?');
  });

  it('без фактов модель не спрашивается: «не знаю» без выдумок', async () => {
    const svc = service(() => cloudSettings());
    const r = await svc.ask({ requestId: 'n', kind: 'ask', question: 'Кто выиграл The International?', facts: [] }, () => undefined);
    expect(r.text).toContain('Не знаю');
    expect(mock.requests).toHaveLength(0);
  });

  it('во время матча: подсказка просит 1–2 предложения; ответ на пределе токенов — без оборванного хвоста', async () => {
    const s = defaultSettings();
    // 130 кусочков — больше предела 120: хвост «В бли» должен уйти
    mock.set({ reply: () => `${Array.from({ length: 128 }, (_, i) => (i % 8 === 7 ? 'конец.' : 'слово')).join(' ')} В бли` });
    const local = { ensure: async () => mock.url, touch: () => undefined };
    const svc = new AiService({ getSettings: () => ({ ...s, ai: { ...s.ai, provider: 'local' } }), keys: { get: () => null }, local, inMatch: () => true, log: () => undefined });
    const r = await svc.ask({ requestId: 'a', kind: 'ask', question: 'q', facts: ['факт'] }, () => undefined);
    expect(mock.requests.at(-1)!.body.messages![0]!.content).toContain('одним-двумя');
    expect(r.text.endsWith('конец.')).toBe(true);
  });

  it('без согласия облако не вызывается', async () => {
    const svc = service(() => cloudSettings({ sendToCloudConsent: false }));
    const r = await svc.ask({ requestId: 'a', kind: 'ask', question: 'q', facts: ['факт'] }, () => undefined);
    expect(r.error?.code).toBe('no-consent');
    expect(mock.requests).toHaveLength(0);
  });

  it('ИИ выключен и GigaChat недоступен — понятные ошибки', async () => {
    const off = await service(() => defaultSettings()).ask({ requestId: 'a', kind: 'ask', question: 'q', facts: ['факт'] }, () => undefined);
    expect(off.error?.code).toBe('not-configured');
    const giga = await service(() => cloudSettings({ provider: 'gigachat' })).ask({ requestId: 'a', kind: 'ask', question: 'q', facts: ['факт'] }, () => undefined);
    expect(giga.error?.code).toBe('unavailable');
    expect(mock.requests).toHaveLength(0);
  });

  it('таймаут до первого кусочка и между кусочками', async () => {
    mock.set({ mode: 'hang' });
    const svc = service(() => cloudSettings(), [], { firstTokenCloudMs: 150, idleMs: 150 });
    const r = await svc.ask({ requestId: 'a', kind: 'ask', question: 'q', facts: ['факт'] }, () => undefined);
    expect(r.error?.code).toBe('timeout');
    expect(r.error?.message).toContain('не ответил вовремя');
    mock.set({ mode: 'hang-after-first', reply: () => 'начало ответа' });
    const r2 = await svc.ask({ requestId: 'b', kind: 'ask', question: 'q', facts: ['факт'] }, () => undefined);
    expect(r2.error?.code).toBe('timeout');
    expect(r2.text).toBe('начало');
  });

  it('«Стоп» прерывает ответ; второй запрос во время первого отклоняется', async () => {
    mock.set({ chunkDelayMs: 50, reply: () => 'один два три четыре пять шесть семь восемь девять десять' });
    const svc = service(() => cloudSettings());
    const chunks: string[] = [];
    const first = svc.ask({ requestId: 'a', kind: 'ask', question: 'q', facts: ['факт'] }, (c) => {
      chunks.push(c);
      if (chunks.length === 2) svc.cancel('a');
    });
    const second = await svc.ask({ requestId: 'b', kind: 'ask', question: 'q', facts: ['факт'] }, () => undefined);
    expect(second.error?.code).toBe('busy');
    const r = await first;
    expect(r.error?.code).toBe('cancelled');
    expect(r.text.split(' ').length).toBeLessThan(5);
    expect(svc.busy).toBe(false);
  });

  it('локальная модель во время матча отвечает коротко (≤ 120 токенов), размышления выключены', async () => {
    const s = defaultSettings();
    const local = { ensure: async () => mock.url, touch: () => undefined };
    const svc = new AiService({ getSettings: () => ({ ...s, ai: { ...s.ai, provider: 'local' } }), keys: { get: () => null }, local, inMatch: () => true, log: () => undefined });
    const r = await svc.ask({ requestId: 'a', kind: 'summary', facts: ['Смерть на 10:00'] }, () => undefined);
    expect(r.limited).toBe(true);
    const body = mock.requests.at(-1)!.body;
    expect(body.max_tokens).toBe(120);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.messages!.at(-1)!.content).toContain('/no_think');
    expect(mock.requests.at(-1)!.headers.authorization).toBeUndefined();
  });
});

describe('ключи и настройки ИИ', () => {
  const fake: Encryptor = {
    isEncryptionAvailable: () => true,
    encryptString: (p) => Buffer.from([...Buffer.from(p)].map((b) => b ^ 0x5a)),
    decryptString: (d) => Buffer.from([...d].map((b) => b ^ 0x5a)).toString(),
  };

  it('ключ хранится только зашифрованным', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-keys-'));
    const ks = new KeyStore(dir, fake);
    ks.set('openai-compatible', KEY);
    expect(readFileSync(join(dir, 'keys.json'), 'utf8')).not.toContain(KEY);
    expect(ks.has('openai-compatible')).toBe(true);
    expect(ks.get('openai-compatible')).toBe(KEY);
    ks.clear('openai-compatible');
    expect(ks.get('openai-compatible')).toBeNull();
    expect(() => new KeyStore(dir, { ...fake, isEncryptionAvailable: () => false }).set('openai-compatible', KEY)).toThrow(/не сохранён/);
  });

  it('старый settings.json без раздела ai читается; плохие поля → по умолчанию', () => {
    expect(settingsSchema.parse({ live: { fps: 5 } }).ai).toEqual({ provider: 'off', local: { model: 'qwen3-1.7b' }, cloud: { baseUrl: '', model: '' }, sendToCloudConsent: false });
    const s = settingsSchema.parse({ ai: { provider: 'gpt-9', local: { model: 'qwen3-4b' }, cloud: { baseUrl: 'ftp://x', model: 'm' }, sendToCloudConsent: 'да' } });
    expect(s.ai).toEqual({ provider: 'off', local: { model: 'qwen3-4b' }, cloud: { baseUrl: '', model: 'm' }, sendToCloudConsent: false });
  });

  it('патч ИИ строгий: ключ и GigaChat через него не задать, http — только для этого ПК', () => {
    expect(settingsPatchSchema.safeParse({ ai: { provider: 'local' } }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ ai: { provider: 'gigachat' } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ai: { apiKey: 'x' } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ai: { cloud: { baseUrl: 'http://evil.example/v1' } } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ ai: { cloud: { baseUrl: 'http://127.0.0.1:1234/v1' } } }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ ai: { cloud: { baseUrl: 'https://user:pass@x.ru/v1' } } }).success).toBe(false);
    const s = applySettingsPatch(defaultSettings(), { ai: { cloud: { model: 'm' } } });
    expect(s.ai.cloud).toEqual({ baseUrl: '', model: 'm' });
    expect(JSON.stringify(s)).not.toMatch(/key/i);
  });
});
