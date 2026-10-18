// Окно подсказок поверх игры: номер окна Доты из захвата, разбор строк помощника, настройки подсказок.
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { WindowRectTracker, hudShouldShow, hwndFromSourceId, parseRectLine, rectScript } from '../../src/main/live/window-rect';
import { settingsSchema, settingsPatchSchema, applySettingsPatch, defaultSettings } from '../../src/shared/schemas/settings';
import { hudStateSchema } from '../../src/shared/types/hud';
import { sampleHints } from '../../src/shared/hud-samples';

describe('положение окна Доты', () => {
  it('номер окна из id источника захвата', () => {
    expect(hwndFromSourceId('window:132456:0')).toBe(132456);
    expect(hwndFromSourceId('screen:0:0')).toBeNull();
    expect(hwndFromSourceId(null)).toBeNull();
    expect(hwndFromSourceId('window:abc:0')).toBeNull();
  });
  it('строки помощника: прямоугольник, свёрнуто, окно закрыто, мусор', () => {
    expect(parseRectLine('0 0 1920 1080 0')).toEqual({ x: 0, y: 0, width: 1920, height: 1080, minimized: false, active: null, foreground: null });
    expect(parseRectLine('-1920 0 2560 1440 0\r')).toEqual({ x: -1920, y: 0, width: 2560, height: 1440, minimized: false, active: null, foreground: null });
    expect(parseRectLine('-32000 -32000 0 0 1')).toEqual({ x: -32000, y: -32000, width: 0, height: 0, minimized: true, active: null, foreground: null });
    expect(parseRectLine('0 0 1920 1080 0 0 Telegram')).toMatchObject({ active: false, foreground: 'Telegram' });
    expect(parseRectLine('gone')).toBe('gone');
    expect(parseRectLine('Exception: ...')).toBeNull();
    expect(parseRectLine('10 10 50 50 0')).toBeNull();
  });
  it('активно ли окно Доты: шестое поле помощника (Telegram на переднем плане → 0)', () => {
    expect(parseRectLine('0 0 1920 1080 0 1')).toMatchObject({ minimized: false, active: true });
    expect(parseRectLine('0 0 1920 1080 0 0')).toMatchObject({ minimized: false, active: false });
    expect(rectScript(1, 1000)).toContain('GetForegroundWindow');
  });
  // На сервере CI нет рабочего стола с настоящими окнами — помощник там ничего не печатает, проверка только на ПК
  it.runIf(process.platform === 'win32' && !process.env.CI)('настоящая Windows: помощник печатает прямоугольник и «активно» для живого окна', async () => {
    const { spawnSync } = await import('node:child_process');
    const list = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle.ToInt64()'], { encoding: 'utf8' });
    const hwnd = Number(list.stdout.trim());
    expect(hwnd).toBeGreaterThan(0);
    const script = rectScript(hwnd, 200).replace('while ($true)', 'for ($i = 0; $i -lt 2; $i++)');
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { encoding: 'utf8', timeout: 30_000 });
    const lines = r.stdout.split(/\r?\n/).filter(Boolean).map(parseRectLine).filter((x) => x !== null && x !== 'gone');
    expect(r.stderr).toBe('');
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(typeof (l as { active: unknown }).active).toBe('boolean');
  }, 40_000);
  it('скрипт только читает: GetClientRect / ClientToScreen / IsIconic, без записи и без процесса игры', () => {
    const s = rectScript(132456, 1000);
    expect(s).toContain('[IntPtr]::new(132456)');
    for (const bad of ['OpenProcess', 'ReadProcessMemory', 'WriteProcessMemory', 'SetWindowPos', 'SendMessage', 'PostMessage', 'keybd_event', 'SendInput', 'SetWindowLong']) expect(s).not.toContain(bad);
  });
  it('оверлеи поверх игры (Discord, NVIDIA), окна самого коуча и процесса Доты — не «ушёл из игры»', () => {
    const s = rectScript(132456, 1000, 4242);
    expect(s).toContain('$self = 4242');
    expect(s).toContain('0x080000A0'); // WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW | WS_EX_TRANSPARENT
    expect(s).toContain('$fp -eq $dp');
  });
});

describe('помощник положения окна: защита от ложного «Дота не активна» (подсказки пропали в конце матча)', () => {
  const fakeChild = () => {
    const c = new EventEmitter() as EventEmitter & { stdout: EventEmitter & { setEncoding(): void }; stderr: EventEmitter; kill(): void };
    c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    c.stderr = new EventEmitter();
    c.kill = () => {};
    return c;
  };
  const make = () => {
    let t = 0;
    const children: ReturnType<typeof fakeChild>[] = [];
    const logs: unknown[][] = [];
    const tr = new WindowRectTracker(() => {}, (...a) => logs.push(a), {
      now: () => t,
      platform: 'win32',
      spawnHelper: () => {
        const c = fakeChild();
        children.push(c);
        return c as never;
      },
    });
    return { tr, children, logs, at: (ms: number) => (t = ms) };
  };
  const line = (active: 0 | 1, fg = 'dota2') => `0 0 2560 1440 0 ${active} ${fg}\n`;

  it('чужое окно на мгновение (уведомление, оверлей) — подсказки не прячутся; дольше 2,5 с — прячутся', () => {
    const { tr, children, logs, at } = make();
    tr.track(1);
    children[0]!.stdout.emit('data', line(1));
    at(1000);
    children[0]!.stdout.emit('data', line(0, 'Discord'));
    expect(tr.rect?.active).toBe(true);
    at(2000);
    children[0]!.stdout.emit('data', line(1));
    at(3000);
    children[0]!.stdout.emit('data', line(0, 'Telegram'));
    at(5000);
    children[0]!.stdout.emit('data', line(0, 'Telegram'));
    expect(tr.rect?.active).toBe(true);
    at(5600);
    children[0]!.stdout.emit('data', line(0, 'Telegram'));
    expect(tr.rect?.active).toBe(false);
    expect(logs).toContainEqual(['hud active', { active: false, foreground: 'Telegram' }]);
    children[0]!.stdout.emit('data', line(1));
    expect(tr.rect?.active).toBe(true);
  });

  it('помощник завершился сам — «активно» сбрасывается в «не известно» (подсказки видны) и помощник перезапускается', () => {
    vi.useFakeTimers();
    try {
      const { tr, children, at } = make();
      tr.track(1);
      at(0);
      children[0]!.stdout.emit('data', line(0, 'Telegram'));
      at(3000);
      children[0]!.stdout.emit('data', line(0, 'Telegram'));
      expect(tr.rect?.active).toBe(false);
      children[0]!.emit('exit', 0);
      expect(tr.rect?.active).toBeNull();
      expect(hudShouldShow({ enabled: true, hasContent: true, demo: false, rect: tr.rect })).toBe(true);
      vi.advanceTimersByTime(2500);
      expect(children.length).toBe(2);
      children[1]!.stdout.emit('data', line(1));
      expect(tr.rect?.active).toBe(true);
      tr.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('окно Доты закрыто («gone») — помощник не перезапускается', () => {
    vi.useFakeTimers();
    try {
      const { tr, children } = make();
      tr.track(1);
      children[0]!.stdout.emit('data', 'gone\n');
      children[0]!.emit('exit', 0);
      vi.advanceTimersByTime(10_000);
      expect(children.length).toBe(1);
      expect(tr.rect).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('настройки подсказок поверх игры', () => {
  it('старый settings.json без раздела hud читается, hud — по умолчанию', () => {
    const s = settingsSchema.parse({ live: { autoStart: false } });
    expect(s.hud).toEqual({ enabled: true, theme: 'runes', reduceMotion: false, opacity: 1, scale: 1, zones: null, hiddenZones: [] });
  });
  it('испорченные значения откатываются по одному', () => {
    const s = settingsSchema.parse({ hud: { theme: 'neon', opacity: 7, zones: { decision: { x: 'a' } }, scale: 1.2 } });
    expect(s.hud.theme).toBe('runes');
    expect(s.hud.opacity).toBe(1);
    expect(s.hud.zones).toBeNull();
    expect(s.hud.scale).toBe(1.2);
  });
  it('патч из интерфейса: строгая проверка', () => {
    expect(() => settingsPatchSchema.parse({ hud: { theme: 'neon' } })).toThrow();
    const next = applySettingsPatch(defaultSettings(), settingsPatchSchema.parse({ hud: { zones: { timing: { x: 0.02, y: 0.4 } }, theme: 'obsidian' } }));
    expect(next.hud.zones).toEqual({ timing: { x: 0.02, y: 0.4 } });
    expect(next.hud.theme).toBe('obsidian');
  });
  it('индикатор режима в состоянии окна: старое состояние без поля — null, мусор — null, верный — проходит', () => {
    const options = { theme: 'runes', reduceMotion: false, opacity: 1, scale: 1, zones: null } as const;
    expect(hudStateSchema.parse({ hints: [], options }).mode).toBeNull();
    expect(hudStateSchema.parse({ hints: [], options, mode: { seq: 1, mode: 'hyper' } }).mode).toBeNull();
    const ok = { seq: 3, mode: 'turbo', source: 'gsi', title: 'Турбо', text: 'Определён по данным игры' } as const;
    expect(hudStateSchema.parse({ hints: [], options, mode: ok }).mode).toEqual(ok);
    expect(hudStateSchema.parse({ hints: [], options, mode: { ...ok, title: 'x'.repeat(41) } }).mode).toBeNull();
  });
  it('примеры всех сцен проходят схему состояния окна', () => {
    for (const scene of ['alive', 'dead', 'match'] as const)
      for (const d of ['min', 'normal', 'detailed'] as const) expect(hudStateSchema.safeParse({ hints: sampleHints(scene, d), options: { theme: 'runes', reduceMotion: false, opacity: 1, scale: 1, zones: null } }).success).toBe(true);
  });
});
