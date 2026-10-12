// Режим экрана Доты (только чтение): полноэкранный, без рамки или оконный. Перенесено из 0.6.0 (out/main/dota-video.js).
// Берём настройки из video.txt, который Dota сама пишет в папку игры. Ничего не записываем
// ни в Steam, ни в Доту. Модуль никогда не выбрасывает исключение: при любой проблеме mode = "unknown".
import { execFile } from 'node:child_process';
import { readFile as fsReadFile, readdir, stat } from 'node:fs/promises';
import { win32 } from 'node:path';
import type { DotaVideoMode } from '@shared/ipc';

// Старое место (в папке игры) — так было в 0.6.0 команды
const VIDEO_REL = ['steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg', 'video.txt'];
// Новая Дота хранит настройки у аккаунта Steam: <Steam>\userdata\<id>\570\local\cfg\video.txt (проверено 2026-10-12)
const USER_VIDEO_REL = ['570', 'local', 'cfg', 'video.txt'];

export interface DotaVideo {
  mode: DotaVideoMode;
  raw: { fullscreen?: string | null; nowindowborder?: string | null };
  file: string | null;
}

function unescapeVdf(s: string): string {
  return s.replace(/\\(.)/g, '$1');
}

/** Разбирает KeyValues-строки вида "key"  "value" в объект (ключи в нижнем регистре) */
export function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  const pair = /"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/g;
  for (const m of String(text).matchAll(pair)) {
    out[unescapeVdf(m[1]!).toLowerCase()] = unescapeVdf(m[2]!);
  }
  return out;
}

/** Пути всех библиотек Steam: основная папка Steam и все "path" из libraryfolders.vdf */
export function libraryPaths(steamPath: string, vdfText: string): string[] {
  const paths = [steamPath];
  for (const m of String(vdfText).matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const p = unescapeVdf(m[1]!);
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

/** Путь Steam из реестра (HKCU), только чтение. Возвращает null, если не найден. */
export function querySteamPath(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'], { windowsHide: true, timeout: 5e3 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /SteamPath\s+REG_\w+\s+(.+?)\s*$/m.exec(String(stdout));
        resolve(m ? m[1]!.trim() : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Номер активного аккаунта Steam из реестра (HKCU, только чтение); null — Steam не запущен или не найден */
export function queryActiveSteamUser(): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile('reg', ['query', 'HKCU\\Software\\Valve\\Steam\\ActiveProcess', '/v', 'ActiveUser'], { windowsHide: true, timeout: 5e3 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /ActiveUser\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(String(stdout));
        const id = m ? parseInt(m[1]!, 16) : 0;
        resolve(id > 0 ? String(id) : null);
      });
    } catch {
      resolve(null);
    }
  });
}

/** Папки аккаунтов в <Steam>\userdata, самые свежие video.txt — первыми */
async function listUserVideoFiles(steamPath: string): Promise<string[]> {
  const dir = win32.join(steamPath, 'userdata');
  const found: { file: string; at: number }[] = [];
  for (const id of await readdir(dir).catch(() => [] as string[])) {
    if (!/^\d+$/.test(id)) continue;
    const file = win32.join(dir, id, ...USER_VIDEO_REL);
    const s = await stat(file).catch(() => null);
    if (s?.isFile()) found.push({ file, at: s.mtimeMs });
  }
  return found.sort((a, b) => b.at - a.at).map((f) => f.file);
}

function readText(file: string): Promise<string> {
  return fsReadFile(file, 'utf8');
}

/** Сопоставление настроек video.txt с режимом */
export function modeFromVideo(fullscreen: string | null | undefined, nowindowborder: string | null | undefined): DotaVideoMode {
  if (nowindowborder === '1') return 'borderless';
  if (fullscreen === '1') return 'exclusive';
  if (fullscreen === '0' && nowindowborder === '0') return 'windowed';
  return 'unknown';
}

export interface DetectDeps {
  steamPath?: string | null;
  activeUser?: string | null;
  read?: (file: string) => Promise<string>;
  /** video.txt всех аккаунтов, самые свежие первыми */
  userFiles?: (steamPath: string) => Promise<string[]>;
}

/**
 * Определяет режим экрана Доты. Порядок поиска video.txt:
 * активный аккаунт Steam → самый свежий из остальных аккаунтов → старое место в папке игры (все библиотеки).
 * deps — для тестов.
 */
export async function detectDotaVideo(deps: DetectDeps = {}): Promise<DotaVideo> {
  const unknown = (file: string | null = null, raw: DotaVideo['raw'] = {}): DotaVideo => ({ mode: 'unknown', raw, file });
  try {
    const steamPath = 'steamPath' in deps ? deps.steamPath : await querySteamPath();
    if (!steamPath) return unknown();
    const read = deps.read ?? readText;
    const activeUser = 'activeUser' in deps ? deps.activeUser : await queryActiveSteamUser();
    const userFiles = await (deps.userFiles ?? listUserVideoFiles)(steamPath).catch(() => [] as string[]);
    const candidates: string[] = [];
    if (activeUser) candidates.push(win32.join(steamPath, 'userdata', activeUser, ...USER_VIDEO_REL));
    candidates.push(...userFiles);
    let vdf = '';
    try {
      vdf = await read(win32.join(steamPath, 'steamapps', 'libraryfolders.vdf'));
    } catch {
      // Без файла библиотек ищем только в основной папке Steam
    }
    for (const lib of libraryPaths(steamPath, vdf)) candidates.push(win32.join(lib, ...VIDEO_REL));
    for (const file of [...new Set(candidates)]) {
      let text: string;
      try {
        text = await read(file);
      } catch {
        continue;
      }
      const kv = parseKeyValues(text);
      const raw = {
        fullscreen: kv['setting.fullscreen'] ?? null,
        nowindowborder: kv['setting.nowindowborder'] ?? null,
      };
      return { mode: modeFromVideo(raw.fullscreen, raw.nowindowborder), raw, file };
    }
    return unknown();
  } catch {
    return unknown();
  }
}
