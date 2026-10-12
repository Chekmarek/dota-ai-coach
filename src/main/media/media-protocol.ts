import { protocol } from 'electron';
import { createReadStream, statSync } from 'node:fs';
import { extname } from 'node:path';
import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';

/**
 * Схема dcmedia:// — единственный способ для окон прочитать файл с диска.
 * Окна не видят путей: main регистрирует выбранные пользователем файлы и выдаёт
 * URL вида dcmedia://media/<id>/<номер>. Любой другой URL → 404.
 */
export const MEDIA_SCHEME = 'dcmedia';

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.bmp': 'image/bmp',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.bmp', '.webp'];
export const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mkv'];

const registry = new Map<string, string[]>();
const MAX_SOURCES = 8;

/** Вызывается до app.ready */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
    },
  ]);
}

export function registerSource(files: string[]): { id: string; urls: string[] } {
  const id = randomUUID().replace(/-/g, '');
  registry.set(id, files);
  // Храним только последние источники — старые URL перестают работать
  while (registry.size > MAX_SOURCES) {
    const oldest = registry.keys().next().value;
    if (oldest === undefined) break;
    registry.delete(oldest);
  }
  return { id, urls: files.map((_, i) => `${MEDIA_SCHEME}://media/${id}/${i}`) };
}

export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const url = new URL(request.url);
    const [, id, indexStr] = url.pathname.split('/');
    const files = id ? registry.get(id) : undefined;
    const index = Number(indexStr);
    const file = files && Number.isInteger(index) ? files[index] : undefined;
    if (url.host !== 'media' || !file) return new Response('Not found', { status: 404 });

    let size: number;
    try {
      size = statSync(file).size;
    } catch {
      return new Response('Gone', { status: 410 });
    }
    const headers: Record<string, string> = {
      'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    };

    // Поддержка Range — нужна видео для перемотки и потокового чтения
    const range = request.headers.get('range');
    const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
    if (m && size > 0) {
      let start = m[1] ? Number(m[1]) : NaN;
      let end = m[2] ? Number(m[2]) : size - 1;
      if (Number.isNaN(start)) {
        start = Math.max(0, size - end);
        end = size - 1;
      }
      end = Math.min(end, size - 1);
      if (start > end || start >= size) {
        return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` } });
      }
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream;
      return new Response(stream, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
      });
    }
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream;
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } });
  });
}
