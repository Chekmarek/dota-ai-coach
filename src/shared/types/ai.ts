import { z } from 'zod';
import type { AiErrorCode } from '../../core/ai/provider.ts';
import type { AiLocalModel, AiProviderSetting } from '../schemas/settings';

// ИИ-помощник: обмен интерфейса с main. Ключи облака сюда не попадают никогда — только «ключ сохранён: да/нет».

const factLine = z.string().min(1).max(400);

export const aiAskPayloadSchema = z
  .object({
    requestId: z.string().regex(/^[\w-]{1,64}$/),
    kind: z.enum(['ask', 'summary', 'card']),
    question: z.string().max(500).optional(),
    facts: z.array(factLine).max(120),
    history: z
      .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(2000) }).strict())
      .max(8)
      .optional(),
    card: z.object({ type: z.string().max(60), severity: z.string().max(20) }).strict().optional(),
  })
  .strict();

export type AiAskPayload = z.infer<typeof aiAskPayloadSchema>;

export const aiKeyPayloadSchema = z.object({ provider: z.literal('openai-compatible'), key: z.string().min(8).max(500) }).strict();

export const aiFeedbackSchema = z
  .object({
    requestId: z.string().regex(/^[\w-]{1,64}$/),
    verdict: z.enum(['useful', 'miss']),
    page: z.string().max(40),
    question: z.string().max(500),
    answer: z.string().max(4000),
    grounded: z.boolean(),
  })
  .strict();

export type AiFeedback = z.infer<typeof aiFeedbackSchema>;

export interface AiAskResult {
  requestId: string;
  text: string;
  error: { code: AiErrorCode; message: string } | null;
  provider: AiProviderSetting;
  facts: string[];
  chunks: number;
  firstChunkMs: number | null;
  totalMs: number;
  limited: boolean;
}

export interface AiChunkMessage {
  requestId: string;
  text: string;
}

/** Скачивание и работа локального ИИ */
export interface AiLocalState {
  /** Что скачано */
  runtimeInstalled: boolean;
  models: { id: AiLocalModel; nameRu: string; sizeBytes: number; installed: boolean }[];
  /** Размер сборки llama.cpp */
  runtimeSizeBytes: number;
  download: {
    status: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'error' | 'done';
    file: string | null;
    received: number;
    total: number;
    error: string | null;
  };
  server: {
    status: 'stopped' | 'starting' | 'ready' | 'error';
    model: AiLocalModel | null;
    error: string | null;
    /** Время загрузки модели, мс */
    loadMs: number | null;
    /** Скорость последнего ответа, токенов в секунду */
    tokensPerSec: number | null;
    /** Память процесса llama-server, байты */
    ramBytes: number | null;
    threads: number | null;
  };
}

export interface AiUiState {
  keys: { openaiCompatible: boolean };
  /** Шифрование Windows доступно (без него ключ не сохранить) */
  encryption: boolean;
  busy: boolean;
  /** Идёт матч — локальная модель отвечает коротко */
  inMatch: boolean;
  local: AiLocalState;
}
