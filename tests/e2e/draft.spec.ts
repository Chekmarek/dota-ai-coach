// Страница «Драфт» в настоящем окне программы: подбор обновляется после каждого пика и бана, взятые и забаненные
// не предлагаются, позиция соблюдается, «Беру» показывает матчапы, видны патч, дата статистики и число игр,
// без статистики — честное предупреждение; элементы не перекрываются при 1280×720, 1920×1080 и 2560×1080.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '../..');
const TMP_ROOT = join(ROOT, '.tmp/e2e-data');
const SHOTS = join(ROOT, '.tmp/draft-screens');
const tmp = () => (mkdirSync(TMP_ROOT, { recursive: true }), mkdtempSync(join(TMP_ROOT, 'draft-')));

async function launch(env: Record<string, string> = {}): Promise<{ app: ElectronApplication; ui: Page }> {
  const dataDir = tmp();
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ live: { autoStart: false } }));
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, DOTACOACH_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', DOTACOACH_NO_UPDATE_CHECK: '1', ...env },
  });
  let ui: Page | undefined;
  for (let i = 0; i < 100 && !ui; i++) {
    ui = app.windows().find((p) => p.url().includes('/renderer/index.html'));
    if (!ui) await new Promise((r) => setTimeout(r, 100));
  }
  if (!ui) throw new Error('Окно интерфейса не появилось');
  await ui.waitForSelector('[data-testid="page-dashboard"]');
  await ui.click('[data-testid="nav-draft"]');
  await expect(ui.locator('[data-testid="draft-candidates"] li')).toHaveCount(12);
  return { app, ui };
}

/** Ключи кандидатов в порядке списка */
const candidates = (ui: Page) => ui.locator('[data-testid="draft-candidates"] li').evaluateAll((els) => els.map((e) => e.getAttribute('data-hero')!));

/** Добавить героя поиском (имя как в базе знаний) и дождаться, пока список кандидатов пересчитается */
async function add(ui: Page, side: 'allies' | 'enemies' | 'bans', name: string, key: string): Promise<void> {
  const before = (await candidates(ui)).join();
  await ui.fill(`[data-testid="draft-add-${side}"]`, name);
  await ui.press(`[data-testid="draft-add-${side}"]`, 'Enter');
  await expect(ui.locator(`[data-testid="draft-${side}"] .draft-chip`, { hasText: name })).toHaveCount(1);
  // Список изменился (или по крайней мере герой из него исчез) — пересчёт после каждого шага
  await expect.poll(async () => (await candidates(ui)).join() !== before || !(await candidates(ui)).includes(key)).toBe(true);
  expect(await candidates(ui)).not.toContain(key);
}

test('драфт: после каждого пика и бана подбор пересчитывается, взятые и забаненные не предлагаются', async () => {
  const { app, ui } = await launch();
  const taken: string[] = [];
  try {
    for (const [name, key] of [['Bristleback', 'bristleback'], ['Invoker', 'invoker'], ['Riki', 'riki']] as const) {
      await add(ui, 'enemies', name, key);
      taken.push(key);
      for (const k of taken) expect(await candidates(ui)).not.toContain(k);
      // у каждого врага — причина с процентом и числом игр
      await expect(ui.locator('[data-testid="draft-candidates"]')).toContainText(/игр/);
    }
    await expect(ui.locator('[data-testid="draft-threats"]')).toContainText('Невидимость');

    await add(ui, 'allies', 'Lion', 'lion');
    taken.push('lion');

    // Бан лучшего кандидата: исчезает из списка
    const top = (await candidates(ui))[0]!;
    const topName = (await ui.locator(`[data-testid="draft-candidates"] li[data-hero="${top}"] strong`).textContent())!;
    await add(ui, 'bans', topName, top);
    taken.push(top);
    const now = await candidates(ui);
    for (const k of taken) expect(now).not.toContain(k);
    expect(now).toHaveLength(12);

    // Взятых нельзя найти в поиске повторно
    await ui.fill('[data-testid="draft-add-allies"]', 'Bristle');
    await expect(ui.locator('.draft-matches button', { hasText: 'Bristleback' })).toHaveCount(0);
    await ui.fill('[data-testid="draft-add-allies"]', '');

    // Позиция: каждый кандидат играет на ней
    for (const p of [1, 2, 3, 4, 5]) {
      await ui.locator('[data-testid="draft-position"] button', { hasText: new RegExp(`^${p}$`) }).click();
      await expect.poll(async () => ui.locator('[data-testid="draft-candidates"] li').evaluateAll((els, pos) => els.length > 0 && els.every((e) => e.getAttribute('data-positions')!.split(',').includes(String(pos))), p)).toBe(true);
      for (const k of taken) expect(await candidates(ui)).not.toContain(k);
    }
    await ui.locator('[data-testid="draft-position"] button', { hasText: 'любая' }).click();

    // Источник: патч, дата статистики, «ориентир, а не обещание»
    const src = ui.locator('[data-testid="draft-source"]');
    await expect(src).toContainText('Патч 7.41f');
    await expect(src).toContainText(/статистика OpenDota от \d{2}\.\d{2}\.\d{4}/);
    await expect(src).toContainText('ориентир, а не обещание');

    // «Беру»: матчапы моего героя с числом игр, позиция и список кандидатов скрыты, предметы — под роль
    await ui.locator('[data-testid="draft-candidates"] .draft-take').first().click();
    await expect(ui.locator('[data-testid="draft-me-summary"]')).toBeVisible();
    await expect(ui.locator('[data-testid="draft-me-summary"]')).toContainText(/игр/);
    await expect(ui.locator('[data-testid="draft-position"]')).toHaveCount(0);
    await expect(ui.locator('[data-testid="draft-candidates"]')).toHaveCount(0);
    const role = (await ui.locator('[data-testid="draft-me-summary"]').textContent())!.includes('«саппорт»') ? 'саппорт' : 'кор';
    const other = role === 'кор' ? 'саппорт' : 'кор';
    await expect(ui.locator('[data-testid="draft-threats"]')).not.toContainText(`— ${other}`);
  } finally {
    await app.close();
  }
});

test('драфт: нет статистики патча — предупреждение, кандидатов нет', async () => {
  // Внешняя копия базы того же патча, новее встроенной, но без stats.json
  const dir = join(tmp(), 'kb');
  const src = join(ROOT, 'resources/data/kb/7.41f');
  mkdirSync(join(dir, '7.41f'), { recursive: true });
  writeFileSync(join(dir, 'current.json'), JSON.stringify({ patch: '7.41f' }));
  for (const f of ['heroes.json', 'items.json', 'mechanics.json']) writeFileSync(join(dir, '7.41f', f), readFileSync(join(src, f)));
  const meta = JSON.parse(readFileSync(join(src, 'meta.json'), 'utf8'));
  writeFileSync(join(dir, '7.41f', 'meta.json'), JSON.stringify({ ...meta, generatedAt: '2099-01-01T00:00:00.000Z' }));

  const dataDir = tmp();
  writeFileSync(join(dataDir, 'settings.json'), JSON.stringify({ live: { autoStart: false } }));
  const app = await electron.launch({
    args: ['.'],
    cwd: ROOT,
    env: { ...process.env, DOTACOACH_DATA_DIR: dataDir, ELECTRON_RENDERER_URL: '', DOTACOACH_NO_UPDATE_CHECK: '1', DOTACOACH_KB_EXTERNAL_DIR: dir },
  });
  try {
    let ui: Page | undefined;
    for (let i = 0; i < 100 && !ui; i++) {
      ui = app.windows().find((p) => p.url().includes('/renderer/index.html'));
      if (!ui) await new Promise((r) => setTimeout(r, 100));
    }
    await ui!.waitForSelector('[data-testid="page-dashboard"]');
    await ui!.click('[data-testid="nav-draft"]');
    await expect(ui!.getByText('Нет статистики патча (stats.json): подбор героя недоступен.')).toBeVisible();
    await expect(ui!.locator('[data-testid="draft-candidates"] li')).toHaveCount(0);
  } finally {
    await app.close();
  }
});

for (const [w, h] of [[1280, 720], [1920, 1080], [2560, 1080]] as const) {
  test(`драфт: при ${w}×${h} элементы видны, не перекрыты и нет горизонтальной прокрутки`, async () => {
    const { app, ui } = await launch();
    try {
      await app.evaluate(({ BrowserWindow }, size) => {
        const win = BrowserWindow.getAllWindows().find((b) => b.webContents.getURL().includes('/renderer/index.html'))!;
        win.unmaximize();
        win.setContentSize(size.w, size.h);
      }, { w, h });
      await expect.poll(() => ui.evaluate(() => [window.innerWidth, window.innerHeight].join('x'))).toBe(`${w}x${h}`);
      for (const [name, key] of [['Bristleback', 'bristleback'], ['Riki', 'riki']] as const) await add(ui, 'enemies', name, key);
      await add(ui, 'allies', 'Lion', 'lion');

      const problems = await ui.evaluate(() => {
        const out: string[] = [];
        if (document.documentElement.scrollWidth > document.documentElement.clientWidth + 1) out.push(`горизонтальная прокрутка ${document.documentElement.scrollWidth} > ${document.documentElement.clientWidth}`);
        const controls = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="page-draft"] input, [data-testid="page-draft"] button')).filter((e) => e.offsetParent !== null);
        for (const el of controls) {
          el.scrollIntoView({ block: 'center', inline: 'center' });
          const r = el.getBoundingClientRect();
          if (r.width < 4 || r.height < 4) continue;
          if (r.left < 0 || r.right > window.innerWidth + 1) out.push(`за краем: ${el.textContent || el.getAttribute('data-testid')}`);
          const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (top && top !== el && !el.contains(top)) out.push(`перекрыт: «${(el.textContent || el.getAttribute('placeholder') || '').trim()}» элементом ${top.tagName}.${top.className}`);
        }
        window.scrollTo(0, 0);
        return { out, n: controls.length };
      });
      expect(problems.n).toBeGreaterThan(15);
      expect(problems.out).toEqual([]);
      mkdirSync(SHOTS, { recursive: true });
      await ui.screenshot({ path: join(SHOTS, `draft-${w}x${h}.png`), fullPage: true });
    } finally {
      await app.close();
    }
  });
}
