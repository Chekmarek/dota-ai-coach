// Где на экране окно Доты (только чтение): Windows сама сообщает прямоугольник окна по его номеру (HWND) —
// GetClientRect + ClientToScreen из user32. Это не чтение памяти игры и не вмешательство в процесс: так любое
// приложение узнаёт положение чужого окна. Один долгоживущий процесс PowerShell печатает прямоугольник раз в
// секунду; Electron сам этого не умеет без нативного модуля.
// Не получилось (не Windows, PowerShell запрещён, окно закрыто) — оверлей занимает экран, где Дота (см. hud-window.ts).
import { spawn, type ChildProcess } from 'node:child_process';

export interface WindowRect {
  /** Клиентская область окна (без рамки и заголовка), физические пиксели экрана */
  x: number;
  y: number;
  width: number;
  height: number;
  minimized: boolean;
  /** Окно Доты активно (на переднем плане); null — помощник старой версии не сообщил */
  active?: boolean | null;
}

/**
 * Показывать ли подсказки поверх игры: есть что показать, и Дота не свёрнута и активна. Пока активно другое окно
 * (Telegram, браузер), оверлей спрятан; демо из «Предпросмотра» показывается всегда (его включают из окна коуча).
 * Положение окна не известно (помощник не запустился) — как раньше: показываем.
 */
export function hudShouldShow(o: { enabled: boolean; hasContent: boolean; demo: boolean; rect: WindowRect | null }): boolean {
  if (!o.enabled || !o.hasContent) return false;
  if (o.demo) return true;
  return !(o.rect?.minimized === true || o.rect?.active === false);
}

/** Номер окна из id источника desktopCapturer: «window:132456:0» → 132456 */
export function hwndFromSourceId(id: string | null | undefined): number | null {
  const m = /^window:(\d+):/.exec(id ?? '');
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/** Строка помощника: «x y w h minimized active» (active — необязательно) или «gone» */
export function parseRectLine(line: string): WindowRect | 'gone' | null {
  const t = line.trim();
  if (t === 'gone') return 'gone';
  const m = /^(-?\d+) (-?\d+) (\d+) (\d+) ([01])(?: ([01]))?$/.exec(t);
  if (!m) return null;
  const [x, y, width, height] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  const active = m[6] === undefined ? null : m[6] === '1';
  if (width < 200 || height < 150) return m[5] === '1' ? { x, y, width, height, minimized: true, active } : null;
  return { x, y, width, height, minimized: m[5] === '1', active };
}

/** Скрипт PowerShell: только чтение положения окна hwnd, раз в intervalMs */
export function rectScript(hwnd: number, intervalMs: number): string {
  return [
    "$ErrorActionPreference='Stop'",
    'Add-Type -TypeDefinition @"',
    'using System; using System.Runtime.InteropServices;',
    'public static class DcWin {',
    '  [StructLayout(LayoutKind.Sequential)] public struct R { public int L, T, Rt, B; }',
    '  [StructLayout(LayoutKind.Sequential)] public struct P { public int X, Y; }',
    '  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr h, out R r);',
    '  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref P p);',
    '}',
    '"@',
    `$h = [IntPtr]::new(${hwnd})`,
    'while ($true) {',
    "  if (-not [DcWin]::IsWindow($h)) { [Console]::Out.WriteLine('gone'); [Console]::Out.Flush(); break }",
    '  $r = New-Object DcWin+R; $p = New-Object DcWin+P',
    '  [void][DcWin]::GetClientRect($h, [ref]$r); [void][DcWin]::ClientToScreen($h, [ref]$p)',
    "  [Console]::Out.WriteLine(('{0} {1} {2} {3} {4} {5}' -f $p.X, $p.Y, ($r.Rt - $r.L), ($r.B - $r.T), [int][DcWin]::IsIconic($h), [int]([DcWin]::GetForegroundWindow() -eq $h)))",
    '  [Console]::Out.Flush()',
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    '}',
  ].join('\n');
}

export class WindowRectTracker {
  private child: ChildProcess | null = null;
  private hwnd: number | null = null;
  private buf = '';
  /** Последний прямоугольник; null — не известен */
  rect: WindowRect | null = null;
  /** Помощник не запустился (не Windows или запрещён) — дальше не пробуем */
  failed = false;

  constructor(private readonly onChange: (r: WindowRect | null) => void, private readonly log: (...a: unknown[]) => void, private readonly intervalMs = 1000) {}

  track(hwnd: number | null): void {
    if (hwnd === this.hwnd && this.child) return;
    this.stop();
    this.hwnd = hwnd;
    if (hwnd === null || this.failed || process.platform !== 'win32') return;
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', rectScript(hwnd, this.intervalMs)], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        const r = parseRectLine(line);
        if (r === null) continue;
        const next = r === 'gone' ? null : r;
        const changed = JSON.stringify(next) !== JSON.stringify(this.rect);
        this.rect = next;
        if (changed) this.onChange(next);
      }
    });
    child.stderr?.on('data', (d: Buffer) => this.log('hud window-rect stderr', String(d).slice(0, 300)));
    child.on('error', (e) => {
      this.failed = true;
      this.log('hud window-rect failed', String(e));
    });
    child.on('exit', (code) => {
      if (this.child === child) this.child = null;
      if (code && code !== 0 && this.rect === null) this.failed = true;
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.hwnd = null;
    this.buf = '';
    if (this.rect !== null) {
      this.rect = null;
      this.onChange(null);
    }
  }
}
