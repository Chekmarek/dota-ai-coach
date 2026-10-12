import { app } from 'electron';
import { mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Distribution = 'dev' | 'installed' | 'portable';

/**
 * Определяет, где хранить данные пользователя.
 * - dev: стандартная папка userData;
 * - установленная версия (рядом с exe лежит деинсталлятор NSIS): %APPDATA%\Dota AI Coach;
 * - портативная (распакована из zip): папка data рядом с exe — всё своё носит с собой.
 * Переменная DOTACOACH_DATA_DIR переопределяет путь (нужно для изолированных тестов).
 */
export function resolveDataDir(): { dataDir: string; distribution: Distribution } {
  const override = process.env.DOTACOACH_DATA_DIR;
  const distribution = detectDistribution();
  let dataDir: string;
  if (override) dataDir = override;
  else if (distribution === 'portable') dataDir = join(dirname(app.getPath('exe')), 'data');
  else dataDir = app.getPath('userData');
  mkdirSync(dataDir, { recursive: true });
  return { dataDir, distribution };
}

function detectDistribution(): Distribution {
  if (!app.isPackaged) return 'dev';
  const exeDir = dirname(app.getPath('exe'));
  try {
    const hasUninstaller = readdirSync(exeDir).some((f) => /^Uninstall .*\.exe$/i.test(f));
    return hasUninstaller ? 'installed' : 'portable';
  } catch {
    return 'installed';
  }
}

export function resourcePath(...parts: string[]): string {
  const base = app.isPackaged ? process.resourcesPath : join(app.getAppPath(), 'resources');
  return join(base, ...parts);
}
