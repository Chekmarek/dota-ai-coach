// Подключение GSI в Dota 2: поиск папки игры и запись ОДНОГО своего файла
// <dota 2 beta>/game/dota/cfg/gamestate_integration/gamestate_integration_dotacoach.cfg.
// Файлы Steam и игры коуч не меняет; «Отключить» удаляет только свой файл.
// Без Electron — модуль проверяется unit-тестами во временной папке.
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const DOTA_APP_ID = '570';
export const GSI_CFG_NAME = 'gamestate_integration_dotacoach.cfg';
/** Параметр запуска Dota 2, без которого игра не читает файлы GSI */
export const GSI_LAUNCH_OPTION = '-gamestateintegration';
const DEFAULT_STEAM = 'C:\\Program Files (x86)\\Steam';
const DOTA_SUBDIR = ['steamapps', 'common', 'dota 2 beta'];
const CFG_SUBDIR = ['game', 'dota', 'cfg', 'gamestate_integration'];

// ---------- VDF (KeyValues Valve) ----------

export type VdfValue = string | VdfObject;
export interface VdfObject {
  [key: string]: VdfValue;
}

/** Разбор текстового VDF: строки в кавычках, вложенные { }, комментарии //. Ключи — без учёта регистра (в нижнем) */
export function parseVdf(text: string): VdfObject {
  let i = 0;
  const n = text.length;
  const skip = () => {
    for (;;) {
      while (i < n && /\s/.test(text[i]!)) i++;
      if (text.startsWith('//', i)) {
        while (i < n && text[i] !== '\n') i++;
        continue;
      }
      return;
    }
  };
  const token = (): string | '{' | '}' | null => {
    skip();
    if (i >= n) return null;
    const c = text[i]!;
    if (c === '{' || c === '}') {
      i++;
      return c;
    }
    if (c === '"') {
      i++;
      let s = '';
      while (i < n && text[i] !== '"') {
        if (text[i] === '\\' && i + 1 < n) {
          const e = text[i + 1]!;
          s += e === 'n' ? '\n' : e === 't' ? '\t' : e;
          i += 2;
        } else s += text[i++];
      }
      i++;
      return s;
    }
    let s = '';
    while (i < n && !/[\s{}"]/.test(text[i]!)) s += text[i++];
    return s;
  };
  const object = (): VdfObject => {
    const o: VdfObject = {};
    for (;;) {
      const k = token();
      if (k === null || k === '}') return o;
      if (k === '{') continue;
      const v = token();
      if (v === null) return o;
      o[k.toLowerCase()] = v === '{' ? object() : v === '}' ? '' : v;
      if (v === '}') return o;
    }
  };
  return object();
}

export interface SteamLibrary {
  path: string;
  /** id приложений в библиотеке; null — старый формат файла, список не указан */
  apps: string[] | null;
}

/** Библиотеки Steam из steamapps/libraryfolders.vdf (новый формат с apps и старый «"1" "D:\\Lib"») */
export function parseLibraryFolders(text: string): SteamLibrary[] {
  const root = parseVdf(text);
  const top = (root.libraryfolders ?? Object.values(root).find((v) => typeof v === 'object')) as VdfObject | undefined;
  if (!top || typeof top !== 'object') return [];
  const out: SteamLibrary[] = [];
  for (const [k, v] of Object.entries(top)) {
    if (!/^\d+$/.test(k)) continue;
    if (typeof v === 'string') out.push({ path: v, apps: null });
    else if (typeof v.path === 'string') out.push({ path: v.path, apps: typeof v.apps === 'object' ? Object.keys(v.apps) : null });
  }
  return out;
}

/** Ответ `reg query … /v SteamPath` → путь; null — значения нет */
export function parseRegSteamPath(stdout: string): string | null {
  const m = /SteamPath\s+REG_\w+\s+(.+)/i.exec(stdout);
  return m ? normalizeSteamPath(m[1]!) : null;
}

/** Вывод PowerShell (одна строка — значение SteamPath) → путь; null — пусто */
export function parsePowershellSteamPath(stdout: string): string | null {
  const line = stdout.replace(/^\uFEFF/, '').split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
  return line ? normalizeSteamPath(line) : null;
}

/**
 * Steam пишет путь с прямыми слешами («d:/игры/steam») — приводим к виду Windows.
 * «?» и «�» в пути Windows невозможны: это след потерянной кодировки (reg.exe выводит кириллицу как «????»).
 * Такой путь не возвращаем — лучше «не нашли», чем чужая папка.
 */
function normalizeSteamPath(p: string): string | null {
  const v = p.trim().replace(/\//g, '\\');
  return v.length > 0 && !/[?\uFFFD]/.test(v) ? v : null;
}

/** Ключ реестра Steam (HKCU) */
export const STEAM_REG_KEY = 'HKCU\\Software\\Valve\\Steam';

/** Команда PowerShell: печатает SteamPath в UTF-8, так что путь с кириллицей не искажается */
function psSteamPath(key: string): string {
  const psKey = key.replace(/^HKCU\\/i, 'HKCU:\\').replace(/'/g, "''");
  return `[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; (Get-ItemProperty -LiteralPath '${psKey}' -Name SteamPath -ErrorAction Stop).SteamPath`;
}

/**
 * Папка Steam из реестра (HKCU\Software\Valve\Steam, SteamPath); null — не Windows или ключа нет.
 * reg.exe пишет в кодировке консоли (не UTF-8), и путь вроде «D:\Игры\Steam» приходил искажённым — поэтому
 * сначала PowerShell с выводом в UTF-8, а reg.exe — запасной путь (латинские пути он отдаёт верно).
 */
export function steamPathFromRegistry(key: string = STEAM_REG_KEY): Promise<string | null> {
  if (process.platform !== 'win32') return Promise.resolve(null);
  const run = (file: string, args: string[]) =>
    new Promise<string | null>((resolve) => {
      // Первый запуск PowerShell на медленном или «холодном» компьютере бывает дольше 8 с
      execFile(file, args, { windowsHide: true, timeout: 20_000, encoding: 'utf8' }, (err, stdout) => resolve(err ? null : String(stdout)));
    });
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psSteamPath(key)]).then(async (out) => {
    const fromPs = out === null ? null : parsePowershellSteamPath(out);
    if (fromPs) return fromPs;
    const reg = await run('reg', ['query', key, '/v', 'SteamPath']);
    return reg === null ? null : parseRegSteamPath(reg);
  });
}

export interface DotaLocation {
  /** Папка «dota 2 beta»; null — не найдена */
  dotaDir: string | null;
  steamPath: string | null;
  /** Как нашли: reg / default / override */
  how: 'override' | 'library' | 'not-found';
  libraries: string[];
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/**
 * Ищет папку Dota 2: сначала библиотека, где по libraryfolders.vdf установлено приложение 570,
 * затем любая библиотека, где есть папка «dota 2 beta». steamPath = null — путь по умолчанию.
 */
export function locateDota(steamPath: string | null, override: string | null = null): DotaLocation {
  if (override) {
    const ok = isDir(override);
    return { dotaDir: ok ? override : null, steamPath, how: ok ? 'override' : 'not-found', libraries: [] };
  }
  const steam = steamPath ?? DEFAULT_STEAM;
  const libs: SteamLibrary[] = [];
  const vdf = join(steam, 'steamapps', 'libraryfolders.vdf');
  if (existsSync(vdf)) {
    try {
      libs.push(...parseLibraryFolders(readFileSync(vdf, 'utf8')));
    } catch {
      /* битый файл — ищем по папкам */
    }
  }
  if (!libs.some((l) => samePath(l.path, steam))) libs.unshift({ path: steam, apps: null });
  const ordered = [...libs.filter((l) => l.apps?.includes(DOTA_APP_ID)), ...libs.filter((l) => !l.apps?.includes(DOTA_APP_ID))];
  for (const lib of ordered) {
    const dir = join(lib.path, ...DOTA_SUBDIR);
    if (isDir(dir)) return { dotaDir: dir, steamPath: steam, how: 'library', libraries: libs.map((l) => l.path) };
  }
  return { dotaDir: null, steamPath: steam, how: 'not-found', libraries: libs.map((l) => l.path) };
}

const samePath = (a: string, b: string) => a.replace(/[\\/]+$/, '').toLowerCase() === b.replace(/[\\/]+$/, '').toLowerCase();

export function cfgDir(dotaDir: string): string {
  return join(dotaDir, ...CFG_SUBDIR);
}

export function cfgPath(dotaDir: string): string {
  return join(cfgDir(dotaDir), GSI_CFG_NAME);
}

/** Текст файла GSI для Dota: адрес приёмника, частоты отправки, секрет и нужные блоки данных */
export function gsiCfgText(port: number, token: string): string {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('Секрет GSI не создан');
  return [
    '"Dota AI Coach"',
    '{',
    `  "uri"           "http://127.0.0.1:${port}/"`,
    '  "timeout"       "5.0"',
    '  "buffer"        "0.1"',
    '  "throttle"      "0.1"',
    '  "heartbeat"     "30.0"',
    '  "data"',
    '  {',
    '    "provider"    "1"',
    '    "map"         "1"',
    '    "player"      "1"',
    '    "hero"        "1"',
    '    "abilities"   "1"',
    '    "items"       "1"',
    '    "buildings"   "1"',
    '    "events"      "1"',
    '  }',
    '  "auth"',
    '  {',
    `    "token"       "${token}"`,
    '  }',
    '}',
    '',
  ].join('\r\n');
}

/** Файл установлен и совпадает с текущими портом и секретом? */
export function cfgStatus(dotaDir: string, port: number, token: string): { installed: boolean; current: boolean; path: string } {
  const path = cfgPath(dotaDir);
  if (!existsSync(path)) return { installed: false, current: false, path };
  let current = false;
  try {
    current = token !== '' && readFileSync(path, 'utf8') === gsiCfgText(port, token);
  } catch {
    current = false;
  }
  return { installed: true, current, path };
}

/** «Подключить»: пишет только свой файл (атомарно, через временный) */
export function installCfg(dotaDir: string, port: number, token: string): string {
  if (!isDir(dotaDir)) throw new Error(`Папка Dota 2 не найдена: ${dotaDir}`);
  const dir = cfgDir(dotaDir);
  mkdirSync(dir, { recursive: true });
  const path = cfgPath(dotaDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, gsiCfgText(port, token), 'utf8');
  renameSync(tmp, path);
  return path;
}

/**
 * Проверка при запуске: свой файл есть, но отличается от того, что коуч записал бы сейчас (порт, секрет или
 * формат — например, набор блоков data в новой версии), — переписываем. Файла нет — НЕ создаём:
 * подключение остаётся решением пользователя. Другие файлы в папке не трогаются.
 * rewritten — файл обновлён (Dota подхватит его только после перезапуска).
 */
export function refreshCfg(dotaDir: string, port: number, token: string): 'rewritten' | 'current' | 'absent' {
  const st = cfgStatus(dotaDir, port, token);
  if (!st.installed) return 'absent';
  if (st.current) return 'current';
  installCfg(dotaDir, port, token);
  return 'rewritten';
}

/** «Отключить»: удаляет только свой файл (папку gamestate_integration не трогаем — там могут быть чужие файлы) */
export function removeCfg(dotaDir: string): boolean {
  const path = cfgPath(dotaDir);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}
