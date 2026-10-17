// llama-server на 127.0.0.1 (случайный свободный порт): запускается только по запросу, приоритет ниже обычного,
// потоков — половина логических ядер (не меньше 2), контекст 4096; останавливается после 5 минут простоя и при выходе.
// Без Electron — используется и приложением, и npm run ai:bench / ai:eval.
import { spawn, execFile, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { cpus, setPriority, constants } from 'node:os';
import { AiError } from '@core/ai/provider.ts';
import type { AiModelId } from '@shared/schemas/settings';
import { CONTEXT_TOKENS, IDLE_STOP_MS, threadsFor } from './manifest';

export interface SidecarState {
  status: 'stopped' | 'starting' | 'ready' | 'error';
  model: AiModelId | null;
  error: string | null;
  loadMs: number | null;
  pid: number | null;
  port: number | null;
  threads: number | null;
}

export interface SidecarDeps {
  exe: () => string;
  modelPath: (m: AiModelId) => string;
  installed: (m: AiModelId) => boolean;
  onState?: (s: SidecarState) => void;
  log?: (line: string) => void;
  idleStopMs?: number;
  startTimeoutMs?: number;
  threads?: number;
  /** Идёт матч: меньше потоков (с 0.12.0) */
  inMatch?: () => boolean;
  /** Подмена запуска (тесты): по аргументам llama-server — что запускать */
  command?: (exe: string, args: string[]) => { file: string; args: string[] };
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => resolve(port));
    });
  });
}

/** Память процесса (рабочий набор), байты — через tasklist; null — не удалось */
export function processRamBytes(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (err, out) => {
      if (err) return resolve(null);
      // "llama-server.exe","1234","Console","1","1 234 567 K" (разделитель тысяч зависит от языка Windows)
      const cols = out.trim().split('","');
      const mem = cols[4]?.replace(/[^\d]/g, '');
      resolve(mem ? Number(mem) * 1024 : null);
    });
  });
}

export class LlamaSidecar {
  state: SidecarState = { status: 'stopped', model: null, error: null, loadMs: null, pid: null, port: null, threads: null };
  private child: ChildProcess | null = null;
  private starting: Promise<string> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private tail: string[] = [];

  constructor(private readonly deps: SidecarDeps) {}

  private set(p: Partial<SidecarState>): void {
    this.state = { ...this.state, ...p };
    this.deps.onState?.(this.state);
  }

  get baseUrl(): string | null {
    return this.state.status === 'ready' && this.state.port ? `http://127.0.0.1:${this.state.port}/v1` : null;
  }

  /** Сервер с нужной моделью: запускает при необходимости */
  async ensure(model: AiModelId, signal?: AbortSignal): Promise<string> {
    // Сервер запущен до матча с половиной ядер, а матч уже идёт — перезапускаем с меньшим числом потоков
    const wantThreads = this.threads();
    const tooMany = this.deps.threads === undefined && this.state.threads !== null && this.state.threads > wantThreads;
    if (this.state.status === 'ready' && this.state.model === model && this.baseUrl && !tooMany) {
      this.touch();
      return this.baseUrl;
    }
    if (this.starting && this.state.model === model) return this.wait(this.starting, signal);
    this.stop();
    if (!this.deps.installed(model)) throw new AiError('local-missing');
    this.starting = this.start(model).finally(() => (this.starting = null));
    return this.wait(this.starting, signal);
  }

  private wait(p: Promise<string>, signal?: AbortSignal): Promise<string> {
    if (!signal) return p;
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason instanceof AiError ? signal.reason : new AiError('cancelled'));
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      p.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  }

  private threads(): number {
    return this.deps.threads ?? threadsFor(cpus().length, this.deps.inMatch?.() ?? false);
  }

  private async start(model: AiModelId): Promise<string> {
    const threads = this.threads();
    const port = await freePort();
    const t0 = Date.now();
    this.tail = [];
    this.set({ status: 'starting', model, error: null, loadMs: null, port, threads, pid: null });
    const args = [
      '-m', this.deps.modelPath(model),
      '--host', '127.0.0.1',
      '--port', String(port),
      '-c', String(CONTEXT_TOKENS),
      '-t', String(threads),
      '-tb', String(threads),
      '-np', '1',
      '--jinja',
      '--no-webui',
      // память: без второй (переупакованной) копии весов — 1.7B ≈ 1,7 ГБ вместо 2,3 ГБ, скорость почти та же.
      // KV-кэш q8_0 экономит ещё ~0,2 ГБ, но вдвое замедляет чтение фактов (114 против 176 токенов/с) — не включаем
      // (замеры 2026-10-15)
      '--no-repack',
    ];
    const cmd = this.deps.command ? this.deps.command(this.deps.exe(), args) : { file: this.deps.exe(), args };
    const child = spawn(cmd.file, cmd.args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.child = child;
    const keepTail = (d: Buffer) => {
      for (const line of d.toString('utf8').split(/\r?\n/)) if (line.trim()) this.tail.push(line.slice(0, 300));
      if (this.tail.length > 30) this.tail.splice(0, this.tail.length - 30);
    };
    child.stdout?.on('data', keepTail);
    child.stderr?.on('data', keepTail);
    let exited = false;
    child.on('exit', (code) => {
      exited = true;
      if (this.child !== child) return;
      this.child = null;
      if (this.state.status === 'ready' || this.state.status === 'starting') {
        const wasStarting = this.state.status === 'starting';
        this.set({ status: wasStarting ? 'error' : 'stopped', error: wasStarting ? `llama-server завершился (код ${code})` : null, pid: null, port: null });
        if (wasStarting) this.deps.log?.(`ai llama-server завершился при запуске: ${this.tail.slice(-5).join(' | ')}`);
      }
    });
    child.on('error', () => undefined);
    if (child.pid) {
      try {
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL);
      } catch {
        /* приоритет не поменять — работаем с обычным */
      }
    }
    this.set({ pid: child.pid ?? null });
    const deadline = t0 + (this.deps.startTimeoutMs ?? 180_000);
    while (Date.now() < deadline) {
      if (exited || this.child !== child) {
        throw new AiError('local-failed', 'Локальный ИИ не запустился: возможно, процессор слишком старый или не хватает памяти');
      }
      try {
        const r = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) });
        if (r.ok) {
          this.set({ status: 'ready', loadMs: Date.now() - t0 });
          this.deps.log?.(`ai llama-server готов: ${model}, ${threads} потоков, загрузка ${Date.now() - t0} мс`);
          this.touch();
          return `http://127.0.0.1:${port}/v1`;
        }
      } catch {
        /* ещё не слушает */
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    this.stop();
    this.set({ status: 'error', error: 'Локальный ИИ слишком долго загружается' });
    throw new AiError('local-failed', 'Локальный ИИ слишком долго загружается');
  }

  /** Отметка использования: отсчёт простоя заново */
  touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      this.deps.log?.('ai llama-server остановлен после простоя');
      this.stop();
    }, this.deps.idleStopMs ?? IDLE_STOP_MS);
    this.idleTimer.unref?.();
  }

  stop(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    const c = this.child;
    this.child = null;
    if (c && c.exitCode === null) c.kill();
    if (this.state.status !== 'error' || c) this.set({ status: 'stopped', pid: null, port: null, error: null });
  }

  async ramBytes(): Promise<number | null> {
    return this.state.pid ? processRamBytes(this.state.pid) : null;
  }
}
