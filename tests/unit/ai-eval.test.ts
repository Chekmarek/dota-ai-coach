// Оценка ИИ-помощника на CI: поддельный сервер-«оракул» вместо модели — проверяется, что нужные факты собраны,
// дошли до модели и что ответ проходит проверку чисел. Настоящая модель — npm run ai:eval.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startMockOpenAi, type MockServer } from '../ai/mock-openai';
import { loadQuestions, promptFacts, scoreAnswer } from '../ai/eval';
import { AiService } from '../../src/main/ai/service';
import { defaultSettings, type Settings } from '../../src/shared/schemas/settings';

const questions = loadQuestions();
let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOpenAi();
});
afterAll(() => mock.close());

describe('оценка ИИ (tests/ai/questions.json)', () => {
  it('вопросов не меньше 30, все виды: таймеры, цены, герои, матч, запись, «не знаю»', () => {
    expect(questions.length).toBeGreaterThanOrEqual(30);
    for (const ctx of ['none', 'laning', 'dead', 'replay']) expect(questions.some((q) => q.context === ctx)).toBe(true);
    expect(questions.some((q) => q.unknown)).toBe(true);
  });

  it.each(questions.map((q) => [q.id, q] as const))('%s: нужные факты попадают в подсказку модели', (_id, q) => {
    const facts = promptFacts(q).join('\n');
    for (const f of q.expectFacts) expect(facts, `${q.question}`).toContain(f);
  });

  it('оракул по фактам отвечает правильно не меньше чем на 85 % вопросов', async () => {
    const s = defaultSettings();
    const settings: Settings = { ...s, ai: { ...s.ai, provider: 'openai-compatible', cloud: { baseUrl: mock.url, model: 'oracle' }, sendToCloudConsent: true } };
    const svc = new AiService({ getSettings: () => settings, keys: { get: () => null }, local: null, inMatch: () => false, log: () => undefined });
    const scores = [];
    for (const q of questions) {
      const r = await svc.ask({ requestId: q.id, kind: 'ask', question: q.question, facts: promptFacts(q) }, () => undefined);
      expect(r.error).toBeNull();
      scores.push(scoreAnswer(q, r.text, r.facts));
    }
    const passed = scores.filter((x) => x.pass).length;
    const failed = scores.filter((x) => !x.pass).map((x) => `${x.id}: ${x.why}`);
    expect(passed / scores.length, failed.join('\n')).toBeGreaterThanOrEqual(0.85);
  });
});
