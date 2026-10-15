// Подсказки (промпты) для ИИ. Модель получает только факты, посчитанные коучем, и пересказывает их по-русски.
// Чистое ядро.
import type { AiMessage } from './provider.ts';

/** Сколько фактов и символов отдаём модели (контекст локальной модели ≤ 4096 токенов) */
export const MAX_FACTS = 60;
export const MAX_FACT_CHARS = 300;
export const MAX_FACTS_TOTAL_CHARS = 6000;
export const MAX_QUESTION_CHARS = 500;
/** Сколько прошлых реплик чата отдаём модели */
export const MAX_HISTORY = 4;

export type PromptKind = 'ask' | 'summary' | 'card';

export interface BuiltPrompt {
  system: string;
  messages: AiMessage[];
  /** Факты, которые реально попали в подсказку (после обрезки) — по ним проверяются числа в ответе */
  facts: string[];
}

const COMMON = [
  'Ты — коуч по Dota 2 в программе Dota AI Coach. Пиши только по-русски, просто и коротко.',
  'Используй ТОЛЬКО факты из списка «Факты». Ничего не добавляй из своей памяти об игре.',
  'Не придумывай и не вычисляй числа: каждое число в ответе должно буквально встречаться в фактах.',
  'Если нужного факта нет, ответь «не знаю» и скажи, каких данных не хватает.',
];

/** Обрезает список фактов под пределы контекста */
export function limitFacts(facts: readonly string[]): string[] {
  const out: string[] = [];
  let total = 0;
  for (const f of facts) {
    const line = f.replace(/\s+/g, ' ').trim().slice(0, MAX_FACT_CHARS);
    if (!line) continue;
    if (out.length >= MAX_FACTS || total + line.length > MAX_FACTS_TOTAL_CHARS) break;
    out.push(line);
    total += line.length;
  }
  return out;
}

function factBlock(facts: readonly string[]): string {
  return facts.length ? `Факты:\n${facts.map((f) => `- ${f}`).join('\n')}` : 'Факты: (нет данных)';
}

/** Вопрос пользователя («Спроси коуча»): 1–5 предложений */
export function buildAskPrompt(question: string, facts: readonly string[], history: readonly AiMessage[] = [], short = false): BuiltPrompt {
  const f = limitFacts(facts);
  const len = short ? 'Идёт матч: отвечай одним-двумя короткими предложениями, только главное.' : 'Отвечай 1–5 предложениями, без списков и заголовков.';
  const system = [...COMMON, 'Не называй команды, игроков, турниры и другие имена, которых нет в фактах.', len, '', factBlock(f)].join('\n');
  const past = history.slice(-MAX_HISTORY).map((m) => ({ role: m.role, content: m.content.slice(0, 1000) }));
  return { system, messages: [...past, { role: 'user', content: question.trim().slice(0, MAX_QUESTION_CHARS) }], facts: f };
}

/** Обрезает ответ, упёршийся в предел токенов, до последнего законченного предложения */
export function trimToSentence(text: string): string {
  const t = text.trimEnd();
  if (/[.!?…»)]$/.test(t)) return t;
  const m = /^[\s\S]*[.!?…](?=\s|$)/.exec(t);
  return m && m[0].length >= t.length * 0.4 ? m[0] : `${t}…`;
}

/** Ответ без фактов не нужен модели: «не знаю» без выдумок */
export const NO_FACTS_ANSWER = 'Не знаю: в данных коуча нет сведений об этом.';

/** Разбор матча: не больше 10 строк по фактам после матча */
export function buildSummaryPrompt(facts: readonly string[]): BuiltPrompt {
  const f = limitFacts(facts);
  const system = [
    ...COMMON,
    'Напиши разбор матча для игрока: не больше 10 коротких строк, каждая с новой строки и начинается с «— ».',
    'Сначала главное: смерти и когда, потом золото, уровни и предметы, потом простои. Тон дружелюбный, без оценок «плохо/ужасно».',
    '',
    factBlock(f),
  ].join('\n');
  return { system, messages: [{ role: 'user', content: 'Сделай разбор этого матча.' }], facts: f };
}

/** Подсказка-карточка (будущие детекторы ошибок): одна фраза до 15 слов */
export function buildCardPrompt(type: string, facts: readonly string[], severity: string): BuiltPrompt {
  const f = limitFacts(facts);
  const system = [
    ...COMMON,
    'Перескажи подсказку игроку одной фразой не длиннее 15 слов, как короткое уведомление во время игры.',
    '',
    factBlock(f),
  ].join('\n');
  return { system, messages: [{ role: 'user', content: `Подсказка «${type}», важность: ${severity}.` }], facts: f };
}
