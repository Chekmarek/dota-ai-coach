import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseSession, replaySession } from '../../scripts/gsi-replay.mjs';

const ROOT = resolve(import.meta.dirname, '../..');
const FRAMES = join(ROOT, 'tests/fixtures/frames/synthetic');

/**
 * live: false (по умолчанию) — живой захват при запуске не включается, чтобы тесты записей не зависели
 * от того, запущена ли Дота. Обновления в тестах не проверяются (не ходим в сеть).
 */
async function launch(dataDir: string, opts: { live?: boolean; env?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; ui: Page }> {
  const settingsFile = join(dataDir, 'settings.json');
  if (!existsSync(settingsFile)) writeFileSync(settingsFile, JSON.stringify({ ...(opts.live ? {} : { live: { autoStart: false } }), gsi: { dotaDir: noDota(dataDir) } }));
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, DOTACOACH_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', DOTACOACH_NO_UPDATE_CHECK: '1', ...opts.env },
  });
  // Окон два: интерфейс и скрытый движок — берём окно интерфейса
  const ui = await waitForUi(app);
  await ui.waitForSelector('[data-testid="page-dashboard"]');
  return { app, ui };
}

async function waitForUi(app: ElectronApplication): Promise<Page> {
  for (let i = 0; i < 100; i++) {
    const w = app.windows().find((p) => p.url().includes('/renderer/index.html'));
    if (w) return w;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Окно интерфейса не появилось');
}

/** Подменяем системный диалог выбора файла — Playwright не умеет кликать по нативным окнам */
async function stubDialog(app: ElectronApplication, path: string): Promise<void> {
  await app.evaluate(({ dialog }, p) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [p] })) as typeof dialog.showOpenDialog;
  }, path);
}

// Временные данные тестов — внутри проекта (.tmp\e2e-data), не на диске C.
// Не в test-results: Playwright очищает ту папку перед каждым запуском.
const TMP_ROOT = join(ROOT, '.tmp/e2e-data');
const tmp = () => (mkdirSync(TMP_ROOT, { recursive: true }), mkdtempSync(join(TMP_ROOT, 'run-')));

/** Папка «Доты» для тестов — пустая временная: иначе коуч находит настоящую Доту и переписывает её файл GSI своим секретом */
const noDota = (dataDir: string) => (mkdirSync(join(dataDir, 'no-dota'), { recursive: true }), join(dataDir, 'no-dota'));

test('приложение запускается, все 12 экранов открываются, нереализованное честно помечено', async () => {
  const { app, ui } = await launch(tmp());
  try {
    for (const id of ['dashboard', 'live', 'hud', 'replay', 'match', 'draft', 'ai', 'history', 'kb', 'voice', 'updates', 'settings']) {
      await ui.click(`[data-testid="nav-${id}"]`);
      await expect(ui.locator(`[data-testid="page-${id}"]`)).toBeVisible();
    }
    for (const id of ['voice']) {
      await ui.click(`[data-testid="nav-${id}"]`);
      await expect(ui.locator('[data-testid="not-implemented"]').first()).toBeVisible();
    }
    // «История советов» (этап 4) реализована: без матчей — честно пусто
    await ui.click('[data-testid="nav-history"]');
    await expect(ui.locator('[data-testid="history-empty"]')).toBeVisible();
    // «Состояние матча» (этап D) реализовано: без источника — пустое состояние, без выдуманных значений
    await ui.click('[data-testid="nav-match"]');
    await expect(ui.locator('[data-testid="match-empty"]')).toHaveText('Запустите живую игру или разбор записи');
  } finally {
    await app.close();
  }
});

test('драфт: враг добавляется поиском, есть кандидаты и угрозы, «Беру» показывает матчапы', async () => {
  const { app, ui } = await launch(tmp());
  try {
    await ui.click('[data-testid="nav-draft"]');
    await ui.fill('[data-testid="draft-add-enemies"]', 'Riki');
    await ui.press('[data-testid="draft-add-enemies"]', 'Enter');
    await expect(ui.locator('[data-testid="draft-enemies"] .draft-chip')).toHaveCount(1);
    await expect(ui.locator('[data-testid="draft-candidates"] li')).toHaveCount(12);
    await expect(ui.locator('[data-testid="draft-threats"]')).toContainText('Невидимость');
    // без матча взять героев неоткуда — честное сообщение
    await ui.click('[data-testid="draft-from-match"]');
    await expect(ui.getByText('Матча сейчас нет')).toBeVisible();
    await ui.locator('[data-testid="draft-candidates"] .draft-take').first().click();
    await expect(ui.locator('[data-testid="draft-me-summary"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('безопасность: в интерфейсе нет доступа к Node.js и к секрету GSI; режимы по решению владельца', async () => {
  const { app, ui } = await launch(tmp());
  try {
    const exposure = await ui.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      api: Object.keys(window.dotacoach).sort(),
    }));
    expect(exposure.require).toBe('undefined');
    expect(exposure.process).toBe('undefined');
    expect(exposure.api).toEqual([
      'askAi',
      'cancelAi',
      'cancelLocalAiDownload',
      'checkForUpdates',
      'clearAiKey',
      'connectGsi',
      'copyGsiLaunchOption',
      'deleteLocalAi',
      'disconnectGsi',
      'downloadLocalAi',
      'draftLive',
      'draftSuggest',
      'getAiState',
      'getAppInfo',
      'getGsiSessionMatch',
      'getGsiState',
      'getHistory',
      'getKnowledgeBase',
      'getSettings',
      'getUpdateState',
      'installUpdate',
      'listGsiSessions',
      'listHistory',
      'onAiChunk',
      'onAiState',
      'onCoachState',
      'onGsiState',
      'onUpdateState',
      'pickDotaFolder',
      'pickReplayFolder',
      'pickReplayVideo',
      'sendAiFeedback',
      'setAiKey',
      'showHudDemo',
      'showMatchups',
      'stopLocalAi',
      'updateSettings',
    ]);
    // История: путь к файлу вне папки истории не прочитать
    expect(await ui.evaluate(() => window.dotacoach.getHistory('../settings'))).toBeNull();
    // ИИ: лишние поля и чужие модели отклоняются main-процессом (zod), ключ через настройки не задать
    await expect(ui.evaluate(() => window.dotacoach.askAi({ requestId: 'x', kind: 'ask', facts: [], apiKey: 'k' } as never))).rejects.toThrow();
    await expect(ui.evaluate(() => window.dotacoach.downloadLocalAi('llama-70b' as never))).rejects.toThrow();
    await expect(ui.evaluate(() => window.dotacoach.updateSettings({ ai: { provider: 'gigachat' } } as never))).rejects.toThrow();
    await expect(ui.evaluate(() => window.dotacoach.getGsiSessionMatch('../../etc'))).resolves.toEqual({ error: 'Неверный номер записи' });
    const info = await ui.evaluate(() => window.dotacoach.getAppInfo());
    // Решение владельца 2026-10-13: подсказки разрешены, включает их пользователь переключателями
    expect(info.policy.modes.filter((m) => m.allowed).map((m) => m.mode)).toEqual(['replay', 'live-observe', 'live-coach-unranked', 'live-coach-ranked']);
    // Секрет GSI создан в main и в интерфейс не попадает
    const s = await ui.evaluate(() => window.dotacoach.getSettings());
    expect(s.gsi.token).toBe('');
    await expect(ui.evaluate(() => window.dotacoach.updateSettings({ gsi: { token: 'f'.repeat(64) } } as never))).rejects.toThrow();
    // Недопустимые настройки отклоняются main-процессом
    await expect(ui.evaluate(() => window.dotacoach.updateSettings({ capture: { targetFps: 1000 } }))).rejects.toThrow();
  } finally {
    await app.close();
  }
});

test('настройки сохраняются и переживают перезапуск', async () => {
  const dataDir = tmp();
  let { app, ui } = await launch(dataDir);
  await ui.click('[data-testid="nav-settings"]');
  const input = ui.locator('[data-testid="setting-targetFps"]');
  await input.fill('7.5');
  await input.blur();
  await ui.click('[data-testid="setting-loop"]');
  await expect.poll(() => ui.evaluate(() => window.dotacoach.getSettings().then((s) => s.capture.targetFps))).toBe(7.5);
  await app.close();

  ({ app, ui } = await launch(dataDir));
  try {
    const s = await ui.evaluate(() => window.dotacoach.getSettings());
    expect(s.capture.targetFps).toBe(7.5);
    expect(s.replay.loop).toBe(true);
  } finally {
    await app.close();
  }
});

test('Replay: папка с кадрами воспроизводится с заданной частотой', async () => {
  const { app, ui } = await launch(tmp());
  try {
    await ui.evaluate(() => window.dotacoach.updateSettings({ capture: { targetFps: 10, processingFpsCap: 10, previewFps: 5 } }));
    await stubDialog(app, FRAMES);
    await ui.click('[data-testid="nav-replay"]');
    await ui.click('[data-testid="pick-folder"]');
    await expect(ui.locator('[data-testid="source-label"]')).toContainText('24 кадр');
    await ui.click('[data-testid="replay-start"]');
    await expect(ui.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', 'running');
    await expect(ui.locator('[data-testid="preview-img"]')).toBeVisible();
    await expect.poll(async () => Number(await ui.locator('[data-testid="frames-received"]').innerText()), { timeout: 10_000 }).toBeGreaterThanOrEqual(10);
    const fps = Number((await ui.locator('[data-testid="measured-fps"]').innerText()).split(' ')[0]);
    expect(fps).toBeGreaterThan(6);
    expect(fps).toBeLessThan(12);
    // 24 кадра при 10 к/с ≈ 2.4 с — запись заканчивается сама (повтор выключен)
    await expect(ui.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', 'ended', { timeout: 10_000 });
    expect(Number(await ui.locator('[data-testid="frames-received"]').innerText())).toBe(24);
  } finally {
    await app.close();
  }
});

test('Replay: видеофайл воспроизводится, позиция растёт, стоп освобождает источник', async () => {
  const dir = tmp();
  const { app, ui } = await launch(tmp());
  try {
    // Синтетическое видео записываем прямо в приложении (canvas → MediaRecorder), ffmpeg не нужен
    const b64 = await ui.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 640;
      c.height = 360;
      const ctx = c.getContext('2d')!;
      const rec = new MediaRecorder(c.captureStream(30), { mimeType: 'video/webm' });
      const chunks: Blob[] = [];
      rec.ondataavailable = (e) => chunks.push(e.data);
      const done = new Promise((r) => (rec.onstop = r));
      rec.start(100);
      const t0 = performance.now();
      await new Promise<void>((res) => {
        const draw = () => {
          const t = performance.now() - t0;
          ctx.fillStyle = '#0e1218';
          ctx.fillRect(0, 0, 640, 360);
          ctx.fillStyle = '#e5483b';
          ctx.fillRect((t / 10) % 600, 150, 40, 40);
          if (t < 4000) requestAnimationFrame(draw);
          else res();
        };
        draw();
      });
      rec.stop();
      await done;
      const buf = new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return btoa(s);
    });
    const video = join(dir, 'synthetic.webm');
    writeFileSync(video, Buffer.from(b64, 'base64'));

    await ui.evaluate(() => window.dotacoach.updateSettings({ capture: { targetFps: 5 } }));
    await stubDialog(app, video);
    await ui.click('[data-testid="nav-replay"]');
    await ui.click('[data-testid="pick-video"]');
    await expect(ui.locator('[data-testid="source-label"]')).toHaveText('synthetic.webm');
    await ui.click('[data-testid="replay-start"]');
    await expect(ui.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', 'running');
    await expect.poll(async () => Number(await ui.locator('[data-testid="frames-received"]').innerText()), { timeout: 10_000 }).toBeGreaterThanOrEqual(5);
    await ui.click('[data-testid="replay-stop"]');
    await expect(ui.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', 'stopped');
    const after = Number(await ui.locator('[data-testid="frames-received"]').innerText());
    await new Promise((r) => setTimeout(r, 1500));
    expect(Number(await ui.locator('[data-testid="frames-received"]').innerText())).toBe(after);
  } finally {
    await app.close();
  }
});

// Настоящая запись пользователя (в репозиторий не входит): путь — в DOTACOACH_USER_VIDEO. Если файла нет — тест пропускается.
const USER_VIDEO = process.env.DOTACOACH_USER_VIDEO ?? '';

test('Зрение: на записи матча распознаются время, золото, HP, мана и уровень', async () => {
  test.skip(!existsSync(USER_VIDEO), 'нет записи пользователя');
  const { app, ui } = await launch(tmp());
  try {
    await ui.evaluate(() => window.dotacoach.updateSettings({ capture: { targetFps: 4, processingFpsCap: 4 } }));
    await stubDialog(app, USER_VIDEO);
    await ui.click('[data-testid="nav-replay"]');
    await ui.click('[data-testid="pick-video"]');
    await ui.click('[data-testid="replay-start"]');
    await expect(ui.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', 'running');
    // Распознавание HUD (бывшая «Диагностика зрения») — теперь прямо на странице «Разбор записи»
    await expect(ui.locator('[data-testid="vision-table"]')).toBeVisible({ timeout: 10_000 });
    await expect(ui.locator('[data-testid="hud-regions"]')).toBeVisible();
    // Запись — 44-я минута матча, герой 27–28 уровня
    await expect(ui.locator('[data-testid="vision-value-gameClock"]')).toHaveText(/^44:\d\d$/, { timeout: 10_000 });
    await expect(ui.locator('[data-testid="vision-value-level"]')).toHaveText(/^2[78]$/);
    await expect(ui.locator('[data-testid="vision-value-gold"]')).toHaveText(/^\d{4}$/);
    await expect(ui.locator('[data-testid="vision-value-mana"]')).toHaveText(/^\d+ \/ 10(11|23)$/);
    // Имя героя: на записи — Kez; на отдельных кадрах может быть «не распознан», но не другой герой
    await expect(ui.locator('[data-testid="hero-name"] .stat-value')).toHaveText(/^(Kez|не распознан)$/);
    await expect.poll(async () => ui.locator('[data-testid="hero-name"] .stat-value').innerText(), { timeout: 8_000 }).toBe('Kez');
    // Время распознавания одного кадра (показатель обновляется раз в 0.5 с)
    await expect.poll(async () => parseFloat(await ui.locator('[data-testid="vision-ms"]').innerText()), { timeout: 5_000 }).toBeLessThan(50);
    await ui.screenshot({ path: join(ROOT, 'test-results/vision-diagnostics.png') });
    // Состояние матча (этап D): модель приняла время с записи — не прочерк
    await ui.click('[data-testid="nav-match"]');
    await expect(ui.locator('[data-testid="match-clock-value"]')).toHaveText(/^44:\d\d/, { timeout: 10_000 });
    // Союзники и враги (этап 4 зрения): верхняя панель записи прочитана — карточка с игроками, а не пустая
    await expect(ui.locator('[data-testid="players-card"]')).toBeVisible({ timeout: 15_000 });
    await ui.screenshot({ path: join(ROOT, 'test-results/match-state.png') });
  } finally {
    await app.close();
  }
});

test('Живая игра: захват включается сам, ищет окно Доты, пишет live.log; запись выключает живой режим', async () => {
  const dataDir = tmp();
  const { app, ui } = await launch(dataDir, { live: true });
  try {
    await ui.click('[data-testid="nav-live"]');
    // Без запущенной Доты — «Ждёт Доту»; если Дота открыта — «Видит игру» или «Нет картинки»
    await expect(ui.locator('[data-testid="live-state"]').first()).toHaveAttribute('data-state', /^(waiting-dota|seeing|no-image)$/, { timeout: 10_000 });
    // В журнале — запуск живого режима и список найденных окон
    const log = () => (existsSync(join(dataDir, 'live.log')) ? readFileSync(join(dataDir, 'live.log'), 'utf8') : '');
    await expect.poll(log, { timeout: 10_000 }).toContain(' setup ');
    await expect.poll(log, { timeout: 10_000 }).toContain(' windows ');
    await ui.click('[data-testid="live-stop"]');
    await expect(ui.locator('[data-testid="live-state"]').first()).toHaveAttribute('data-state', 'off');
    await ui.click('[data-testid="live-start"]');
    await expect(ui.locator('[data-testid="live-state"]').first()).not.toHaveAttribute('data-state', 'off');
    // Запуск записи заменяет живой захват
    await stubDialog(app, FRAMES);
    await ui.click('[data-testid="nav-replay"]');
    await ui.click('[data-testid="pick-folder"]');
    await ui.click('[data-testid="replay-start"]');
    await expect(ui.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', /^(running|ended)$/);
    await ui.click('[data-testid="nav-live"]');
    await expect(ui.locator('[data-testid="live-state"]').first()).toHaveAttribute('data-state', 'off');
    await ui.screenshot({ path: join(ROOT, 'test-results/live-game.png') });
  } finally {
    await app.close();
  }
});

test('Обновления и настройки: страница открывается, разделы настроек на месте', async () => {
  const { app, ui } = await launch(tmp());
  try {
    await ui.click('[data-testid="nav-updates"]');
    await expect(ui.locator('[data-testid="update-hero"]')).toBeVisible();
    await ui.click('[data-testid="nav-settings"]');
    for (const id of ['setting-live-autostart', 'setting-live-fps', 'setting-live-overlay', 'setting-targetFps', 'setting-maxWidth', 'settings-open-updates']) {
      await expect(ui.locator(`[data-testid="${id}"]`)).toBeVisible();
    }
    await ui.click('[data-testid="setting-live-overlay"]');
    await expect.poll(() => ui.evaluate(() => window.dotacoach.getSettings().then((s) => s.live.overlay))).toBe(false);
  } finally {
    await app.close();
  }
});

test('Режим разработчика: набор кадров виден только при DOTACOACH_DEV=1', async () => {
  let { app, ui } = await launch(tmp(), { env: { DOTACOACH_DEV: '' } });
  try {
    await ui.click('[data-testid="nav-settings"]');
    await expect(ui.locator('[data-testid="settings-open-updates"]')).toBeVisible();
    await expect(ui.locator('[data-testid="setting-dev-dataset"]')).toHaveCount(0);
  } finally {
    await app.close();
  }
  ({ app, ui } = await launch(tmp(), { env: { DOTACOACH_DEV: '1' } }));
  try {
    await ui.click('[data-testid="nav-settings"]');
    // Флажок управляемый: состояние меняется после ответа main — поэтому клик и ожидание сохранения, а не check()
    await ui.click('[data-testid="setting-dev-dataset"]');
    await expect.poll(() => ui.evaluate(() => window.dotacoach.getSettings().then((s) => s.dev))).toEqual({ datasetRecord: true, datasetEveryN: 10 });
    await expect(ui.locator('[data-testid="setting-dev-dataset"]')).toBeChecked();
  } finally {
    await app.close();
  }
});

test('Replay: ошибка источника показывается, приложение не падает', async () => {
  const dir = tmp();
  const bad = join(dir, 'broken.mp4');
  writeFileSync(bad, 'это не видео');
  const { app, ui } = await launch(tmp());
  try {
    await stubDialog(app, bad);
    await ui.click('[data-testid="nav-replay"]');
    await ui.click('[data-testid="pick-video"]');
    await ui.click('[data-testid="replay-start"]');
    await expect(ui.locator('[data-testid="capture-state"]').first()).toHaveAttribute('data-state', 'error', { timeout: 10_000 });
    await expect(ui.locator('[data-testid="capture-error"]')).toBeVisible();
    await ui.click('[data-testid="nav-dashboard"]');
    await expect(ui.locator('[data-testid="page-dashboard"]')).toBeVisible();
  } finally {
    await app.close();
  }
});

test('База знаний: герои и предметы текущего патча, пометка «не проверено»', async () => {
  const { app, ui } = await launch(tmp());
  try {
    await ui.click('[data-testid="nav-kb"]');
    await expect(ui.locator('[data-testid="kb-unverified"]')).toContainText('Не проверено');
    await ui.fill('[data-testid="kb-search"]', 'kez');
    await expect(ui.locator('[data-testid="kb-hero-name"]')).toContainText('Ловкость');
    await expect(ui.locator('.kb-ability b', { hasText: 'Echo Slash' }).first()).toBeVisible();
    // Числа округлены: 2.6666667 → 2.7
    await ui.fill('[data-testid="kb-search"]', 'crystal');
    await expect(ui.locator('[data-testid="kb-hero-armor"]')).toContainText('2.7');
    await expect(ui.locator('[data-testid="kb-hero-armor"]')).not.toContainText('2.66');
    await ui.fill('[data-testid="kb-search"]', 'black king');
    await ui.click('[data-testid="kb-tab-items"]');
    await expect(ui.locator('[data-testid="kb-items"]')).toContainText('4050');
    // Убранный из игры предмет скрыт, пока не включён переключатель
    await ui.fill('[data-testid="kb-search"]', 'iron talon');
    await expect(ui.locator('[data-testid="kb-items"] tbody tr')).toHaveCount(0);
    await ui.check('[data-testid="kb-show-all-items"]');
    await expect(ui.locator('[data-testid="kb-items"]')).toContainText('нет в игре');
    await ui.screenshot({ path: join(ROOT, 'test-results/kb.png') });
  } finally {
    await app.close();
  }
});

test('База знаний: вкладка «Механика» — группы, источник, пометка «не проверено»', async () => {
  const { app, ui } = await launch(tmp());
  try {
    await ui.click('[data-testid="nav-kb"]');
    await ui.click('[data-testid="kb-tab-mechanics"]');
    const tab = ui.locator('[data-testid="kb-mechanics"]');
    await expect(tab).toContainText('Крипы на линиях');
    await expect(tab).toContainText('Рошан');
    // Проверенное по патч-ноутам Valve и непроверенное из вики отличаются пометкой
    await expect(ui.locator('[data-testid="mech-lane-siege-extra-30"] [data-testid="mech-verified"]')).toBeVisible();
    await expect(ui.locator('[data-testid="mech-lane-wave-spawn"] [data-testid="mech-unverified"]')).toBeVisible();
    await expect(ui.locator('[data-testid="mech-lane-wave-spawn"] a')).toHaveAttribute('href', /liquipedia.net/);
    await expect(ui.locator('[data-testid="mech-neutral-pull-per-lane"]')).toContainText('нет данных');
    await ui.fill('[data-testid="mech-search"]', 'Рошан: возрождение');
    await expect(ui.locator('[data-testid="mech-roshan-respawn"]')).toContainText('8:00');
    await expect(ui.locator('[data-testid="mech-lane-wave-spawn"]')).toHaveCount(0);
    await expect(ui.locator('[data-testid="mech-warnings"]')).toHaveCount(0);
    await ui.screenshot({ path: join(ROOT, 'test-results/kb-mechanics.png') });
  } finally {
    await app.close();
  }
});

/** Копия базы «рядом с программой» с заданной датой и именем патча (для проверки выбора копии) */
function externalKb(generatedAt: string, patch: string): string {
  const dir = join(tmp(), 'kb');
  const src = join(ROOT, 'resources/data/kb', JSON.parse(readFileSync(join(ROOT, 'resources/data/kb/current.json'), 'utf8')).patch);
  mkdirSync(join(dir, patch), { recursive: true });
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ patch }));
  for (const f of ['heroes.json', 'items.json']) writeFileSync(join(dir, patch, f), readFileSync(join(src, f)));
  const meta = JSON.parse(readFileSync(join(src, 'meta.json'), 'utf8'));
  writeFileSync(join(dir, patch, 'meta.json'), JSON.stringify({ ...meta, patch, generatedAt }));
  return dir;
}

test('База знаний: берётся копия из app.asar, если копия рядом с программой старее', async () => {
  const { app, ui } = await launch(tmp(), { env: { DOTACOACH_KB_EXTERNAL_DIR: externalKb('2020-01-01T00:00:00.000Z', '7.00z') } });
  try {
    await ui.click('[data-testid="nav-kb"]');
    await expect(ui.locator('[data-testid="kb-copy"]')).toHaveAttribute('data-copy', 'asar');
    await expect(ui.locator('[data-testid="kb-unverified"]')).toContainText('патч 7.41');
    await expect(ui.locator('[data-testid="kb-unverified"]')).not.toContainText('7.00z');
    await expect(ui.locator('[data-testid="kb-tab-heroes"]')).toContainText('127');
  } finally {
    await app.close();
  }
});

test('База знаний: более новая копия рядом с программой побеждает', async () => {
  const { app, ui } = await launch(tmp(), { env: { DOTACOACH_KB_EXTERNAL_DIR: externalKb('2099-01-01T00:00:00.000Z', '9.99z') } });
  try {
    await ui.click('[data-testid="nav-kb"]');
    await expect(ui.locator('[data-testid="kb-copy"]')).toHaveAttribute('data-copy', 'external');
    await expect(ui.locator('[data-testid="kb-unverified"]')).toContainText('патч 9.99z');
  } finally {
    await app.close();
  }
});
// ---------- Данные из игры (GSI) ----------

const GSI_TOKEN = 'e2e0'.repeat(16);

/** Настройки для теста GSI: свой порт и секрет, папка Dota — временная (настоящую Dota тесты не трогают) */
function gsiSettings(dataDir: string, port: number, dotaDir?: string): void {
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ live: { autoStart: false }, gsi: { port, token: GSI_TOKEN, record: true, dotaDir: dotaDir ?? noDota(dataDir) } }));
}

test('GSI: карточка, подтверждение с путём, файл пишется и удаляется только во временной папке Dota', async () => {
  const dataDir = tmp();
  const dota = join(tmp(), 'dota 2 beta');
  mkdirSync(dota, { recursive: true });
  gsiSettings(dataDir, 54121, dota);
  const { app, ui } = await launch(dataDir);
  try {
    await ui.click('[data-testid="nav-settings"]');
    await expect(ui.locator('[data-testid="setting-gsi-port"]')).toHaveValue('54121');
    await expect(ui.locator('[data-testid="setting-gsi-record"]')).toBeChecked();
    await ui.click('[data-testid="nav-live"]');
    await expect(ui.locator('[data-testid="gsi-status"]')).toHaveText('не подключено');
    await expect(ui.locator('[data-testid="gsi-launch-option"]')).toHaveText('-gamestateintegration');
    await ui.click('[data-testid="gsi-connect"]');
    const cfg = join(dota, 'game', 'dota', 'cfg', 'gamestate_integration', 'gamestate_integration_dotacoach.cfg');
    await expect(ui.locator('[data-testid="gsi-confirm-path"]')).toHaveText(cfg);
    expect(existsSync(cfg)).toBe(false); // до подтверждения ничего не пишется
    await ui.click('[data-testid="gsi-confirm-yes"]');
    await expect(ui.locator('[data-testid="gsi-status"]')).toHaveText('файл установлен, ждём Dota');
    const text = readFileSync(cfg, 'utf8');
    expect(text).toContain('"uri"           "http://127.0.0.1:54121/"');
    expect(text).toContain(GSI_TOKEN);
    await ui.screenshot({ path: join(ROOT, 'test-results/gsi-card.png') });
    await ui.click('[data-testid="gsi-disconnect"]');
    await ui.click('[data-testid="gsi-confirm-yes"]');
    await expect(ui.locator('[data-testid="gsi-status"]')).toHaveText('не подключено');
    expect(existsSync(cfg)).toBe(false);
  } finally {
    await app.close();
  }
});

test('GSI: записанная сессия → «Состояние матча» заполняется из игры без захвата экрана', async () => {
  const dataDir = tmp();
  const port = 54122;
  gsiSettings(dataDir, port);
  const { app, ui } = await launch(dataDir);
  try {
    await ui.click('[data-testid="nav-match"]');
    await expect(ui.locator('[data-testid="match-empty"]')).toBeVisible();
    await expect(ui.locator('[data-testid="upcoming-events"]')).toHaveCount(0);
    const entries = parseSession(readFileSync(join(ROOT, 'tests/fixtures/gsi/session.jsonl'), 'utf8'));
    const r = await replaySession(entries, { url: `http://127.0.0.1:${port}/`, token: GSI_TOKEN });
    expect(r.failed).toBe(0);
    const t0 = Date.now();
    const hero = ui.locator('[data-testid="hero-identity"]');
    await expect(ui.locator('[data-testid="hero-identity-value"]')).toHaveText('Shadow Fiend', { timeout: 3000 });
    await expect(ui.locator('[data-testid="hero-level-value"]')).toHaveText('7', { timeout: 3000 });
    await expect(ui.locator('[data-testid="match-clock-value"]')).toHaveText(/^8:0\d/, { timeout: 3000 });
    expect(Date.now() - t0).toBeLessThan(3000);
    await expect(hero.locator('[data-testid="source-chip"]')).toHaveText('из игры');
    await expect(ui.locator('[data-testid="hero-level"] [data-testid="source-chip"]')).toHaveText('из игры');
    await expect(ui.locator('[data-testid="match-clock"] [data-testid="source-chip"]')).toHaveText('из игры');
    await expect(ui.locator('[data-testid="item-inv1-value"]')).toHaveText('Bottle');
    // Без кадров верхней панели нет — карточка «Союзники и враги» честно пуста, а не «все мертвы»
    await expect(ui.locator('[data-testid="players-empty"]')).toBeVisible();
    // «Ближайшие события» по часам матча (8:0x): волна по расписанию, руны мудрости нет, Рошан — без времени смерти
    const upcoming = ui.locator('[data-testid="upcoming-events"]');
    await expect(upcoming).toBeVisible();
    await expect(upcoming.locator('[data-testid="upcoming-lane-wave"]')).toHaveAttribute('data-status', 'ok');
    await expect(upcoming.locator('[data-testid="upcoming-lane-wave"]')).toContainText(/8:(00|30)|9:00/);
    await expect(upcoming.locator('[data-testid="upcoming-rune-water"]')).toHaveAttribute('data-status', 'ended');
    await expect(upcoming.locator('[data-testid="upcoming-rune-wisdom"]')).toHaveAttribute('data-status', 'removed');
    await expect(upcoming.locator('[data-testid="upcoming-roshan-respawn"]')).toHaveAttribute('data-status', 'unknown');
    await expect(ui.locator('[data-testid="sidebar-gsi"]')).toBeVisible();
    await ui.screenshot({ path: join(ROOT, 'test-results/gsi-match.png') });
    // Сессия записана без ников и steamid
    const sessions = join(dataDir, 'gsi-sessions');
    await expect.poll(() => (existsSync(sessions) ? readdirSync(sessions).length : 0)).toBe(1);
    const rec = readFileSync(join(sessions, readdirSync(sessions)[0]!), 'utf8');
    expect(parseSession(rec).length).toBeGreaterThanOrEqual(20);
    expect(rec).not.toContain(GSI_TOKEN);
  } finally {
    await app.close();
  }
});

test('GSI: настоящая запись Hero Demo → Anti-Mage «из игры» за 3 с, уровни и способность — по одному событию', async () => {
  const dataDir = tmp();
  const port = 54123;
  gsiSettings(dataDir, port);
  // Настоящая запись (tests/fixtures/gsi/recorded): часть A — меню и выбор героя до первого тела с героем,
  // часть B — дальше до изучения первой способности (≈ 390 строк). Токен подставляет replaySession.
  const all = parseSession(readFileSync(join(ROOT, 'tests/fixtures/gsi/recorded/demo-antimage.jsonl'), 'utf8'));
  const heroAt = all.findIndex((e) => (e.body as any).hero?.name === 'npc_dota_hero_antimage');
  const learnedAt = all.findIndex((e) => ((e.body as any).abilities?.ability0?.level ?? 0) >= 1);
  expect(heroAt).toBeGreaterThan(0);
  expect(learnedAt).toBeGreaterThan(heroAt);
  const partA = all.slice(0, heroAt + 1);
  const partB = all.slice(heroAt + 1, learnedAt + 1);
  const url = `http://127.0.0.1:${port}/`;
  const { app, ui } = await launch(dataDir);
  try {
    await ui.click('[data-testid="nav-match"]');
    await expect(ui.locator('[data-testid="match-empty"]')).toBeVisible();

    expect((await replaySession(partA, { url, token: GSI_TOKEN, speed: 100 })).failed).toBe(0);
    const t0 = Date.now();
    await expect(ui.locator('[data-testid="hero-identity-value"]')).toHaveText('Anti-Mage', { timeout: 3000 });
    await expect(ui.locator('[data-testid="hero-identity"] [data-testid="source-chip"]')).toHaveText('из игры', { timeout: Math.max(100, 3000 - (Date.now() - t0)) });
    expect(Date.now() - t0).toBeLessThan(3000);

    expect((await replaySession(partB, { url, token: GSI_TOKEN, speed: 20 })).failed).toBe(0);
    await expect(ui.locator('[data-testid="hero-level-value"]')).toHaveText('3', { timeout: 3000 });
    const events = ui.locator('[data-testid="match-events"] li');
    await expect.poll(async () => (await events.allTextContents()).filter((t) => t.includes('Способность 1:')).length, { timeout: 3000 }).toBe(1);
    const texts = await events.allTextContents();
    expect(texts.filter((t) => t.includes('Уровень '))).toHaveLength(2);
    expect(texts.some((t) => t.includes('Наступил день') || t.includes('Наступила ночь'))).toBe(false);
    await expect(ui.locator('[data-testid="sidebar-gsi"]')).toHaveText('Данные из игры');
    await ui.screenshot({ path: join(ROOT, 'test-results/gsi-recorded.png') });
  } finally {
    await app.close();
  }
});
