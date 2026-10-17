import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { startMockOpenAi, type MockServer } from '../ai/mock-openai';

// ИИ-помощник в настоящем Electron: поставщик по умолчанию выключен, облако — только с согласием,
// ключ не попадает ни в settings.json, ни в интерфейс; ответы потоком с поддельного сервера на 127.0.0.1.

const ROOT = resolve(import.meta.dirname, '../..');
const TMP_ROOT = join(ROOT, '.tmp/e2e-data');
const tmp = () => (mkdirSync(TMP_ROOT, { recursive: true }), mkdtempSync(join(TMP_ROOT, 'ai-')));

/** Папка «Доты» для тестов — пустая временная: иначе коуч находит настоящую Доту и переписывает её файл GSI своим секретом */
const noDota = (dataDir: string) => (mkdirSync(join(dataDir, 'no-dota'), { recursive: true }), join(dataDir, 'no-dota'));
const KEY = 'sk-e2e-SECRET-0123456789';

async function launch(dataDir: string): Promise<{ app: ElectronApplication; ui: Page }> {
  const settingsFile = join(dataDir, 'settings.json');
  if (!existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify({ live: { autoStart: false }, gsi: { dotaDir: noDota(dataDir) } }));
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, DOTACOACH_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', DOTACOACH_NO_UPDATE_CHECK: '1' },
  });
  let ui: Page | undefined;
  for (let i = 0; i < 100 && !ui; i++) {
    ui = app.windows().find((p) => p.url().includes('/renderer/index.html'));
    if (!ui) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ui) throw new Error('Окно интерфейса не появилось');
  await ui.waitForSelector('[data-testid="page-dashboard"]');
  return { app, ui };
}

/** Синтетическая сессия GSI на 10 минут игры (из фикстуры «линия») — для «Разбора матча» */
function writeSession(dataDir: string): void {
  const body = JSON.parse(readFileSync(join(ROOT, 'tests/fixtures/gsi/laning.json'), 'utf8')) as Record<string, any>;
  const lines: string[] = [];
  for (let c = 0; c <= 600; c += 2) {
    const b = structuredClone(body);
    b.map.clock_time = c;
    b.map.game_time = c + 90;
    b.player.gold = 600 + c;
    b.hero.level = 1 + Math.floor(c / 90);
    b.hero.alive = !(c >= 300 && c < 320);
    b.player.deaths = c >= 300 ? 1 : 0;
    b.hero.xpos = -1000 + c * 4;
    lines.push(JSON.stringify({ t: 1760340000000 + c * 1000, body: b }));
  }
  mkdirSync(join(dataDir, 'gsi-sessions'), { recursive: true });
  writeFileSync(join(dataDir, 'gsi-sessions', '2026-10-14.jsonl'), `${lines.join('\n')}\n`);
}

let mock: MockServer;
test.beforeAll(async () => {
  mock = await startMockOpenAi({ chunkDelayMs: 20 });
});
test.afterAll(() => mock.close());

test('ИИ-помощник: выключен по умолчанию, облако только с согласием, ответ потоком с проверкой чисел, ключ не утекает', async () => {
  const dataDir = tmp();
  writeSession(dataDir);
  const { app, ui } = await launch(dataDir);
  try {
    await ui.click('[data-testid="nav-ai"]');
    await expect(ui.locator('[data-testid="page-ai"]')).toBeVisible();
    await expect(ui.locator('[data-testid="ai-provider-off"]')).toBeChecked();
    await expect(ui.locator('[data-testid="ai-provider-gigachat"]')).toBeDisabled();
    await expect(ui.locator('[data-testid="ai-local-ready"]')).toHaveText('Не скачан');
    await expect(ui.locator('[data-testid="ai-download"]')).toContainText('ГБ');

    // ИИ выключен — честная ошибка, в сеть ничего не уходит
    await ui.fill('[data-testid="ask-assistant"] [data-testid="ask-input"]', 'Сколько стоит бкб?');
    await ui.click('[data-testid="ask-assistant"] [data-testid="ask-submit"]');
    await expect(ui.locator('[data-testid="ai-answer"]').last()).toHaveAttribute('data-error', 'not-configured');

    // Облако без согласия — отказ, запросов нет
    await ui.click('[data-testid="ai-provider-openai-compatible"]');
    await ui.fill('[data-testid="ai-cloud-url"]', mock.url);
    await ui.fill('[data-testid="ai-cloud-model"]', 'oracle');
    await ui.click('[data-testid="ai-cloud-key"]');
    await ui.fill('[data-testid="ai-cloud-key"]', KEY);
    await ui.click('[data-testid="ai-cloud-key-save"]');
    await expect(ui.locator('[data-testid="ai-cloud-key"]')).toHaveValue('');
    await ui.fill('[data-testid="ask-assistant"] [data-testid="ask-input"]', 'Сколько стоит бкб?');
    await ui.click('[data-testid="ask-assistant"] [data-testid="ask-submit"]');
    await expect(ui.locator('[data-testid="ai-answer"]').last()).toHaveAttribute('data-error', 'no-consent');
    expect(mock.requests).toHaveLength(0);

    // С согласием — ответ потоком, числа сверены, данные указаны
    await ui.check('[data-testid="ai-cloud-consent"]');
    // согласие сохранено в main до вопроса
    await expect.poll(() => JSON.parse(readFileSync(join(dataDir, 'settings.json'), 'utf8')).ai?.sendToCloudConsent).toBe(true);
    await ui.fill('[data-testid="ask-assistant"] [data-testid="ask-input"]', 'Сколько стоит бкб?');
    await ui.click('[data-testid="ask-assistant"] [data-testid="ask-submit"]');
    const answer = ui.locator('[data-testid="ai-answer"]').last();
    await expect(answer).toHaveAttribute('data-grounded', 'yes', { timeout: 10_000 });
    await expect(answer).toContainText('4050');
    await expect(ui.locator('[data-testid="ai-used"]').last()).toContainText('База знаний');
    expect(mock.requests.at(-1)!.headers.authorization).toBe(`Bearer ${KEY}`);
    await ui.click('[data-testid="ai-useful"]');
    await expect.poll(() => existsSync(join(dataDir, 'ai', 'feedback.jsonl'))).toBe(true);

    // Выдуманное число подсвечивается
    mock.set({ chunkDelayMs: 5, reply: () => 'BKB стоит 9999 золота.' });
    await ui.fill('[data-testid="ask-assistant"] [data-testid="ask-input"]', 'Сколько стоит бкб?');
    await ui.click('[data-testid="ask-assistant"] [data-testid="ask-submit"]');
    await expect(ui.locator('[data-testid="ai-unverified"]').last()).toBeVisible({ timeout: 10_000 });
    await expect(ui.locator('mark.ai-flag').last()).toHaveText('9999');
    mock.set({ chunkDelayMs: 20 });

    // Ключ: ни в settings.json, ни в интерфейсе, ни в журнале
    const settingsText = readFileSync(join(dataDir, 'settings.json'), 'utf8');
    expect(settingsText).not.toContain(KEY);
    expect(JSON.parse(settingsText).ai).toMatchObject({ provider: 'openai-compatible', sendToCloudConsent: true });
    expect(await ui.content()).not.toContain(KEY);
    const keysFile = readFileSync(join(dataDir, 'ai', 'keys.json'), 'utf8');
    expect(keysFile).not.toContain(KEY);
    const logs = ['live.log', 'logs/live.log'].map((f) => join(dataDir, f)).filter(existsSync);
    for (const l of logs) expect(readFileSync(l, 'utf8')).not.toContain(KEY);
    const uiState = await ui.evaluate(() => window.dotacoach.getAiState());
    expect(JSON.stringify(uiState)).not.toContain(KEY);
    expect(uiState.keys.openaiCompatible).toBe(true);

    // «Спросить» на «Базе знаний» и «Разбор матча» по записанной сессии
    await ui.click('[data-testid="nav-kb"]');
    await ui.fill('[data-testid="ask-kb"] [data-testid="ask-input"]', 'Какая перезарядка у Meat Hook?');
    await ui.click('[data-testid="ask-kb"] [data-testid="ask-submit"]');
    const kbAnswer = ui.locator('[data-testid="ask-kb"] [data-testid="ai-answer"]');
    await expect(kbAnswer).toHaveAttribute('data-grounded', 'yes', { timeout: 10_000 });
    await expect(kbAnswer).toContainText('18/16/14/12');

    await ui.click('[data-testid="nav-ai"]');
    await ui.selectOption('[data-testid="sessions-select"]', { index: 1 });
    const facts = ui.locator('[data-testid="summary-facts"]');
    await expect(facts).toContainText('Смерти (1): 5:00');
    await ui.click('[data-testid="summary-ai"]');
    await expect(ui.locator('[data-testid="summary-answer"]')).toContainText('Смерти', { timeout: 10_000 });
    await ui.screenshot({ path: join(ROOT, 'test-results/ai-assistant.png'), fullPage: true });
    await ui.click('[data-testid="nav-live"]');
    await expect(ui.locator('[data-testid="ask-live"]')).toBeVisible();
  } finally {
    await app.close();
  }
});
