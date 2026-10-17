// Тяжёлая модель только для выбора героев (Qwen3 8B): стадии GSI, когда её можно держать, кто ей отвечает,
// выгрузка при начале матча, совместимость старых settings.json.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startMockOpenAi, type MockServer } from '../ai/mock-openai';
import { AiService } from '../../src/main/ai/service';
import { gameStage, heavyModelAllowed, inDraftStage, shouldUnloadHeavy, STAGE_FRESH_MS, type StageInfo } from '../../src/core/ai/draft-model';
import { AI_DRAFT_MODELS, AI_LOCAL_MODELS, applySettingsPatch, defaultSettings, settingsPatchSchema, settingsSchema, type AiModelId, type Settings } from '../../src/shared/schemas/settings';
import { ALL_MODELS, DRAFT_MODELS, MODELS } from '../../src/main/ai/local/manifest';

let mock: MockServer;
beforeAll(async () => {
  mock = await startMockOpenAi();
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.set({ reply: () => 'Viper.' });
  mock.requests.length = 0;
});

describe('стадии игры по game_state', () => {
  it('выбор героев, матч и прочее', () => {
    for (const s of ['DOTA_GAMERULES_STATE_HERO_SELECTION', 'DOTA_GAMERULES_STATE_STRATEGY_TIME', 'DOTA_GAMERULES_STATE_TEAM_SHOWCASE', 'DOTA_GAMERULES_STATE_PLAYER_DRAFT'])
      expect(gameStage(s), s).toBe('draft');
    for (const s of ['DOTA_GAMERULES_STATE_WAIT_FOR_MAP_TO_LOAD', 'DOTA_GAMERULES_STATE_PRE_GAME', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS']) expect(gameStage(s), s).toBe('match');
    for (const s of ['DOTA_GAMERULES_STATE_POST_GAME', 'DOTA_GAMERULES_STATE_INIT', null, undefined]) expect(gameStage(s), String(s)).toBe('other');
  });
});

describe('когда тяжёлую модель можно держать', () => {
  const now = 1_000_000;
  const at = (stage: StageInfo['stage'], ago: number, dotaOnScreen = true): StageInfo => ({ stage, at: now - ago, dotaOnScreen });
  it('выбор героев по свежему GSI — да, даже когда захват видит Доту', () => expect(heavyModelAllowed(at('draft', 1000), now)).toBe(true));
  it('матч — нет', () => expect(heavyModelAllowed(at('match', 1000), now)).toBe(false));
  it('после матча (другая стадия) при открытой Доте — нет', () => expect(heavyModelAllowed(at('other', 1000), now)).toBe(false));
  it('GSI давно молчит: только если Доты нет на экране', () => {
    expect(heavyModelAllowed(at('draft', STAGE_FRESH_MS + 1), now)).toBe(false);
    expect(heavyModelAllowed(at('draft', STAGE_FRESH_MS + 1, false), now)).toBe(true);
    expect(heavyModelAllowed({ stage: null, at: null, dotaOnScreen: false }, now)).toBe(true);
    expect(heavyModelAllowed({ stage: null, at: null, dotaOnScreen: true }, now)).toBe(false);
  });
  it('потоки: половина ядер только при свежей стадии выбора героев', () => {
    expect(inDraftStage(at('draft', 1000), now)).toBe(true);
    expect(inDraftStage(at('draft', STAGE_FRESH_MS + 1), now)).toBe(false);
    expect(inDraftStage(at('match', 1000), now)).toBe(false);
    expect(inDraftStage({ stage: null, at: null, dotaOnScreen: false }, now)).toBe(false);
  });
  it('выгружаем только тяжёлую модель и только когда её держать нельзя', () => {
    expect(shouldUnloadHeavy('qwen3-8b', AI_DRAFT_MODELS, false)).toBe(true);
    expect(shouldUnloadHeavy('qwen3-8b', AI_DRAFT_MODELS, true)).toBe(false);
    expect(shouldUnloadHeavy('qwen3-1.7b', AI_DRAFT_MODELS, false)).toBe(false);
    expect(shouldUnloadHeavy(null, AI_DRAFT_MODELS, false)).toBe(false);
  });
});

describe('кто отвечает: тяжёлая модель — только объяснению драфта и только при выборе героев', () => {
  const settings = (draftModel: 'qwen3-8b' | null): Settings => {
    const s = defaultSettings();
    return { ...s, ai: { ...s.ai, provider: 'local', local: { model: 'qwen3-1.7b', draftModel } } };
  };
  function svc(o: { draftModel?: 'qwen3-8b' | null; allowed: () => boolean; installed?: boolean }) {
    const started: AiModelId[] = [];
    const service = new AiService({
      getSettings: () => settings(o.draftModel === undefined ? 'qwen3-8b' : o.draftModel),
      keys: { get: () => null },
      local: {
        ensure: async (m) => (started.push(m), mock.url),
        touch: () => undefined,
        installed: () => o.installed ?? true,
      },
      inMatch: () => true, // при выборе героев захват уже видит Доту
      heavyAllowed: o.allowed,
      log: () => undefined,
    });
    return { service, started };
  }
  const ask = (s: AiService, kind: 'draft' | 'ask' | 'card') =>
    s.ask({ requestId: kind, kind, question: 'кого взять?', facts: ['Viper против Bristleback +4,9% (13 200 игр), патч 7.41f'] }, () => undefined);

  it('выбор героев: объяснение драфта — 8B; вопрос и подсказка — обычная модель', async () => {
    const { service, started } = svc({ allowed: () => true });
    expect((await ask(service, 'draft')).model).toBe('qwen3-8b');
    expect((await ask(service, 'ask')).model).toBe('qwen3-1.7b');
    expect((await ask(service, 'card')).model).toBe('qwen3-1.7b');
    expect(started).toEqual(['qwen3-8b', 'qwen3-1.7b', 'qwen3-1.7b']);
  });

  it('матч начался: даже объяснение драфта — обычная модель', async () => {
    let stage: 'draft' | 'match' = 'draft';
    const { service, started } = svc({ allowed: () => stage === 'draft' });
    await ask(service, 'draft');
    stage = 'match';
    expect((await ask(service, 'draft')).model).toBe('qwen3-1.7b');
    expect(started).toEqual(['qwen3-8b', 'qwen3-1.7b']);
  });

  it('модель драфта не выбрана или не скачана — обычная модель', async () => {
    expect((await ask(svc({ draftModel: null, allowed: () => true }).service, 'draft')).model).toBe('qwen3-1.7b');
    expect((await ask(svc({ allowed: () => true, installed: false }).service, 'draft')).model).toBe('qwen3-1.7b');
  });

  it('подсказки движка в матче (coachProvider) — всегда обычная модель', async () => {
    const { service, started } = svc({ allowed: () => true });
    const p = service.coachProvider()!;
    for await (const _ of p.generate({ system: 's', messages: [{ role: 'user', content: 'q' }], maxTokens: 10, temperature: 0 })) void _;
    expect(started).toEqual(['qwen3-1.7b']);
  });

  it('промпт драфта: только герои и числа из фактов, без «гарантирована»', async () => {
    const { service } = svc({ allowed: () => true });
    await ask(service, 'draft');
    const sys = mock.requests.at(-1)!.body.messages![0]!.content as string;
    expect(sys).toContain('Идёт выбор героев');
    expect(sys).toContain('Называй только героев из фактов');
    expect(sys).toContain('Viper против Bristleback +4,9% (13 200 игр)');
  });
});

describe('настройки и манифест', () => {
  it('8B не входит в модели для матча; закреплена на коммит официального репозитория Qwen', () => {
    expect(AI_LOCAL_MODELS as readonly string[]).not.toContain('qwen3-8b');
    expect(Object.keys(MODELS)).not.toContain('qwen3-8b');
    const m = DRAFT_MODELS['qwen3-8b'];
    expect(m.url).toMatch(/^https:\/\/huggingface\.co\/Qwen\/Qwen3-8B-GGUF\/resolve\/[0-9a-f]{40}\/Qwen3-8B-Q4_K_M\.gguf$/);
    expect(m.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(m.sizeBytes).toBeGreaterThan(4e9);
    expect(m.license).toBe('Apache-2.0');
    expect(ALL_MODELS['qwen3-8b']).toBe(m);
  });

  it('старый settings.json без draftModel читается, модель для матча не меняется', () => {
    const old = { ai: { provider: 'local', local: { model: 'qwen3-4b' }, cloud: { baseUrl: '', model: '' }, sendToCloudConsent: false } };
    const s = settingsSchema.parse(old);
    expect(s.ai.local).toEqual({ model: 'qwen3-4b', draftModel: null });
    expect(defaultSettings().ai.local.draftModel).toBeNull();
  });

  it('8B нельзя выбрать моделью для матча; моделью драфта — можно, модель матча при этом не меняется', () => {
    expect(() => settingsPatchSchema.parse({ ai: { local: { model: 'qwen3-8b' } } })).toThrow();
    const s = applySettingsPatch(defaultSettings(), settingsPatchSchema.parse({ ai: { local: { draftModel: 'qwen3-8b' } } }));
    expect(s.ai.local).toEqual({ model: 'qwen3-1.7b', draftModel: 'qwen3-8b' });
    const back = applySettingsPatch(s, settingsPatchSchema.parse({ ai: { local: { draftModel: null } } }));
    expect(back.ai.local.draftModel).toBeNull();
  });
});
