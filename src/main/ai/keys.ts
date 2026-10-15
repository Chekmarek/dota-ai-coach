// Ключи облачного ИИ: только в main, зашифрованы Electron safeStorage (DPAPI Windows), файл <данные>/ai/keys.json.
// Никогда не попадают в settings.json, в интерфейс и в журнал. Шифровальщик передаётся снаружи — модуль без Electron.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type KeyProvider = 'openai-compatible' | 'gigachat';

export interface Encryptor {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(data: Buffer): string;
}

export class KeyStore {
  private readonly file: string;

  constructor(
    private readonly dir: string,
    private readonly crypto: Encryptor,
  ) {
    this.file = join(dir, 'keys.json');
  }

  private read(): Partial<Record<KeyProvider, string>> {
    if (!existsSync(this.file)) return {};
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const out: Partial<Record<KeyProvider, string>> = {};
      for (const k of ['openai-compatible', 'gigachat'] as const) if (typeof raw[k] === 'string') out[k] = raw[k];
      return out;
    } catch {
      return {};
    }
  }

  private write(data: Partial<Record<KeyProvider, string>>): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(data), 'utf8');
    renameSync(tmp, this.file);
  }

  has(p: KeyProvider): boolean {
    return typeof this.read()[p] === 'string';
  }

  /** Сохраняет ключ; без шифрования Windows — отказ (открытым текстом не храним) */
  set(p: KeyProvider, key: string): void {
    if (!this.crypto.isEncryptionAvailable()) throw new Error('Шифрование Windows недоступно — ключ не сохранён');
    const data = this.read();
    data[p] = this.crypto.encryptString(key).toString('base64');
    this.write(data);
  }

  /** Ключ для запроса; null — нет или не расшифровать (например, папку данных перенесли на другой ПК) */
  get(p: KeyProvider): string | null {
    const enc = this.read()[p];
    if (!enc || !this.crypto.isEncryptionAvailable()) return null;
    try {
      return this.crypto.decryptString(Buffer.from(enc, 'base64'));
    } catch {
      return null;
    }
  }

  clear(p: KeyProvider): void {
    const data = this.read();
    delete data[p];
    this.write(data);
  }
}
