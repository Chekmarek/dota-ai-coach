// Подсказки-карточки для будущих детекторов ошибок (этап 4): ИИ перефразирует карточку, если успел за timeoutMs,
// иначе — русский шаблон. Числа ответа ИИ проверяются; непроверенная фраза заменяется шаблоном.
// К живым уведомлениям пока не подключено. Чистое ядро: поставщик передаётся снаружи.
import { buildCardPrompt } from './prompt.ts';
import { cleanAnswer } from './stream.ts';
import { checkGrounding } from './grounding.ts';
import type { AiProvider } from './provider.ts';

export type CardSeverity = 'info' | 'warn' | 'danger';

export interface CoachCard {
  type: string;
  facts: Record<string, string | number>;
  severity: CardSeverity;
}

export interface PhrasedCard {
  text: string;
  source: 'ai' | 'template';
  /** Почему шаблон: нет ИИ, не успел, ошибка, непроверенные числа */
  reason: 'no-provider' | 'timeout' | 'error' | 'ungrounded' | 'empty' | null;
}

/** Шаблоны: {имя} — значение из facts */
export const CARD_TEMPLATES: Record<string, string> = {
  'missed-rune': 'Руна {rune} в {time} осталась без внимания',
  'death-without-buyback': 'Нет золота на выкуп: нужно {need}, есть {gold}',
  'idle': 'Вы стоите на месте уже {seconds} с',
  'stack-window': 'Окно стака лагеря: {time}',
  'low-hp': 'Мало здоровья: {hp} из {max}',
};

export function renderTemplate(card: CoachCard): string {
  const tpl = CARD_TEMPLATES[card.type];
  if (!tpl) return Object.entries(card.facts).map(([k, v]) => `${k}: ${v}`).join(', ');
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => (card.facts[k] !== undefined ? String(card.facts[k]) : '?'));
}

/** Строки фактов карточки для модели */
export function cardFacts(card: CoachCard): string[] {
  return [`Подсказка: ${renderTemplate(card)}`, ...Object.entries(card.facts).map(([k, v]) => `${k}: ${v}`)];
}

export async function phraseCard(card: CoachCard, opts: { timeoutMs?: number; provider?: AiProvider | null } = {}): Promise<PhrasedCard> {
  const template = renderTemplate(card);
  if (!opts.provider) return { text: template, source: 'template', reason: 'no-provider' };
  const facts = cardFacts(card);
  const prompt = buildCardPrompt(card.type, facts, card.severity);
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      ctrl.abort();
      resolve('timeout');
    }, opts.timeoutMs ?? 1000);
  });
  const run = (async () => {
    let text = '';
    for await (const c of opts.provider!.generate({ system: prompt.system, messages: prompt.messages, maxTokens: 60, temperature: 0.2, signal: ctrl.signal })) text += c;
    return cleanAnswer(text);
  })();
  try {
    const r = await Promise.race([run, timeout]);
    if (r === 'timeout') {
      run.catch(() => undefined);
      return { text: template, source: 'template', reason: 'timeout' };
    }
    if (!r) return { text: template, source: 'template', reason: 'empty' };
    if (!checkGrounding(r, prompt.facts).ok) return { text: template, source: 'template', reason: 'ungrounded' };
    return { text: r, source: 'ai', reason: null };
  } catch {
    return { text: template, source: 'template', reason: 'error' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
