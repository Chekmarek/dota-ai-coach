// Проверка ответа ИИ о драфте перед показом: числа — только из фактов, герои — только из фактов (латиница и русские
// прозвища), первым назван лучший кандидат правил, длина — для уведомления. Не прошёл — показывается текст правил.
// Чистое ядро.
import { checkGrounding } from './grounding.ts';
import { HERO_ALIASES } from './aliases.ts';

export interface DraftCheckInput {
  answer: string;
  facts: readonly string[];
  /** Все герои базы знаний: ключ и имя */
  heroes: readonly { key: string; name: string }[];
  /** Ключи героев, которые есть в фактах (враги, союзники, кандидаты) */
  allowedHeroes: readonly string[];
  /** Ключ лучшего кандидата правил: должен быть назван первым */
  topHero: string;
  /** Предел длины уведомления, символов */
  maxChars?: number;
}

export interface DraftCheck {
  ok: boolean;
  /** Числа, которых нет в фактах */
  inventedNumbers: string[];
  /** Герои, которых нет в фактах */
  inventedHeroes: string[];
  /** Первый названный герой (ключ); null — ни одного */
  firstHero: string | null;
  topFirst: boolean;
  tooLong: boolean;
  /** Обещание победы («гарантированно», «точно выиграете») */
  promises: boolean;
  /** Числа не при своём герое или с неверным знаком («слабее» при плюсе) */
  misattributed: string[];
  /** Не годится для уведомления: повтор вопроса, списки, разметка */
  badFormat: boolean;
}

export const DRAFT_MAX_CHARS = 260;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Упоминания героев в тексте: [позиция, ключ]. Имена — целиком; прозвища — целыми словами (без «ам» внутри «амулета») */
export function heroMentions(text: string, heroes: readonly { key: string; name: string }[]): { at: number; key: string }[] {
  const out: { at: number; key: string }[] = [];
  const low = text.toLowerCase();
  for (const h of heroes) {
    const words = [h.name.toLowerCase(), ...(HERO_ALIASES[h.key] ?? [])];
    for (const w of words) {
      if (w.length < 2) continue;
      // граница слова для кириллицы и латиницы; русскому прозвищу от 4 букв — окончание до 2 букв («пуджа», «инвокера»)
      const ending = /^[а-яё ]{4,}$/.test(w) ? '[а-яё]{0,2}' : '';
      const re = new RegExp(`(^|[^a-zа-яё0-9])${esc(w)}${ending}(?![a-zа-яё0-9'’])`, 'g');
      for (const m of low.matchAll(re)) out.push({ at: m.index + m[1]!.length, key: h.key });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** «+5,7» / «−0,6» / «5,7» → число со знаком (без знака — null) и модулем */
function parseSigned(s: string): { signed: number | null; abs: number } {
  const m = /^([+−-])?\s*(\d+(?:[.,]\d+)?)$/.exec(s.trim());
  if (!m) return { signed: null, abs: NaN };
  const abs = Number(m[2]!.replace(',', '.'));
  return { signed: m[1] ? (m[1] === '+' ? abs : -abs) : null, abs };
}

/**
 * Пары «герой — число» из фактов драфта: итог и вклады кандидата принадлежат кандидату, вклад «против X» / «в связке с X» —
 * ещё и герою X; число игр — так же. Проценты со знаком, игры — целые.
 */
export function factPairs(facts: readonly string[], heroes: readonly { key: string; name: string }[]): { hero: string; value: number; pct: boolean }[] {
  const out: { hero: string; value: number; pct: boolean }[] = [];
  for (const f of facts) {
    const head = /^Кандидат \d+: ([^,]+), итог ([+−-]?\d+(?:,\d+)?)%/.exec(f);
    if (!head) continue;
    const cand = heroMentions(head[1]!, heroes)[0]?.key;
    if (!cand) continue;
    out.push({ hero: cand, value: parseSigned(head[2]!).signed ?? 0, pct: true });
    for (const clause of f.slice(head[0].length).split(';')) {
      const other = heroMentions(clause, heroes)[0]?.key ?? null;
      const p = /([+−-]\d+(?:,\d+)?)%/.exec(clause);
      const g = /\((\d[\d\s ]*)\s+игр/.exec(clause);
      for (const h of [cand, other]) {
        if (!h) continue;
        if (p) out.push({ hero: h, value: parseSigned(p[1]!).signed!, pct: true });
        if (g) out.push({ hero: h, value: Number(g[1]!.replace(/[\s ]/g, '')), pct: false });
      }
    }
  }
  return out;
}

/**
 * Числа ответа, которые стоят не при своём герое: процент или число игр должны принадлежать одному из героев того же
 * или предыдущего предложения; знак, если написан, — совпадать; «слабее/хуже» при положительном числе — ошибка.
 */
export function misattributed(answer: string, facts: readonly string[], heroes: readonly { key: string; name: string }[]): string[] {
  const pairs = factPairs(facts, heroes);
  const bad: string[] = [];
  let prevHeroes: string[] = [];
  for (const sentence of answer.split(/(?<=[.!?])\s+|\n+/)) {
    const hs = heroMentions(sentence.replace(/monkey king bar/gi, ' '), heroes).map((m) => m.key);
    // «Возьмите Dazzle. Он даёт +6,9%, особенно против Centaur…» — «он» из прошлого предложения: смотрим оба;
    // «Slardar даёт +4,9%» — только герои этого предложения
    const pronoun = /^\s*(он|она|его|ему|этот герой)(?![а-яё])/i.test(sentence);
    const scope = hs.length && !pronoun ? hs : [...hs, ...prevHeroes];
    if (hs.length) prevHeroes = hs;
    for (const m of sentence.matchAll(/([+−-]?\s?\d+(?:,\d+)?)\s?%|(\d{1,3}(?:[\s ]\d{3})*|\d+)\s+игр/g)) {
      const pct = m[1] !== undefined;
      const { signed, abs } = pct ? parseSigned(m[1]!.replace(/\s/g, '')) : { signed: null, abs: Number(m[2]!.replace(/[\s ]/g, '')) };
      const ok = pairs.some((p) => p.pct === pct && scope.includes(p.hero) && (signed !== null ? Math.abs(p.value - signed) < 1e-9 : Math.abs(Math.abs(p.value) - abs) < 1e-9));
      // «слабее на 0,9%», «хуже» — при положительном вкладе это неправда
      const weakerWord = pct && /слабее|хуже|проигрыва/i.test(sentence.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20));
      const positive = pairs.some((p) => p.pct && scope.includes(p.hero) && Math.abs(Math.abs(p.value) - abs) < 1e-9 && p.value > 0);
      const negative = pairs.some((p) => p.pct && scope.includes(p.hero) && Math.abs(Math.abs(p.value) - abs) < 1e-9 && p.value < 0);
      if (!ok || (weakerWord && positive && !negative)) bad.push(m[0].trim());
    }
  }
  return bad;
}

export function checkDraftAnswer(i: DraftCheckInput): DraftCheck {
  const g = checkGrounding(i.answer, i.facts);
  const inventedNumbers = g.numbers.filter((n) => !n.grounded).map((n) => n.text);
  // предметы с именами героев (Monkey King Bar) — не упоминание героя
  const text = i.answer.replace(/monkey king bar/gi, ' ');
  const mentions = heroMentions(text, i.heroes);
  const allowed = new Set(i.allowedHeroes);
  const inventedHeroes = [...new Set(mentions.filter((m) => !allowed.has(m.key)).map((m) => m.key))];
  const firstHero = mentions[0]?.key ?? null;
  const tooLong = i.answer.length > (i.maxChars ?? DRAFT_MAX_CHARS);
  const promises = /гарантир|точно (по)?бед|точно выигра|100\s?%/i.test(i.answer);
  const topFirst = firstHero === i.topHero;
  const wrongPlace = misattributed(i.answer, i.facts, i.heroes);
  // флаг m: ^ — начало каждой строки (списки «- …», «1. …»)
  const badFormat = /кого сейчас взять|^\s*[-*•]\s|\*\*|^\s*\d+\.\s/im.test(i.answer);
  return {
    ok: !inventedNumbers.length && !inventedHeroes.length && !wrongPlace.length && topFirst && !tooLong && !promises && !badFormat,
    badFormat,
    inventedNumbers,
    inventedHeroes,
    firstHero,
    topFirst,
    tooLong,
    promises,
    misattributed: wrongPlace,
  };
}
