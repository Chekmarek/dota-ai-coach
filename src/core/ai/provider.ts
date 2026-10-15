// Слой поставщиков ИИ (этап 1 ИИ): общий интерфейс для локальной модели и облака.
// ИИ ничего не считает и не смотрит игру сам — только пересказывает факты, которые посчитал коуч.
// Чистое ядро: без Electron, DOM, сети и файлов (сетевые клиенты — в src/main/ai).

/** Кто отвечает: локальная модель на CPU, GigaChat или любой OpenAI-совместимый сервер; mock — только тесты */
export type AiProviderId = 'local' | 'gigachat' | 'openai-compatible' | 'mock';

export interface AiMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AiRequest {
  system: string;
  messages: AiMessage[];
  maxTokens: number;
  temperature: number;
  signal?: AbortSignal;
}

export interface AiProvider {
  readonly id: AiProviderId;
  /** Поток кусочков текста ответа. Ошибки — AiError */
  generate(req: AiRequest): AsyncIterable<string>;
}

export type AiErrorCode =
  | 'offline'
  | 'bad-key'
  | 'rate-limit'
  | 'timeout'
  | 'cancelled'
  | 'server'
  | 'bad-response'
  | 'busy'
  | 'not-configured'
  | 'no-consent'
  | 'unavailable'
  | 'local-missing'
  | 'local-failed';

/** Тексты ошибок для пользователя */
export const AI_ERROR_RU: Record<AiErrorCode, string> = {
  offline: 'Нет интернета или сервер ИИ недоступен',
  'bad-key': 'Неверный ключ доступа к ИИ',
  'rate-limit': 'Лимит запросов к ИИ исчерпан — попробуйте позже',
  timeout: 'ИИ не ответил вовремя',
  cancelled: 'Ответ остановлен',
  server: 'Ошибка на стороне сервера ИИ',
  'bad-response': 'Сервер ИИ ответил непонятно',
  busy: 'Коуч ещё отвечает на прошлый вопрос — подождите или остановите его',
  'not-configured': 'ИИ-помощник не настроен: выберите, кто отвечает, на странице «ИИ-помощник»',
  'no-consent': 'Нет согласия на отправку данных в облако — включите его на странице «ИИ-помощник»',
  unavailable: 'Этот вариант ИИ сейчас недоступен',
  'local-missing': 'Локальный ИИ не скачан — нажмите «Скачать локальный ИИ»',
  'local-failed': 'Локальный ИИ не запустился',
};

export class AiError extends Error {
  constructor(
    readonly code: AiErrorCode,
    message: string = AI_ERROR_RU[code],
  ) {
    super(message);
    this.name = 'AiError';
  }
}

/** Любая ошибка → AiError (неизвестное — «ошибка сервера», без подробностей, где мог оказаться ключ) */
export function toAiError(err: unknown): AiError {
  if (err instanceof AiError) return err;
  return new AiError('server');
}

/** Склеивает поток в строку (для тестов и коротких фраз) */
export async function collect(stream: AsyncIterable<string>): Promise<string> {
  let out = '';
  for await (const chunk of stream) out += chunk;
  return out;
}
