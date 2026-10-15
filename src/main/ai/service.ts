// Запросы к ИИ в main: выбор поставщика по настройкам, согласие на облако, таймауты, «Стоп», один запрос за раз.
// Без Electron (зависимости передаются снаружи) — проверяется unit-тестами с поддельным сервером на 127.0.0.1.
import { AiError, toAiError, type AiErrorCode, type AiMessage, type AiProvider } from '@core/ai/provider.ts';
import { NO_FACTS_ANSWER, buildAskPrompt, buildCardPrompt, buildSummaryPrompt, trimToSentence, type BuiltPrompt, type PromptKind } from '@core/ai/prompt.ts';
import { cleanAnswer } from '@core/ai/stream.ts';
import type { AiLocalModel, Settings } from '@shared/schemas/settings';
import { openAiCompatibleProvider } from './openai-client';
import type { KeyProvider } from './keys';

export interface AiTimeouts {
  /** До первого кусочка ответа (локальной модели нужно прочитать факты на CPU) */
  firstTokenCloudMs: number;
  firstTokenLocalMs: number;
  /** Пауза между кусочками */
  idleMs: number;
  /** Весь ответ */
  totalMs: number;
}

export const DEFAULT_TIMEOUTS: AiTimeouts = { firstTokenCloudMs: 30_000, firstTokenLocalMs: 120_000, idleMs: 30_000, totalMs: 180_000 };

/** Длина ответа в токенах; во время матча локальная модель отвечает коротко (защита FPS Доты) */
export const MAX_TOKENS: Record<PromptKind, number> = { ask: 300, summary: 500, card: 60 };
export const IN_MATCH_MAX_TOKENS = 120;
export const TEMPERATURE = 0.2;

export interface LocalRuntime {
  /** Запускает llama-server (если ещё не запущен) и возвращает базовый адрес …/v1. Ошибки — AiError */
  ensure(model: AiLocalModel, signal: AbortSignal): Promise<string>;
  /** Отметка использования (отсчёт простоя до остановки) */
  touch(): void;
}

export interface AiServiceDeps {
  getSettings(): Settings;
  keys: { get(p: KeyProvider): string | null };
  local: LocalRuntime | null;
  /** Живой захват или GSI видят идущий матч Доты */
  inMatch(): boolean;
  log(line: string): void;
  fetchImpl?: typeof fetch;
  timeouts?: Partial<AiTimeouts>;
}

export interface AskInput {
  requestId: string;
  kind: PromptKind;
  /** Вопрос (kind = ask) */
  question?: string;
  facts: string[];
  history?: AiMessage[];
  card?: { type: string; severity: string };
}

export interface AskResult {
  requestId: string;
  text: string;
  error: { code: AiErrorCode; message: string } | null;
  provider: Settings['ai']['provider'];
  /** Факты, которые реально получила модель (для проверки чисел) */
  facts: string[];
  /** Кусочков потока (у llama-server ≈ токенов) */
  chunks: number;
  firstChunkMs: number | null;
  totalMs: number;
  /** Ответ укорочен: идёт матч, локальная модель */
  limited: boolean;
}

function buildPrompt(input: AskInput, short: boolean): BuiltPrompt {
  if (input.kind === 'summary') return buildSummaryPrompt(input.facts);
  if (input.kind === 'card') return buildCardPrompt(input.card?.type ?? 'hint', input.facts, input.card?.severity ?? 'info');
  return buildAskPrompt(input.question ?? '', input.facts, input.history ?? [], short);
}

export class AiService {
  private current: { id: string; ctrl: AbortController } | null = null;
  private readonly t: AiTimeouts;

  constructor(private readonly deps: AiServiceDeps) {
    this.t = { ...DEFAULT_TIMEOUTS, ...deps.timeouts };
  }

  get busy(): boolean {
    return this.current !== null;
  }

  /** Останавливает текущий ответ (или только указанный) */
  cancel(requestId?: string): void {
    if (!this.current || (requestId && this.current.id !== requestId)) return;
    this.current.ctrl.abort(new AiError('cancelled'));
  }

  /** Поставщик по настройкам; ошибки настройки — AiError */
  private async provider(s: Settings['ai'], signal: AbortSignal): Promise<AiProvider> {
    if (s.provider === 'off') throw new AiError('not-configured');
    if (s.provider === 'gigachat') throw new AiError('unavailable', 'GigaChat пока недоступен: ему нужен отдельный корневой сертификат, коуч его не устанавливает');
    if (s.provider === 'openai-compatible') {
      if (!s.sendToCloudConsent) throw new AiError('no-consent');
      if (!s.cloud.baseUrl || !s.cloud.model) throw new AiError('not-configured', 'Укажите адрес и модель облачного ИИ на странице «ИИ-помощник»');
      return openAiCompatibleProvider({
        id: 'openai-compatible',
        baseUrl: s.cloud.baseUrl,
        model: s.cloud.model,
        apiKey: this.deps.keys.get('openai-compatible'),
        fetchImpl: this.deps.fetchImpl,
      });
    }
    if (!this.deps.local) throw new AiError('unavailable');
    const baseUrl = await this.deps.local.ensure(s.local.model, signal);
    return openAiCompatibleProvider({
      id: 'local',
      baseUrl,
      model: s.local.model,
      apiKey: null,
      // Qwen3 без размышлений: быстрее и короче
      extraBody: { chat_template_kwargs: { enable_thinking: false } },
      fetchImpl: this.deps.fetchImpl,
    });
  }

  /** Один запрос: кусочки — в onChunk, итог — в результате (не бросает) */
  async ask(input: AskInput, onChunk: (text: string) => void): Promise<AskResult> {
    const settings = this.deps.getSettings().ai;
    const started = Date.now();
    // во время матча локальная модель отвечает коротко — и подсказка просит об этом заранее
    const short = settings.provider === 'local' && this.deps.inMatch();
    const prompt = buildPrompt(input, short);
    const base: AskResult = { requestId: input.requestId, text: '', error: null, provider: settings.provider, facts: prompt.facts, chunks: 0, firstChunkMs: null, totalMs: 0, limited: false };
    if (this.current) return { ...base, error: { code: 'busy', message: new AiError('busy').message } };
    // фактов нет — отвечать нечем: модель не спрашиваем (иначе маленькая модель выдумывает)
    if (input.kind === 'ask' && prompt.facts.length === 0 && settings.provider !== 'off') {
      onChunk(NO_FACTS_ANSWER);
      return { ...base, text: NO_FACTS_ANSWER, chunks: 1, firstChunkMs: 0, totalMs: Date.now() - started };
    }

    const ctrl = new AbortController();
    this.current = { id: input.requestId, ctrl };
    let timer: ReturnType<typeof setTimeout> | null = null;
    const arm = (ms: number) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(new AiError('timeout')), ms);
    };
    const total = setTimeout(() => ctrl.abort(new AiError('timeout')), this.t.totalMs);
    let text = '';
    let chunks = 0;
    let firstChunkMs: number | null = null;
    let limited = false;
    try {
      const provider = await this.provider(settings, ctrl.signal);
      const local = provider.id === 'local';
      let maxTokens = MAX_TOKENS[input.kind];
      if (local && this.deps.inMatch() && maxTokens > IN_MATCH_MAX_TOKENS) {
        maxTokens = IN_MATCH_MAX_TOKENS;
        limited = true;
      }
      const messages = prompt.messages.map((m, i) => (local && i === prompt.messages.length - 1 && m.role === 'user' ? { ...m, content: `${m.content} /no_think` } : m));
      arm(local ? this.t.firstTokenLocalMs : this.t.firstTokenCloudMs);
      for await (const chunk of provider.generate({ system: prompt.system, messages, maxTokens, temperature: TEMPERATURE, signal: ctrl.signal })) {
        if (ctrl.signal.aborted) break;
        if (firstChunkMs === null) firstChunkMs = Date.now() - started;
        chunks++;
        text += chunk;
        onChunk(chunk);
        arm(this.t.idleMs);
        if (local) this.deps.local?.touch();
      }
      if (ctrl.signal.aborted) throw ctrl.signal.reason instanceof AiError ? ctrl.signal.reason : new AiError('cancelled');
      if (local) this.deps.local?.touch();
      // упёрлись в предел токенов — без оборванного на полуслове хвоста
      const answer = chunks >= maxTokens - 1 ? trimToSentence(cleanAnswer(text)) : cleanAnswer(text);
      return { ...base, text: answer, chunks, firstChunkMs, totalMs: Date.now() - started, limited };
    } catch (err) {
      const e = ctrl.signal.aborted && ctrl.signal.reason instanceof AiError ? ctrl.signal.reason : toAiError(err);
      // в журнал — только код ошибки и поставщик, ни вопроса, ни ключа
      this.deps.log(`ai ошибка: ${e.code} (${settings.provider})`);
      return { ...base, text: cleanAnswer(text), error: { code: e.code, message: e.message }, chunks, firstChunkMs, totalMs: Date.now() - started, limited };
    } finally {
      if (timer) clearTimeout(timer);
      clearTimeout(total);
      this.current = null;
    }
  }
}
