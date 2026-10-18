// Запись скачивания на диск (обновление): ошибка диска — понятная ошибка, а не зависание; обычная запись — байт в байт.
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { streamToFile } from '../../src/main/live/stream-to-file';

const body = (parts: Uint8Array[]) => new ReadableStream<Uint8Array>({ pull(c) { const p = parts.shift(); if (p) c.enqueue(p); else c.close(); } });

describe('запись скачивания на диск', () => {
  it('обычная запись: все куски по порядку, onChunk видит каждый', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-stf-'));
    const parts = Array.from({ length: 40 }, (_, i) => new Uint8Array(64 * 1024).fill(i));
    let seen = 0;
    await streamToFile(body([...parts]), join(dir, 'a.bin'), (c) => (seen += c.length));
    const got = readFileSync(join(dir, 'a.bin'));
    expect(got.length).toBe(40 * 64 * 1024);
    expect(seen).toBe(got.length);
    expect(got[64 * 1024 * 39]).toBe(39);
  });

  it('на месте файла папка — ошибка по-русски за разумное время, а не вечное ожидание', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-stf-'));
    mkdirSync(join(dir, 'app.asar.download'));
    const parts = Array.from({ length: 40 }, () => new Uint8Array(64 * 1024));
    const hang = new Promise<string>((r) => setTimeout(() => r('завис'), 5000));
    const res = await Promise.race([streamToFile(body(parts), join(dir, 'app.asar.download')).then(() => 'записано', (e: Error) => e.message), hang]);
    expect(res).toMatch(/^не удалось записать файл на диск \(E[A-Z]+\)$/);
  });
});
