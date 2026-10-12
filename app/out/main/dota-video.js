// Режим экрана Доты (только чтение): полноэкранный, без рамки или оконный.
// Берём настройки из video.txt, который Dota сама пишет в папку игры. Ничего не записываем
// ни в Steam, ни в Доту. Модуль никогда не выбрасывает исключение: при любой проблеме mode = "unknown".
import { execFile } from "node:child_process";
import { readFile as fsReadFile } from "node:fs";
import { win32 } from "node:path";

const VIDEO_REL = ["steamapps", "common", "dota 2 beta", "game", "dota", "cfg", "video.txt"];

/** Разбирает KeyValues-строки вида "key"  "value" в объект (ключи в нижнем регистре) */
export function parseKeyValues(text) {
  const out = {};
  const pair = /"((?:[^"\\]|\\.)*)"\s+"((?:[^"\\]|\\.)*)"/g;
  for (const m of String(text).matchAll(pair)) {
    out[unescapeVdf(m[1]).toLowerCase()] = unescapeVdf(m[2]);
  }
  return out;
}

function unescapeVdf(s) {
  return s.replace(/\\(.)/g, "$1");
}

/** Пути всех библиотек Steam: основная папка Steam и все "path" из libraryfolders.vdf */
export function libraryPaths(steamPath, vdfText) {
  const paths = [steamPath];
  for (const m of String(vdfText).matchAll(/"path"\s+"((?:[^"\\]|\\.)*)"/gi)) {
    const p = unescapeVdf(m[1]);
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

/** Путь Steam из реестра (HKCU), только чтение. Возвращает null, если не найден. */
export function querySteamPath() {
  return new Promise((resolve) => {
    try {
      execFile("reg", ["query", "HKCU\\Software\\Valve\\Steam", "/v", "SteamPath"], { windowsHide: true, timeout: 5e3 }, (err, stdout) => {
        if (err) return resolve(null);
        const m = /SteamPath\s+REG_\w+\s+(.+?)\s*$/m.exec(String(stdout));
        resolve(m ? m[1].trim() : null);
      });
    } catch {
      resolve(null);
    }
  });
}

function readText(file) {
  return new Promise((resolve, reject) => {
    fsReadFile(file, "utf8", (err, data) => (err ? reject(err) : resolve(data)));
  });
}

/** Сопоставление настроек video.txt с режимом (см. docs/PORTING.md, раздел 0.6.0) */
export function modeFromVideo(fullscreen, nowindowborder) {
  if (nowindowborder === "1") return "borderless";
  if (fullscreen === "1") return "exclusive";
  if (fullscreen === "0" && nowindowborder === "0") return "windowed";
  return "unknown";
}

/**
 * Определяет режим экрана Доты.
 * deps (для тестов): { steamPath, read } — read(file) -> текст файла.
 * Возвращает { mode: "exclusive" | "borderless" | "windowed" | "unknown", raw, file }.
 */
export async function detectDotaVideo(deps = {}) {
  const unknown = (file = null, raw = {}) => ({ mode: "unknown", raw, file });
  try {
    const steamPath = "steamPath" in deps ? deps.steamPath : await querySteamPath();
    if (!steamPath) return unknown();
    const read = deps.read ?? readText;
    let vdf = "";
    try {
      vdf = await read(win32.join(steamPath, "steamapps", "libraryfolders.vdf"));
    } catch {
      // Без файла библиотек ищем только в основной папке Steam
    }
    for (const lib of libraryPaths(steamPath, vdf)) {
      const file = win32.join(lib, ...VIDEO_REL);
      let text;
      try {
        text = await read(file);
      } catch {
        continue;
      }
      const kv = parseKeyValues(text);
      const raw = {
        fullscreen: kv["setting.fullscreen"] ?? null,
        nowindowborder: kv["setting.nowindowborder"] ?? null
      };
      return { mode: modeFromVideo(raw.fullscreen, raw.nowindowborder), raw, file };
    }
    return unknown();
  } catch {
    return unknown();
  }
}
