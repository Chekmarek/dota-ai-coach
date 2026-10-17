// Скачивание локального ИИ в <папка данных>/ai/: докачка после обрыва (Range), повтор при сбое, проверка SHA-256,
// распаковка zip системным tar.exe Windows (без новых зависимостей). Без Electron — проверяется unit-тестами.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { AiModelId } from '@shared/schemas/settings';
import { ALL_MODELS, RUNTIME, type PinnedFile } from './manifest';

export interface DownloadProgress {
  status: 'idle' | 'downloading' | 'verifying' | 'extracting' | 'error' | 'done';
  file: string | null;
  received: number;
  total: number;
  error: string | null;
}

export interface InstallerDeps {
  fetchImpl?: typeof fetch;
  /** Распаковка zip; по умолчанию — tar.exe из System32 */
  extract?: (zip: string, dir: string) => Promise<void>;
  /** Пауза перед повтором, мс */
  retryDelayMs?: number;
  /** Модели, которые можно скачать; в тестах — свой набор (не обязательно все) */
  files?: { runtime: typeof RUNTIME; models: Partial<Record<AiModelId, PinnedFile & { nameRu: string; id: AiModelId }>> };
}

const ATTEMPTS = 4;

export async function sha256File(path: string): Promise<string> {
  const h = createHash('sha256');
  for await (const chunk of createReadStream(path)) h.update(chunk as Buffer);
  return h.digest('hex');
}

/** tar.exe (bsdtar) есть в Windows 10 1803+; полный путь — чтобы не подхватить чужой tar из PATH */
export function systemExtract(zip: string, dir: string): Promise<void> {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  return new Promise((resolve, reject) => {
    execFile(tar, ['-xf', zip, '-C', dir], { windowsHide: true, timeout: 120_000 }, (err) => (err ? reject(new Error('Не удалось распаковать архив llama.cpp')) : resolve()));
  });
}

function russianNetError(err: unknown): string {
  const m = (err as Error)?.message ?? '';
  if (/abort/i.test(m)) return 'Скачивание остановлено';
  return 'Нет интернета или сервер не отвечает';
}

export class LocalInstaller {
  readonly dir: string;
  progress: DownloadProgress = { status: 'idle', file: null, received: 0, total: 0, error: null };
  private readonly files: NonNullable<InstallerDeps['files']>;

  constructor(
    dataDir: string,
    private readonly onProgress: (p: DownloadProgress) => void = () => undefined,
    private readonly deps: InstallerDeps = {},
  ) {
    this.dir = join(dataDir, 'ai');
    this.files = deps.files ?? { runtime: RUNTIME, models: ALL_MODELS };
  }

  get runtime() {
    return this.files.runtime;
  }

  model(id: AiModelId) {
    const m = this.files.models[id];
    if (!m) throw new Error(`Неизвестная модель ${id}`);
    return m;
  }

  serverExe(): string {
    return join(this.dir, this.files.runtime.dir, this.files.runtime.exe);
  }

  modelPath(id: AiModelId): string {
    return join(this.dir, this.model(id).fileName);
  }

  runtimeInstalled(): boolean {
    return existsSync(this.serverExe()) && this.verifiedMark(join(this.dir, this.files.runtime.dir), this.files.runtime);
  }

  modelInstalled(id: AiModelId): boolean {
    const m = this.files.models[id];
    if (!m) return false;
    const p = join(this.dir, m.fileName);
    return existsSync(p) && this.verifiedMark(p, m);
  }

  /** Отметка «проверено» рядом с файлом: хэш не пересчитываем при каждом запуске */
  private verifiedMark(path: string, f: PinnedFile): boolean {
    try {
      return readFileSync(`${path}.sha256`, 'utf8').trim() === f.sha256;
    } catch {
      return false;
    }
  }

  private set(p: Partial<DownloadProgress>): void {
    this.progress = { ...this.progress, ...p };
    this.onProgress(this.progress);
  }

  /** Скачивает недостающее: сборку llama.cpp и выбранную модель */
  async install(model: AiModelId, signal: AbortSignal): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    try {
      if (!this.runtimeInstalled()) {
        const zip = await this.fetchVerified(this.files.runtime, signal);
        this.set({ status: 'extracting' });
        const target = join(this.dir, this.files.runtime.dir);
        rmSync(target, { recursive: true, force: true });
        mkdirSync(target, { recursive: true });
        await (this.deps.extract ?? systemExtract)(zip, target);
        if (!existsSync(this.serverExe())) throw new Error('В архиве llama.cpp нет llama-server.exe');
        writeFileSync(`${target}.sha256`, this.files.runtime.sha256);
        rmSync(zip, { force: true });
      }
      if (!this.modelInstalled(model)) {
        const f = this.model(model);
        const path = await this.fetchVerified(f, signal);
        writeFileSync(`${path}.sha256`, f.sha256);
      }
      this.set({ status: 'done', file: null, error: null });
    } catch (err) {
      const message = signal.aborted ? 'Скачивание остановлено — нажмите ещё раз, чтобы докачать' : (err as Error).message;
      this.set({ status: 'error', error: message });
      throw new Error(message);
    }
  }

  /** Скачивает файл с докачкой и повторами; возвращает путь к проверенному файлу */
  private async fetchVerified(f: PinnedFile, signal: AbortSignal): Promise<string> {
    const final = join(this.dir, f.fileName);
    const part = `${final}.part`;
    let lastErr = '';
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      if (signal.aborted) throw new Error('Скачивание остановлено');
      try {
        await this.download(f, part, signal);
        this.set({ status: 'verifying' });
        const hash = await sha256File(part);
        if (hash !== f.sha256) {
          rmSync(part, { force: true });
          throw new Error(`Файл ${f.fileName} повреждён (SHA-256 не совпал) — скачаем заново`);
        }
        renameSync(part, final);
        return final;
      } catch (err) {
        if (signal.aborted) throw new Error('Скачивание остановлено');
        lastErr = (err as Error).message;
        if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, (this.deps.retryDelayMs ?? 2000) * attempt));
      }
    }
    throw new Error(lastErr || 'Не удалось скачать');
  }

  private async download(f: PinnedFile, part: string, signal: AbortSignal): Promise<void> {
    let have = existsSync(part) ? statSync(part).size : 0;
    if (have > f.sizeBytes) {
      rmSync(part, { force: true });
      have = 0;
    }
    this.set({ status: 'downloading', file: f.fileName, received: have, total: f.sizeBytes, error: null });
    if (have === f.sizeBytes) return;
    let res: Response;
    try {
      res = await (this.deps.fetchImpl ?? fetch)(f.url, { headers: have ? { range: `bytes=${have}-` } : {}, signal, redirect: 'follow' });
    } catch (err) {
      throw new Error(russianNetError(err));
    }
    if (res.status === 200 && have) have = 0; // сервер не умеет докачку — начинаем сначала
    else if (!res.ok) throw new Error(`Сервер ответил кодом ${res.status} на ${f.fileName}`);
    if (!res.body) throw new Error('Пустой ответ сервера');
    const out = createWriteStream(part, { flags: have ? 'a' : 'w' });
    const reader = res.body.getReader();
    let received = have;
    let lastEmit = 0;
    try {
      for (;;) {
        let r: ReadableStreamReadResult<Uint8Array>;
        try {
          r = await reader.read();
        } catch (err) {
          throw new Error(russianNetError(err));
        }
        if (r.done) break;
        received += r.value.byteLength;
        if (received > f.sizeBytes) throw new Error(`Файл ${f.fileName} больше ожидаемого`);
        if (!out.write(r.value)) await once(out, 'drain');
        if (Date.now() - lastEmit > 250) {
          lastEmit = Date.now();
          this.set({ received });
        }
      }
    } finally {
      out.end();
      await once(out, 'close').catch(() => undefined);
      reader.cancel().catch(() => undefined);
    }
    this.set({ received });
    if (received !== f.sizeBytes) throw new Error('Связь оборвалась — докачаем');
  }

  /** «Удалить»: модели и сборку llama.cpp (вызывающий сначала останавливает llama-server) */
  removeAll(): void {
    rmSync(this.dir, { recursive: true, force: true });
    this.set({ status: 'idle', file: null, received: 0, total: 0, error: null });
  }
}
