// Чтение архивов Dota 2 (VPK версии 2) — только чтение, только для скриптов разработчика.
// Сам коуч файлы игры не читает: доступ к игре у него — картинка экрана и GSI.
// Формат: заголовок 28 байт, дерево «расширение → папка → имя → запись», данные — в pak01_NNN.vpk
// (или в самом _dir.vpk, если индекс архива 0x7fff).
import { closeSync, openSync, readFileSync, readSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Каталог архива: путь → где лежат данные */
export function readVpkDir(dirFile) {
  const buf = readFileSync(dirFile);
  if (buf.readUInt32LE(0) !== 0x55aa1234) throw new Error('не VPK');
  const version = buf.readUInt32LE(4);
  if (version !== 2) throw new Error(`VPK версии ${version} не поддерживается`);
  const treeSize = buf.readUInt32LE(8);
  const header = 28;
  let p = header;
  const str = () => {
    const end = buf.indexOf(0, p);
    const s = buf.toString('utf8', p, end);
    p = end + 1;
    return s;
  };
  const entries = new Map();
  for (;;) {
    const ext = str();
    if (!ext) break;
    for (;;) {
      const path = str();
      if (!path) break;
      for (;;) {
        const name = str();
        if (!name) break;
        const preload = buf.readUInt16LE(p + 4);
        const archive = buf.readUInt16LE(p + 6);
        const offset = buf.readUInt32LE(p + 8);
        const length = buf.readUInt32LE(p + 12);
        p += 18;
        const preloadData = preload ? buf.subarray(p, p + preload) : null;
        p += preload;
        const full = `${path === ' ' ? '' : `${path}/`}${name}.${ext}`;
        entries.set(full, { archive, offset, length, preloadData });
      }
    }
  }
  return { dirFile, entries, dataStart: header + treeSize };
}

/** Содержимое файла из архива */
export function readVpkFile(vpk, path) {
  const e = vpk.entries.get(path);
  if (!e) throw new Error(`нет в архиве: ${path}`);
  const parts = [];
  if (e.preloadData) parts.push(e.preloadData);
  if (e.length > 0) {
    const file = e.archive === 0x7fff ? vpk.dirFile : join(dirname(vpk.dirFile), vpk.dirFile.replace(/^.*[\\/]/, '').replace('_dir.vpk', `_${String(e.archive).padStart(3, '0')}.vpk`));
    const start = e.archive === 0x7fff ? vpk.dataStart + e.offset : e.offset;
    const fd = openSync(file, 'r');
    try {
      const b = Buffer.alloc(e.length);
      readSync(fd, b, 0, e.length, start);
      parts.push(b);
    } finally {
      closeSync(fd);
    }
  }
  return Buffer.concat(parts);
}
