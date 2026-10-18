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
  /** Окно Доты активно (на переднем плане); null — не известно (помощник старой версии или перезапускается) */
  active?: boolean | null;
  /** Процесс активного окна (для лога: что перекрыло Доту); null — не сообщено */
  foreground?: string | null;
}

/** Сколько активное окно должно быть чужим, прежде чем прятать подсказки: короткие переключения не в счёт */
export const INACTIVE_GRACE_MS = 2500;
/** Перезапуски помощника, если он сам завершился, пока окно Доты есть */
const MAX_RESTARTS = 5;
const RESTART_MS = 2000;

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

/** Строка помощника: «x y w h minimized [active [процесс]]» или «gone» */
export function parseRectLine(line: string): WindowRect | 'gone' | null {
  const t = line.trim();
  if (t === 'gone') return 'gone';
  const m = /^(-?\d+) (-?\d+) (\d+) (\d+) ([01])(?: ([01]))?(?: (\S{1,64}))?$/.exec(t);
  if (!m) return null;
  const [x, y, width, height] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
  const active = m[6] === undefined ? null : m[6] === '1';
  const foreground = m[7] ?? null;
  if (width < 200 || height < 150) return m[5] === '1' ? { x, y, width, height, minimized: true, active, foreground } : null;
  return { x, y, width, height, minimized: m[5] === '1', active, foreground };
}

/**
 * Скрипт PowerShell: только чтение положения окна hwnd, раз в intervalMs. «Активно» — на переднем плане окно Доты,
 * другое окно того же процесса, окно самого коуча (selfPid) или прозрачный оверлей поверх игры (Discord, NVIDIA:
 * WS_EX_TRANSPARENT / TOOLWINDOW / NOACTIVATE) — они не значат, что игрок ушёл из игры.
 */
export function rectScript(hwnd: number, intervalMs: number, selfPid = 0): string {
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
    '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i);',
    '}',
    '"@',
    `$h = [IntPtr]::new(${hwnd})`,
    `$self = ${Math.max(0, Math.trunc(selfPid))}`,
    '$dp = [uint32]0; [void][DcWin]::GetWindowThreadProcessId($h, [ref]$dp)',
    "$lastFg = [IntPtr]::new(-1); $act = 1; $fgName = '-'",
    'while ($true) {',
    "  if (-not [DcWin]::IsWindow($h)) { [Console]::Out.WriteLine('gone'); [Console]::Out.Flush(); break }",
    '  $r = New-Object DcWin+R; $p = New-Object DcWin+P',
    '  [void][DcWin]::GetClientRect($h, [ref]$r); [void][DcWin]::ClientToScreen($h, [ref]$p)',
    '  $fg = [DcWin]::GetForegroundWindow()',
    '  if ($fg -ne $lastFg) {',
    '    $lastFg = $fg; $fp = [uint32]0; [void][DcWin]::GetWindowThreadProcessId($fg, [ref]$fp); $ex = [DcWin]::GetWindowLong($fg, -20)',
    '    $act = [int](($fg -eq $h) -or ($fg -eq [IntPtr]::Zero) -or ($fp -eq $dp) -or ($self -ne 0 -and $fp -eq $self) -or (($ex -band 0x080000A0) -ne 0))',
    "    try { $fgName = ((Get-Process -Id $fp -ErrorAction Stop).ProcessName -replace '[^A-Za-z0-9_.-]', '_') } catch { $fgName = '-' }",
    "    if ($fgName.Length -gt 64) { $fgName = $fgName.Substring(0, 64) }",
    '  }',
    "  [Console]::Out.WriteLine(('{0} {1} {2} {3} {4} {5} {6}' -f $p.X, $p.Y, ($r.Rt - $r.L), ($r.B - $r.T), [int][DcWin]::IsIconic($h), $act, $fgName))",
    '  [Console]::Out.Flush()',
    `  Start-Sleep -Milliseconds ${intervalMs}`,
    '}',
  ].join('\n');
}

export interface TrackerOptions {
  intervalMs?: number;
  now?: () => number;
  spawnHelper?: (script: string) => ChildProcess;
  platform?: string;
  selfPid?: number;
}

export class WindowRectTracker {
  private child: ChildProcess | null = null;
  private hwnd: number | null = null;
  private buf = '';
  private gone = false;
  private restarts = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** С какого момента активно чужое окно (по строкам помощника); null — Дота активна */
  private inactiveSince: number | null = null;
  private lastActive: boolean | null | undefined = undefined;
  /** Последний прямоугольник; null — не известен */
  rect: WindowRect | null = null;
  /** Помощник не запустился (не Windows или запрещён) — дальше не пробуем */
  failed = false;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly spawnHelper: (script: string) => ChildProcess;
  private readonly platform: string;
  private readonly selfPid: number;

  constructor(private readonly onChange: (r: WindowRect | null) => void, private readonly log: (...a: unknown[]) => void, opts: TrackerOptions = {}) {
    this.intervalMs = opts.intervalMs ?? 1000;
    this.now = opts.now ?? Date.now;
    this.platform = opts.platform ?? process.platform;
    this.selfPid = opts.selfPid ?? process.pid;
    this.spawnHelper =
      opts.spawnHelper ??
      ((script) => spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }));
  }

  track(hwnd: number | null): void {
    if (hwnd === this.hwnd && this.child) return;
    this.stop();
    this.hwnd = hwnd;
    this.restarts = 0;
    this.start();
  }

  private start(): void {
    const hwnd = this.hwnd;
    if (hwnd === null || this.failed || this.platform !== 'win32') return;
    this.gone = false;
    const child = this.spawnHelper(rectScript(hwnd, this.intervalMs, this.selfPid));
    this.child = child;
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => {
      this.buf += d;
      let i;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i);
        this.buf = this.buf.slice(i + 1);
        this.handleLine(line);
      }
    });
    child.stderr?.on('data', (d: Buffer) => this.log('hud window-rect stderr', String(d).slice(0, 300)));
    child.on('error', (e) => {
      this.failed = true;
      this.log('hud window-rect failed', String(e));
    });
    child.on('exit', (code) => {
      if (this.child !== child) return;
      this.child = null;
      this.buf = '';
      if (code && code !== 0 && this.rect === null) {
        this.failed = true;
        return;
      }
      if (this.gone || this.failed || this.hwnd !== hwnd) return;
      // Помощник завершился сам, а окно Доты есть: «активно» больше не известно — не прячем подсказки
      // по устаревшему значению и перезапускаем помощник
      this.log('hud window-rect exit', { code, restarts: this.restarts });
      this.inactiveSince = null;
      if (this.rect && this.rect.active !== null) this.set({ ...this.rect, active: null, foreground: null });
      if (this.restarts >= MAX_RESTARTS) return;
      this.restarts++;
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        if (this.hwnd === hwnd && !this.child) this.start();
      }, RESTART_MS);
      this.restartTimer.unref?.();
    });
  }

  /** Строка помощника → прямоугольник; «не активно» засчитывается, только если длится INACTIVE_GRACE_MS */
  handleLine(line: string): void {
    const r = parseRectLine(line);
    if (r === null) return;
    if (r === 'gone') {
      this.gone = true;
      this.inactiveSince = null;
      this.set(null);
      return;
    }
    let active = r.active ?? null;
    if (active === false) {
      const t = this.now();
      if (this.inactiveSince === null) this.inactiveSince = t;
      if (t - this.inactiveSince < INACTIVE_GRACE_MS) active = true;
    } else this.inactiveSince = null;
    if (active !== this.lastActive && this.lastActive !== undefined) this.log('hud active', { active, foreground: r.foreground ?? null });
    this.lastActive = active;
    this.set({ ...r, active });
  }

  private set(next: WindowRect | null): void {
    const changed = JSON.stringify(next) !== JSON.stringify(this.rect);
    this.rect = next;
    if (changed) this.onChange(next);
  }

  stop(): void {
    if (this.restartTimer) clearTimeout(this.restartTimer);
    this.restartTimer = null;
    const child = this.child;
    this.child = null;
    child?.kill();
    this.hwnd = null;
    this.buf = '';
    this.inactiveSince = null;
    this.lastActive = undefined;
    if (this.rect !== null) {
      this.rect = null;
      this.onChange(null);
    }
  }
}
