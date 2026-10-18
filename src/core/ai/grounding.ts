// Проверка ответа ИИ: каждое число в ответе должно встречаться в фактах, которые получила модель (или в вопросе).
// Иначе ответ помечается «⚠ не проверено», а такие числа подсвечиваются. Время «мм:сс» сравнивается и как секунды.
// Чистое ядро.
import { latinAliases } from './aliases.ts';

let aliasSet: Set<string> | null = null;

export interface NumberSpan {
  start: number;
  end: number;
  text: string;
  /** Значение; у времени «мм:сс» — секунды */
  value: number;
  grounded: boolean;
}

export interface GroundingResult {
  ok: boolean;
  numbers: NumberSpan[];
  /** Непроверенные числа и имена латиницей (по порядку в тексте) */
  unverified: NumberSpan[];
}

/** Латинские слова, которые не считаются «именами» (общие сокращения игры) */
const COMMON_LATIN = new Set(['dota', 'gsi', 'hp', 'mp', 'cd', 'xp', 'ai', 'ok']);

/**
 * Имена латиницей в ответе (герои, предметы, команды, турниры): слово с заглавной буквы или сокращение из заглавных.
 * Имя проверено, если встречается в фактах или вопросе (без учёта регистра) или это известное прозвище.
 */
export function unverifiedNames(answer: string, sources: readonly string[], allowed: ReadonlySet<string> = new Set()): NumberSpan[] {
  const known = sources.join(' ').toLowerCase();
  const out: NumberSpan[] = [];
  for (const m of answer.matchAll(/\b[A-Z][A-Za-z'’]{1,}\b/g)) {
    const w = m[0].toLowerCase().replace(/[’']s$/, '');
    if (w.length < 3 || COMMON_LATIN.has(w) || allowed.has(w) || known.includes(w)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], value: NaN, grounded: false });
  }
  return out;
}

/**
 * Фразы по-английски (3+ латинских слова подряд), которых нет в фактах и вопросе: ответ должен быть по-русски.
 * Названия из фактов («Smoke of Deceit», «Black King Bar») не считаются — они пишутся как в клиенте Dota.
 */
export function englishPhrases(answer: string, sources: readonly string[]): NumberSpan[] {
  const known = sources.join(' ').toLowerCase();
  const out: NumberSpan[] = [];
  for (const m of answer.matchAll(/\b[A-Za-z][A-Za-z'’]*(?:[ \t-]+[A-Za-z][A-Za-z'’]*){2,}\b/g)) {
    if (known.includes(m[0].toLowerCase())) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], value: NaN, grounded: false });
  }
  return out;
}

// время «12:05» или «1:02:03»; число с пробелами-разделителями тысяч «2 250»; дробь «2,5» / «7.41»
const NUM_RE = /\d{1,2}(?::\d{2}){1,2}(?!\d)|\d{1,3}(?:[   ]\d{3})+(?![\d,.]\d)|\d+(?:[.,]\d+)?/g;

function parse(text: string): number {
  if (text.includes(':')) {
    const parts = text.split(':').map(Number);
    return parts.reduce((a, p) => a * 60 + p, 0);
  }
  return Number(text.replace(/[   ]/g, '').replace(',', '.'));
}

/** Все числа текста; у времени — и само значение в секундах */
export function extractNumbers(text: string): { start: number; end: number; text: string; value: number; time: boolean }[] {
  const out: { start: number; end: number; text: string; value: number; time: boolean }[] = [];
  for (const m of text.matchAll(NUM_RE)) {
    // часть слова/ключа вроде «Qwen3» или «t1» — не число ответа
    const before = text[m.index - 1];
    if (before && /[A-Za-zА-Яа-яЁё_]/.test(before)) continue;
    out.push({ start: m.index, end: m.index + m[0].length, text: m[0], value: parse(m[0]), time: m[0].includes(':') });
  }
  return out;
}

/** Множество чисел из источников: сами числа и время в секундах */
export function numberSet(sources: readonly string[]): Set<number> {
  const s = new Set<number>();
  for (const src of sources) {
    for (const n of extractNumbers(src)) s.add(n.value);
  }
  return s;
}

export function checkGrounding(answer: string, facts: readonly string[], question = '', allowedNames: ReadonlySet<string> = (aliasSet ??= latinAliases())): GroundingResult {
  const known = numberSet([...facts, question]);
  // «5 минут» в ответе — это и «300 с» в фактах
  const minutes = (n: { end: number; value: number }) => /^\s*мин/i.test(answer.slice(n.end, n.end + 6)) && known.has(n.value * 60);
  const numbers: NumberSpan[] = extractNumbers(answer).map((n) => ({ start: n.start, end: n.end, text: n.text, value: n.value, grounded: known.has(n.value) || minutes(n) }));
  const names = unverifiedNames(answer, [...facts, question], allowedNames);
  // Английская фраза — тоже непроверенный текст (слова с заглавной в ней уже отмечены как имена)
  const english = englishPhrases(answer, [...facts, question]).filter((p) => !names.some((n) => n.start >= p.start && n.end <= p.end));
  const unverified = [...numbers.filter((n) => !n.grounded), ...names, ...english].sort((a, b) => a.start - b.start);
  return { ok: unverified.length === 0, numbers, unverified };
}

/** Кусочки текста для подсветки: обычный текст и непроверенные числа */
export function highlightUnverified(answer: string, g: GroundingResult): { text: string; flagged: boolean }[] {
  const parts: { text: string; flagged: boolean }[] = [];
  let pos = 0;
  for (const n of g.unverified) {
    if (n.start > pos) parts.push({ text: answer.slice(pos, n.start), flagged: false });
    parts.push({ text: answer.slice(n.start, n.end), flagged: true });
    pos = n.end;
  }
  if (pos < answer.length) parts.push({ text: answer.slice(pos), flagged: false });
  return parts;
}
