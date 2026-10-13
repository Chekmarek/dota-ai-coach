// Приёмник Valve Game State Integration: Dota сама присылает POST с JSON о матче своего героя.
// Только 127.0.0.1, только POST, тело ≤ 256 КБ, секрет auth.token сверяется за постоянное время.
// Без Electron — модуль проверяется unit-тестами. Тело запроса в журнал не пишется никогда.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export const GSI_HOST = '127.0.0.1';
export const GSI_MAX_BODY = 256 * 1024;

export type GsiServerState = 'off' | 'starting' | 'listening' | 'port-busy' | 'error';

export interface GsiServerOptions {
  port: number;
  token: string;
  /** Проверенное тело запроса (уже разобранный JSON с верным токеном) */
  onBody: (body: Record<string, unknown>, wallMs: number) => void;
  /** Одна строка в журнал (live.log) — без содержимого запроса */
  log?: (line: string) => void;
  now?: () => number;
}

export interface GsiServerStats {
  state: GsiServerState;
  port: number;
  /** Ошибка запуска (кроме «порт занят») */
  error: string | null;
  accepted: number;
  rejected: number;
  lastBodyAt: number | null;
}

const LOOPBACK = new Set(['127.0.0.1', '::ffff:127.0.0.1', '::1']);

/** Сравнение строк за постоянное время (длина тоже не утекает: сравниваются хеши) */
export function sameToken(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a, 'utf8').digest();
  const hb = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(ha, hb) && a.length > 0 && b.length > 0;
}

export class GsiServer {
  private server: Server | null = null;
  private stats: GsiServerStats;
  /** Журнал отказов — не чаще раза в 10 с для одной причины, чтобы чужая программа не забила live.log */
  private lastLogAt = new Map<string, number>();

  constructor(private readonly opts: GsiServerOptions) {
    this.stats = { state: 'off', port: opts.port, error: null, accepted: 0, rejected: 0, lastBodyAt: null };
  }

  get status(): GsiServerStats {
    return { ...this.stats };
  }

  /** Адрес, на котором слушает приёмник (для проверки, что только 127.0.0.1) */
  get boundHost(): string | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? (a as AddressInfo).address : null;
  }

  /** Фактический порт (для тестов с портом 0) */
  get boundPort(): number | null {
    const a = this.server?.address();
    return a && typeof a === 'object' ? (a as AddressInfo).port : null;
  }

  start(): Promise<GsiServerState> {
    if (this.server) return Promise.resolve(this.stats.state);
    this.stats.state = 'starting';
    this.stats.error = null;
    const server = createServer((req, res) => this.handle(req, res));
    // Dota держит соединение открытым между запросами; долго висящие чужие соединения закрываем
    server.requestTimeout = 10_000;
    server.headersTimeout = 5_000;
    server.keepAliveTimeout = 15_000;
    this.server = server;
    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.server = null;
        if (err.code === 'EADDRINUSE' || err.code === 'EACCES') {
          this.stats.state = 'port-busy';
          this.log('port-busy', `gsi порт ${this.opts.port} занят (${err.code})`);
        } else {
          this.stats.state = 'error';
          this.stats.error = err.message;
          this.log('error', `gsi ошибка запуска: ${err.code ?? err.message}`);
        }
        resolve(this.stats.state);
      });
      // Только локальный адрес: из сети приёмник не виден
      server.listen(this.opts.port, GSI_HOST, () => {
        this.stats.state = 'listening';
        this.stats.port = this.boundPort ?? this.opts.port;
        this.log('listen', `gsi слушает ${GSI_HOST}:${this.stats.port}`);
        resolve('listening');
      });
    });
  }

  stop(): Promise<void> {
    const s = this.server;
    this.server = null;
    this.stats.state = 'off';
    if (!s) return Promise.resolve();
    return new Promise((resolve) => {
      s.close(() => resolve());
      s.closeAllConnections();
    });
  }

  private log(kind: string, line: string): void {
    const now = (this.opts.now ?? Date.now)();
    if (now - (this.lastLogAt.get(kind) ?? -Infinity) < 10_000) return;
    this.lastLogAt.set(kind, now);
    this.opts.log?.(line);
  }

  private reject(res: ServerResponse, code: number, reason: string): void {
    this.stats.rejected++;
    this.log(`reject-${code}`, `gsi отклонён запрос: ${code} ${reason}`);
    if (!res.headersSent) res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' });
    res.end();
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const remote = req.socket.remoteAddress ?? '';
    if (!LOOPBACK.has(remote)) {
      req.resume();
      return this.reject(res, 403, 'не локальный адрес');
    }
    // Dota не шлёт Origin; он есть у запросов со страниц браузера — их не принимаем
    if (req.headers.origin !== undefined) {
      req.resume();
      return this.reject(res, 403, 'запрос из браузера');
    }
    if (req.method !== 'POST') {
      req.resume();
      res.setHeader('allow', 'POST');
      return this.reject(res, 405, `метод ${String(req.method).slice(0, 10)}`);
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > GSI_MAX_BODY) {
      req.resume();
      return this.reject(res, 413, `тело ${declared} байт`);
    }

    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on('data', (c: Buffer) => {
      if (tooLarge) return;
      size += c.length;
      if (size > GSI_MAX_BODY) {
        tooLarge = true;
        chunks.length = 0;
        this.reject(res, 413, `тело больше ${GSI_MAX_BODY} байт`);
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('error', () => undefined);
    req.on('end', () => {
      if (tooLarge) return;
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return this.reject(res, 400, 'не JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) return this.reject(res, 400, 'не объект');
      const auth = (body as { auth?: { token?: unknown } }).auth;
      const token = auth && typeof auth.token === 'string' ? auth.token : '';
      if (!sameToken(token, this.opts.token)) return this.reject(res, 401, 'неверный токен');

      // Отвечаем сразу: Dota ждёт ответа, прежде чем слать следующее состояние
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      res.end();
      const wallMs = (this.opts.now ?? Date.now)();
      this.stats.accepted++;
      this.stats.lastBodyAt = wallMs;
      try {
        this.opts.onBody(body as Record<string, unknown>, wallMs);
      } catch (err) {
        this.log('forward', `gsi ошибка передачи: ${(err as Error).message}`);
      }
    });
  }
}
