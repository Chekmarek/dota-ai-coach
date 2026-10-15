// «Спроси коуча»: вопрос → факты, которые показывает страница → ответ ИИ потоком → проверка чисел.
// Под ответом — какие данные использованы и «Полезно» / «Мимо» (сохраняется только на этом ПК).
import { useRef, useState, type FormEvent } from 'react';
import type { AiAskResult } from '@shared/types/ai';
import type { AiFacts, AiPage } from '@core/ai/facts.ts';
import type { AiMessage } from '@core/ai/provider.ts';
import { checkGrounding, highlightUnverified } from '@core/ai/grounding.ts';
import { askAi, newRequestId } from '../hooks/useAi';
import { useSettings } from '../hooks/useSettings';

interface Turn {
  id: string;
  question: string;
  text: string;
  result: AiAskResult | null;
  used: string[];
  feedback: 'useful' | 'miss' | null;
}

const PROVIDER_RU: Record<string, string> = { off: 'ИИ выключен', local: 'локальная модель', 'openai-compatible': 'облако', gigachat: 'GigaChat' };

/** Ответ с проверкой чисел */
export function AiAnswer({ text, result, question, testId }: { text: string; result: AiAskResult | null; question: string; testId?: string }) {
  if (!result) return <div className="ai-answer streaming" data-testid={testId}>{text || '…'}</div>;
  if (result.error && !result.text)
    return (
      <div className="ai-answer error" data-testid={testId} data-error={result.error.code}>
        {result.error.message}
      </div>
    );
  const g = checkGrounding(result.text, result.facts, question);
  return (
    <div className="ai-answer" data-testid={testId} data-grounded={g.ok ? 'yes' : 'no'}>
      {!g.ok && (
        <div className="ai-unverified-badge" title="В ответе есть числа или имена, которых нет в данных коуча" data-testid="ai-unverified">
          ⚠ не проверено
        </div>
      )}
      <div className="ai-text">
        {highlightUnverified(result.text, g).map((p, i) =>
          p.flagged ? (
            <mark key={i} className="ai-flag" title="Этого нет в данных коуча">
              {p.text}
            </mark>
          ) : (
            <span key={i}>{p.text}</span>
          ),
        )}
      </div>
      {result.error && <div className="error small">{result.error.message}</div>}
      {result.limited && <div className="muted small">Идёт матч — локальный ИИ отвечает коротко, чтобы не мешать игре.</div>}
    </div>
  );
}

function UsedData({ used, facts }: { used: string[]; facts: string[] }) {
  return (
    <details className="ai-used" data-testid="ai-used">
      <summary>Какие данные использованы: {used.join(' · ')}</summary>
      <ul>
        {facts.map((f, i) => (
          <li key={i}>{f}</li>
        ))}
      </ul>
    </details>
  );
}

export function AskCoach({
  page,
  getFacts,
  compact = false,
  placeholder = 'Спросите коуча…',
  chat = false,
}: {
  page: AiPage;
  getFacts: (question: string) => AiFacts;
  compact?: boolean;
  placeholder?: string;
  chat?: boolean;
}) {
  const { settings } = useSettings();
  const provider = settings?.ai.provider ?? null;
  const [q, setQ] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [busy, setBusy] = useState(false);
  const current = useRef<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const question = q.trim();
    if (!question || busy) return;
    const facts = getFacts(question);
    const id = newRequestId();
    current.current = id;
    const history: AiMessage[] = chat
      ? turns
          .filter((t) => t.result && !t.result.error)
          .slice(-2)
          .flatMap((t) => [
            { role: 'user' as const, content: t.question },
            { role: 'assistant' as const, content: t.result!.text },
          ])
      : [];
    const turn: Turn = { id, question, text: '', result: null, used: facts.used, feedback: null };
    setTurns((ts) => (chat ? [...ts, turn] : [turn]));
    setQ('');
    setBusy(true);
    const update = (fn: (t: Turn) => Turn) => setTurns((ts) => ts.map((t) => (t.id === id ? fn(t) : t)));
    try {
      const result = await askAi({ requestId: id, kind: 'ask', question, facts: facts.lines.map((l) => l.slice(0, 400)).slice(0, 120), history }, (chunk) =>
        update((t) => ({ ...t, text: t.text + chunk })),
      );
      update((t) => ({ ...t, result }));
    } catch (err) {
      update((t) => ({ ...t, result: { requestId: id, text: '', error: { code: 'server', message: (err as Error).message }, provider: 'off', facts: [], chunks: 0, firstChunkMs: null, totalMs: 0, limited: false } }));
    } finally {
      setBusy(false);
      current.current = null;
    }
  }

  function feedback(t: Turn, verdict: 'useful' | 'miss') {
    if (!t.result) return;
    void window.dotacoach.sendAiFeedback({
      requestId: t.id,
      verdict,
      page,
      question: t.question.slice(0, 500),
      answer: t.result.text.slice(0, 4000),
      grounded: checkGrounding(t.result.text, t.result.facts, t.question).ok,
    });
    setTurns((ts) => ts.map((x) => (x.id === t.id ? { ...x, feedback: verdict } : x)));
  }

  return (
    <div className={`ask${compact ? ' ask-compact' : ''}`} data-testid={`ask-${page}`}>
      {(chat ? turns : turns.slice(-1)).map((t) => (
        <div className="ask-turn" key={t.id}>
          {chat && <div className="ask-q">{t.question}</div>}
          <AiAnswer text={t.text} result={t.result} question={t.question} testId="ai-answer" />
          {t.result && !(t.result.error && !t.result.text) && (
            <>
              <UsedData used={t.used} facts={t.result.facts} />
              <div className="row small">
                {t.feedback ? (
                  <span className="muted">Спасибо, отмечено: {t.feedback === 'useful' ? 'полезно' : 'мимо'}</span>
                ) : (
                  <>
                    <button className="small-btn" onClick={() => feedback(t, 'useful')} data-testid="ai-useful">
                      👍 Полезно
                    </button>
                    <button className="small-btn" onClick={() => feedback(t, 'miss')} data-testid="ai-miss">
                      👎 Мимо
                    </button>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      ))}
      <form className="ask-form" onSubmit={submit}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} maxLength={500} data-testid="ask-input" aria-label="Вопрос коучу" />
        {busy ? (
          <button type="button" onClick={() => current.current && void window.dotacoach.cancelAi(current.current)} data-testid="ask-stop">
            ■ Стоп
          </button>
        ) : (
          <button type="submit" className="primary" disabled={!q.trim()} data-testid="ask-submit">
            Спросить
          </button>
        )}
      </form>
      <div className="muted small">
        {provider && <span data-testid="ask-provider">{PROVIDER_RU[provider]} · </span>}
        {compact ? 'Отвечает по данным этой страницы; числа сверяются с данными коуча.' : 'Коуч отвечает только по своим данным; чего нет — скажет «не знаю». Числа в ответе сверяются с данными.'}
      </div>
    </div>
  );
}

/** «Разбор матча»: факты всегда; разбор ИИ (≤ 10 строк) — по кнопке */
export function MatchSummary({ label, lines, testId = 'match-summary' }: { label: string; lines: string[]; testId?: string }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<AiAskResult | null>(null);
  const [busy, setBusy] = useState(false);
  const idRef = useRef<string | null>(null);

  async function run() {
    const id = newRequestId();
    idRef.current = id;
    setText('');
    setResult(null);
    setBusy(true);
    try {
      const r = await askAi({ requestId: id, kind: 'summary', facts: lines.slice(0, 120).map((l) => l.slice(0, 400)) }, (c) => setText((t) => t + c));
      setResult(r);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="match-summary" data-testid={testId}>
      <div className="muted small">{label}</div>
      <ul className="summary-facts" data-testid="summary-facts">
        {lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      <div className="row">
        {busy ? (
          <button onClick={() => idRef.current && void window.dotacoach.cancelAi(idRef.current)}>■ Стоп</button>
        ) : (
          <button className="primary" onClick={() => void run()} disabled={!lines.length} data-testid="summary-ai">
            Написать разбор (ИИ)
          </button>
        )}
        <span className="muted small">Без ИИ разбор — это список фактов выше.</span>
      </div>
      {(busy || result) && <AiAnswer text={text} result={result} question="" testId="summary-answer" />}
    </div>
  );
}
