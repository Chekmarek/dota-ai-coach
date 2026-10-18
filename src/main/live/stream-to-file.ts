// Запись потока скачивания в файл с обработкой ошибок диска (нет места, файл занят, на месте файла папка).
// Без обработчика 'error' такая ошибка роняла процесс или скачивание ждало drain/close вечно («Скачивается…»).
// Без Electron — проверяется unit-тестом.
import fs from 'node:fs';
import { once } from 'node:events';

export function diskWriteMessage(err: NodeJS.ErrnoException): string {
  if (err.code === 'ENOSPC') return 'не хватает места на диске';
  return `не удалось записать файл на диск (${err.code ?? 'ошибка записи'})`;
}

/** Пишет поток в файл; onChunk — для каждого куска до записи (хеш, прогресс). Ошибка диска — Error с русским текстом */
export async function streamToFile(body: ReadableStream<Uint8Array>, file: string, onChunk: (chunk: Uint8Array) => void = () => undefined): Promise<void> {
  const out = fs.createWriteStream(file);
  let writeErr: NodeJS.ErrnoException | null = null;
  out.on('error', (err) => (writeErr ??= err));
  const reader = body.getReader();
  try {
    for (;;) {
      if (writeErr || out.destroyed) break;
      const { value, done } = await reader.read();
      if (done) break;
      onChunk(value);
      if (!out.write(Buffer.from(value))) await Promise.race([once(out, 'drain'), once(out, 'close')]).catch(() => undefined);
    }
  } finally {
    if (!out.destroyed) out.end();
    if (!out.closed) await once(out, 'close').catch(() => undefined);
    if (writeErr) reader.cancel().catch(() => undefined);
  }
  if (writeErr) throw new Error(diskWriteMessage(writeErr));
}
