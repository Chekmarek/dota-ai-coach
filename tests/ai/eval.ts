// Оценка ИИ-помощника по tests/ai/questions.json: на CI — с поддельным сервером-«оракулом» (проверяет сборку фактов),
// в npm run ai:eval — с настоящей локальной моделью.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assembleFacts, type AiFacts, type AiPage } from '../../src/core/ai/facts';
import { limitFacts } from '../../src/core/ai/prompt';
import { checkGrounding } from '../../src/core/ai/grounding';
import { loadKb, stateFor, type EvalContext } from './fixtures';

export interface EvalQuestion {
  id: string;
  page: AiPage;
  context: EvalContext;
  question: string;
  expectFacts: string[];
  expectAnswer: string[];
  unknown?: boolean;
}

export function loadQuestions(): EvalQuestion[] {
  return (JSON.parse(readFileSync(join(import.meta.dirname, 'questions.json'), 'utf8')) as { questions: EvalQuestion[] }).questions;
}

export function factsFor(q: EvalQuestion): AiFacts {
  return assembleFacts({ page: q.page, question: q.question, match: stateFor(q.context), replay: q.context === 'replay', kb: loadKb() });
}

/** Факты, которые реально уйдут модели (после обрезки по длине) */
export function promptFacts(q: EvalQuestion): string[] {
  return limitFacts(factsFor(q).lines);
}

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е').replace(/(\d)[   ](?=\d{3}\b)/g, '$1');
const UNKNOWN_RE = /не знаю|нет данных|неизвестн|нет информац|не могу сказать|не указан|нет сведений|не видно/;

export interface EvalScore {
  id: string;
  pass: boolean;
  grounded: boolean;
  why: string;
  answer: string;
}

export function scoreAnswer(q: EvalQuestion, answer: string, facts: string[]): EvalScore {
  const a = norm(answer);
  const g = checkGrounding(answer, facts, q.question);
  if (q.unknown) {
    const pass = UNKNOWN_RE.test(a) && g.ok;
    return { id: q.id, pass, grounded: g.ok, why: pass ? '' : UNKNOWN_RE.test(a) ? 'непроверенные числа' : 'нет «не знаю»', answer };
  }
  // время «м:сс» засчитывается и в секундах («5:00» = «300 секунд»): это то же значение из фактов
  const has = (x: string) => {
    if (a.includes(norm(x))) return true;
    const t = /^(\d+):(\d{2})$/.exec(x);
    if (!t) return false;
    if (new RegExp(`(^|\\D)${Number(t[1]) * 60 + Number(t[2])}\\s*(с|сек)`).test(a)) return true;
    // «20:00» = «20 минут»
    return t[2] === '00' && new RegExp(`(^|\\D)${Number(t[1])}\\s*мин`).test(a);
  };
  const missing = q.expectAnswer.filter((x) => !has(x));
  const pass = missing.length === 0 && g.ok;
  return { id: q.id, pass, grounded: g.ok, why: pass ? '' : missing.length ? `нет: ${missing.join(', ')}` : `непроверенные числа: ${g.unverified.map((n) => n.text).join(', ')}`, answer };
}
