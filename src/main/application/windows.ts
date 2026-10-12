import { BrowserWindow, shell, type WebContents } from 'electron';
import { join } from 'node:path';
import { allowLivePermission } from '../live/live';

export const preloadDir = join(__dirname, '../preload');
const rendererDir = join(__dirname, '../renderer');

export type PageName = 'renderer' | 'engine' | 'overlay';

export function pageUrl(page: PageName): { url?: string; file?: string } {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) return { url: `${devServer}/${page}/index.html` };
  return { file: join(rendererDir, page, 'index.html') };
}

/** Общие правила безопасности для любого окна */
export function harden(contents: WebContents): void {
  // Никаких переходов внутри окна на чужие страницы
  contents.on('will-navigate', (event, url) => {
    const allowed = process.env.ELECTRON_RENDERER_URL;
    if (!(allowed && url.startsWith(allowed))) event.preventDefault();
  });
  // Новые окна запрещены; внешние https-ссылки — только в системном браузере
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  // Всё запрещено, кроме захвата видео окна Доты — и только окну движка (см. live.ts)
  contents.session.setPermissionRequestHandler((wc, permission, callback, details) =>
    callback(allowLivePermission(wc, permission, details as { mediaTypes?: unknown })),
  );
}

const secureWebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  spellcheck: false,
} as const;

export function createUiWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#0d1117',
    title: 'Dota AI Coach',
    show: false,
    autoHideMenuBar: true,
    webPreferences: { ...secureWebPreferences, preload: join(preloadDir, 'ui.cjs') },
  });
  harden(win.webContents);
  win.once('ready-to-show', () => win.show());
  const target = pageUrl('renderer');
  if (target.url) void win.loadURL(target.url);
  else void win.loadFile(target.file!);
  return win;
}

/** Скрытое окно движка: захват, зрение, (позже) голос. Интерфейса не имеет. */
export function createEngineWindow(): BrowserWindow {
  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      ...secureWebPreferences,
      preload: join(preloadDir, 'engine.cjs'),
      // Движок должен работать, даже когда окно скрыто
      backgroundThrottling: false,
    },
  });
  harden(win.webContents);
  const target = pageUrl('engine');
  if (target.url) void win.loadURL(target.url);
  else void win.loadFile(target.file!);
  return win;
}
