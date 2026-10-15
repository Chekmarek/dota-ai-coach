import { useEffect, useState } from 'react';
import type { AiAskPayload, AiAskResult, AiUiState } from '@shared/types/ai';

// Состояние ИИ-помощника (одно на приложение) и запросы с потоковым ответом.

let state: AiUiState | null = null;
const listeners = new Set<(s: AiUiState) => void>();
const chunkHandlers = new Map<string, (text: string) => void>();
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed) return;
  subscribed = true;
  window.dotacoach.onAiState((s) => setAiState(s));
  window.dotacoach.onAiChunk((m) => chunkHandlers.get(m.requestId)?.(m.text));
  void window.dotacoach.getAiState().then(setAiState);
}

export function setAiState(s: AiUiState): void {
  state = s;
  for (const l of listeners) l(s);
}

export function useAiState(): AiUiState | null {
  const [s, set] = useState<AiUiState | null>(state);
  useEffect(() => {
    ensureSubscribed();
    listeners.add(set);
    if (state) set(state);
    return () => {
      listeners.delete(set);
    };
  }, []);
  return s;
}

let seq = 0;
export function newRequestId(): string {
  return `r${Date.now().toString(36)}-${(seq++).toString(36)}`;
}

/** Запрос к ИИ: кусочки ответа — в onChunk, итог — в промисе */
export async function askAi(payload: AiAskPayload, onChunk: (text: string) => void): Promise<AiAskResult> {
  ensureSubscribed();
  chunkHandlers.set(payload.requestId, onChunk);
  try {
    return await window.dotacoach.askAi(payload);
  } finally {
    chunkHandlers.delete(payload.requestId);
  }
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2).replace('.', ',')} ГБ`;
  return `${Math.round(n / 1024 ** 2)} МБ`;
}
