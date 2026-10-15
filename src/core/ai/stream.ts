// Разбор потокового ответа OpenAI-совместимого /v1/chat/completions (Server-Sent Events) и очистка текста модели.
// Чистое ядро: на входе — уже декодированные строки, сеть — в src/main/ai.

/** Собирает строки SSE в события: возвращает содержимое полей data: каждого законченного события */
export class SseDecoder {
  private buffer = '';
  private data: string[] = [];

  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      let line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        if (this.data.length) out.push(this.data.join('\n'));
        this.data = [];
      } else if (line.startsWith('data:')) {
        this.data.push(line.slice(5).replace(/^ /, ''));
      }
      // event:, id:, retry: и комментарии (": …") не нужны
    }
    return out;
  }

  /** Конец потока: незавершённое событие тоже отдаём */
  end(): string[] {
    const rest = this.push('\n\n');
    if (this.buffer.trim().startsWith('data:')) rest.push(this.buffer.trim().slice(5).trim());
    this.buffer = '';
    return rest;
  }
}

export type SseDelta = { kind: 'text'; text: string } | { kind: 'done' } | { kind: 'error'; message: string } | { kind: 'skip' };

/** Одно событие data → кусок текста; [DONE] — конец; {error} — ошибка сервера внутри потока */
export function parseChatDelta(data: string): SseDelta {
  const d = data.trim();
  if (d === '[DONE]') return { kind: 'done' };
  let json: unknown;
  try {
    json = JSON.parse(d);
  } catch {
    return { kind: 'skip' };
  }
  if (!json || typeof json !== 'object') return { kind: 'skip' };
  const j = json as { error?: { message?: unknown }; choices?: { delta?: { content?: unknown }; message?: { content?: unknown }; finish_reason?: unknown }[] };
  if (j.error) return { kind: 'error', message: typeof j.error.message === 'string' ? j.error.message : 'error' };
  const c = j.choices?.[0];
  const text = c?.delta?.content ?? c?.message?.content;
  if (typeof text === 'string' && text.length) return { kind: 'text', text };
  return { kind: 'skip' };
}

/**
 * Убирает размышления модели (<think>…</think> у Qwen3) из потока: теги могут прийти разрезанными между кусками.
 * Текст до закрытия незакрытого блока не отдаётся.
 */
export class ThinkStripper {
  private pending = '';
  private inThink = false;
  /** Ещё ничего не отдали: пустые строки в начале (и после размышлений) не нужны */
  private atStart = true;

  push(chunk: string): string {
    const out = this.strip(chunk);
    return this.lead(out);
  }

  private lead(out: string): string {
    if (!this.atStart) return out;
    const t = out.replace(/^\s+/, '');
    if (t) this.atStart = false;
    return t;
  }

  private strip(chunk: string): string {
    this.pending += chunk;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const end = this.pending.indexOf('</think>');
        if (end < 0) {
          // держим только возможное начало закрывающего тега
          this.pending = this.pending.slice(Math.max(0, this.pending.length - 7));
          return out;
        }
        this.pending = this.pending.slice(end + 8);
        this.inThink = false;
        continue;
      }
      const start = this.pending.indexOf('<think>');
      if (start >= 0) {
        out += this.pending.slice(0, start);
        this.pending = this.pending.slice(start + 7);
        this.inThink = true;
        continue;
      }
      // хвост может оказаться началом «<think>» — придержим его
      const lt = this.pending.lastIndexOf('<');
      if (lt >= 0 && '<think>'.startsWith(this.pending.slice(lt))) {
        out += this.pending.slice(0, lt);
        this.pending = this.pending.slice(lt);
      } else {
        out += this.pending;
        this.pending = '';
      }
      return out;
    }
  }

  end(): string {
    const rest = this.inThink ? '' : this.pending;
    this.pending = '';
    return this.lead(rest);
  }
}

/** Окончательная чистка ответа: без размышлений, без пустых строк по краям */
export function cleanAnswer(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, '')
    .replace(/<think>[\s\S]*$/, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
