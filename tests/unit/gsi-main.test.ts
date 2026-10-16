import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, existsSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GSI_MAX_BODY, GsiServer, sameToken } from '../../src/main/gsi/server';
import { GSI_CFG_NAME, cfgPath, cfgStatus, gsiCfgText, installCfg, locateDota, parseLibraryFolders, parsePowershellSteamPath, parseRegSteamPath, parseVdf, refreshCfg, removeCfg, steamPathFromRegistry } from '../../src/main/gsi/setup';
import { execFileSync } from 'node:child_process';
import { SerialRestarter } from '../../src/main/gsi/restart';
import { KEEP_FILES, MAX_TOTAL_BYTES, SessionRecorder, sanitizeGsiBody } from '../../src/main/gsi/recorder';
import { parseSession, readCoachSettings, replaySession } from '../../scripts/gsi-replay.mjs';
import { applyInternalGsi, defaultSettings, settingsPatchSchema, settingsSchema } from '../../src/shared/schemas/settings';

const TOKEN = 'a'.repeat(64);
const FIX = join(import.meta.dirname, '../fixtures/gsi');
const tmp = () => mkdtempSync(join(tmpdir(), 'dotacoach-gsi-'));

function post(port: number, body: string, opts: { method?: string; headers?: Record<string, string> } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path: '/', method: opts.method ?? 'POST', headers: { 'content-type': 'application/json', ...opts.headers } }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode ?? 0));
    });
    req.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ECONNRESET' || e.code === 'EPIPE' ? resolve(413) : reject(e)));
    if (body) req.write(body);
    req.end();
  });
}

const servers: GsiServer[] = [];
async function server(onBody: (b: Record<string, unknown>) => void = () => undefined, log: string[] = []) {
  const s = new GsiServer({ port: 0, token: TOKEN, onBody, log: (l) => log.push(l) });
  servers.push(s);
  expect(await s.start()).toBe('listening');
  return { s, port: s.boundPort!, log };
}
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

const laning = () => JSON.parse(readFileSync(join(FIX, 'laning.json'), 'utf8')) as Record<string, any>;
const withToken = (b: Record<string, any>, token = TOKEN) => JSON.stringify({ ...b, auth: { token } });

describe('приёмник GSI', () => {
  it('слушает только 127.0.0.1', async () => {
    const { s } = await server();
    expect(s.boundHost).toBe('127.0.0.1');
  });

  it('верный токен — 200 и тело уходит дальше; неверный или пустой — 401, тело не передаётся', async () => {
    const got: Record<string, unknown>[] = [];
    const { s, port, log } = await server((b) => got.push(b));
    expect(await post(port, withToken(laning()))).toBe(200);
    expect(await post(port, withToken(laning(), 'b'.repeat(64)))).toBe(401);
    expect(await post(port, withToken(laning(), ''))).toBe(401);
    expect(await post(port, JSON.stringify(laning()))).toBe(401); // без auth
    expect(got).toHaveLength(1);
    expect((got[0] as any).hero.name).toBe('npc_dota_hero_nevermore');
    expect(s.status).toMatchObject({ accepted: 1, rejected: 3 });
    // В журнале — причина, но не содержимое запроса
    expect(log.join('\n')).toContain('401');
    expect(log.join('\n')).not.toContain('nevermore');
    expect(log.join('\n')).not.toContain(TOKEN);
  });

  it('только POST', async () => {
    const { port } = await server();
    expect(await post(port, '', { method: 'GET' })).toBe(405);
    expect(await post(port, withToken(laning()), { method: 'PUT' })).toBe(405);
  });

  it('тело больше 256 КБ — 413', async () => {
    const got: unknown[] = [];
    const { port } = await server((b) => got.push(b));
    const big = withToken({ ...laning(), pad: 'x'.repeat(GSI_MAX_BODY) });
    expect(await post(port, big)).toBe(413);
    // Без content-length (chunked) — тоже отсекается по факту
    expect(await post(port, big, { headers: { 'transfer-encoding': 'chunked' } })).toBe(413);
    expect(got).toHaveLength(0);
  });

  it('мусор — 400; запросы со страниц браузера (Origin) — 403', async () => {
    const { port } = await server();
    expect(await post(port, 'не json')).toBe(400);
    expect(await post(port, '[1,2]')).toBe(400);
    expect(await post(port, withToken(laning()), { headers: { origin: 'https://example.com' } })).toBe(403);
  });

  it('занятый порт — состояние «порт занят», другой порт не выбирается', async () => {
    const { port } = await server();
    const second = new GsiServer({ port, token: TOKEN, onBody: () => undefined });
    servers.push(second);
    expect(await second.start()).toBe('port-busy');
    expect(second.status).toMatchObject({ state: 'port-busy', port });
    expect(second.boundPort).toBeNull();
  });

  it('сравнение токена', () => {
    expect(sameToken(TOKEN, TOKEN)).toBe(true);
    expect(sameToken(TOKEN, TOKEN.slice(1))).toBe(false);
    expect(sameToken('', '')).toBe(false);
  });
});

describe('настройка Dota (во временной папке)', () => {
  const NEW_VDF = `"libraryfolders"
{
	"0"
	{
		"path"		"C:\\\\Program Files (x86)\\\\Steam"
		"label"		""
		"apps"
		{
			"228980"		"0"
			"431960"		"123"
		}
	}
	"1"
	{
		"path"		"D:\\\\SteamLibrary"
		"apps"
		{
			"570"		"40000000000"
		}
	}
	// комментарий
	"2" { "path" "E:\\\\Games\\\\Steam" "apps" { } }
}`;

  it('VDF: несколько библиотек, где установлено приложение 570', () => {
    const libs = parseLibraryFolders(NEW_VDF);
    expect(libs).toEqual([
      { path: 'C:\\Program Files (x86)\\Steam', apps: ['228980', '431960'] },
      { path: 'D:\\SteamLibrary', apps: ['570'] },
      { path: 'E:\\Games\\Steam', apps: [] },
    ]);
  });

  it('VDF: старый формат «"1" "путь"»', () => {
    const libs = parseLibraryFolders(`"LibraryFolders"\n{\n "TimeNextStatsReport" "1690000000"\n "ContentStatsID" "-123"\n "1" "D:\\\\SteamLibrary"\n}`);
    expect(libs).toEqual([{ path: 'D:\\SteamLibrary', apps: null }]);
    expect(parseVdf('"a" { "b" "c" }')).toEqual({ a: { b: 'c' } });
  });

  it('находит Dota в библиотеке с приложением 570; без папки — «не найдена»', () => {
    const root = tmp();
    const steam = join(root, 'Steam');
    const lib2 = join(root, 'Lib2');
    mkdirSync(join(steam, 'steamapps'), { recursive: true });
    const vdf = `"libraryfolders" { "0" { "path" "${steam.replace(/\\/g, '\\\\')}" "apps" { "1" "0" } } "1" { "path" "${lib2.replace(/\\/g, '\\\\')}" "apps" { "570" "1" } } }`;
    writeFileSync(join(steam, 'steamapps', 'libraryfolders.vdf'), vdf);
    expect(locateDota(steam).dotaDir).toBeNull();
    const dota = join(lib2, 'steamapps', 'common', 'dota 2 beta');
    mkdirSync(dota, { recursive: true });
    expect(locateDota(steam)).toMatchObject({ dotaDir: dota, how: 'library' });
    expect(locateDota(steam, dota)).toMatchObject({ dotaDir: dota, how: 'override' });
    expect(locateDota(steam, join(root, 'нет такой'))).toMatchObject({ dotaDir: null, how: 'not-found' });
  });

  it('«Подключить» пишет только свой файл с нужными полями, «Отключить» удаляет только его', () => {
    const dota = join(tmp(), 'dota 2 beta');
    const dir = join(dota, 'game', 'dota', 'cfg', 'gamestate_integration');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gamestate_integration_other.cfg'), 'чужой файл');
    const path = installCfg(dota, 53790, TOKEN);
    expect(path).toBe(cfgPath(dota));
    expect(path.endsWith(GSI_CFG_NAME)).toBe(true);
    const text = readFileSync(path, 'utf8');
    for (const s of ['"uri"           "http://127.0.0.1:53790/"', '"timeout"       "5.0"', '"buffer"        "0.1"', '"throttle"      "0.1"', '"heartbeat"     "30.0"', `"token"       "${TOKEN}"`]) {
      expect(text).toContain(s);
    }
    const data = parseVdf(text)['dota ai coach'] as any;
    expect(Object.keys(data.data).sort()).toEqual(['abilities', 'buildings', 'events', 'hero', 'items', 'map', 'player', 'provider']);
    expect(readdirSync(dir).sort()).toEqual([GSI_CFG_NAME, 'gamestate_integration_other.cfg']);
    expect(cfgStatus(dota, 53790, TOKEN)).toMatchObject({ installed: true, current: true });
    expect(cfgStatus(dota, 53791, TOKEN)).toMatchObject({ installed: true, current: false });
    expect(removeCfg(dota)).toBe(true);
    expect(readdirSync(dir)).toEqual(['gamestate_integration_other.cfg']);
    expect(removeCfg(dota)).toBe(false);
    // Без папки Dota ничего не создаётся
    expect(() => installCfg(join(tmp(), 'нет'), 53790, TOKEN)).toThrow();
    expect(() => gsiCfgText(53790, '')).toThrow();
  });
});

describe('устаревший файл в папке Dota (при запуске)', () => {
  const setup = () => {
    const dota = join(tmp(), 'dota 2 beta');
    const dir = join(dota, 'game', 'dota', 'cfg', 'gamestate_integration');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'gamestate_integration_other.cfg'), 'чужой файл');
    return { dota, dir };
  };

  it('старый порт, старый секрет или старый формат → файл переписывается; чужие файлы не трогаются', () => {
    const { dota, dir } = setup();
    installCfg(dota, 53790, TOKEN);
    expect(refreshCfg(dota, 54000, TOKEN)).toBe('rewritten');
    expect(readFileSync(cfgPath(dota), 'utf8')).toBe(gsiCfgText(54000, TOKEN));
    expect(refreshCfg(dota, 54000, 'b'.repeat(64))).toBe('rewritten');
    expect(readFileSync(cfgPath(dota), 'utf8')).toBe(gsiCfgText(54000, 'b'.repeat(64)));
    // Формат прошлой версии: тот же порт и секрет, но другой набор блоков data
    writeFileSync(cfgPath(dota), gsiCfgText(54000, TOKEN).replace('    "abilities"   "1"\r\n', ''), 'utf8');
    expect(cfgStatus(dota, 54000, TOKEN)).toMatchObject({ installed: true, current: false });
    expect(refreshCfg(dota, 54000, TOKEN)).toBe('rewritten');
    expect(cfgStatus(dota, 54000, TOKEN)).toMatchObject({ installed: true, current: true });
    expect(readdirSync(dir).sort()).toEqual([GSI_CFG_NAME, 'gamestate_integration_other.cfg']);
    expect(readFileSync(join(dir, 'gamestate_integration_other.cfg'), 'utf8')).toBe('чужой файл');
    expect(readdirSync(dir).some((f) => f.endsWith('.tmp'))).toBe(false);
  });

  it('актуальный файл не трогается', () => {
    const { dota } = setup();
    installCfg(dota, 53790, TOKEN);
    const old = new Date(2020, 0, 1);
    utimesSync(cfgPath(dota), old, old);
    expect(refreshCfg(dota, 53790, TOKEN)).toBe('current');
    expect(statSync(cfgPath(dota)).mtimeMs).toBe(old.getTime());
  });

  it('файла нет → не создаётся (подключение — решение пользователя)', () => {
    const { dota, dir } = setup();
    expect(refreshCfg(dota, 53790, TOKEN)).toBe('absent');
    expect(existsSync(cfgPath(dota))).toBe(false);
    expect(readdirSync(dir)).toEqual(['gamestate_integration_other.cfg']);
    // И папки Dota без cfg-папки — тоже ничего не создаётся
    const bare = join(tmp(), 'dota 2 beta');
    mkdirSync(bare);
    expect(refreshCfg(bare, 53790, TOKEN)).toBe('absent');
    expect(readdirSync(bare)).toEqual([]);
  });

  it('путь с пробелами и кириллицей', () => {
    const dota = join(tmp(), 'Игры Steam', 'dota 2 beta');
    mkdirSync(dota, { recursive: true });
    installCfg(dota, 53790, TOKEN);
    expect(refreshCfg(dota, 53791, TOKEN)).toBe('rewritten');
    expect(cfgStatus(dota, 53791, TOKEN)).toMatchObject({ installed: true, current: true, path: cfgPath(dota) });
  });
});

describe('запись сессий', () => {
  it('без ников, steamid, provider и auth; по файлу на день; хранится 20 файлов', () => {
    const dir = tmp();
    const r = new SessionRecorder(dir);
    const body = { ...laning(), auth: { token: TOKEN }, player: { ...laning().player, team2: { player0: { name: 'Чужой ник', steamid: '1', accountid: '2' } } } };
    r.record(body, new Date(2026, 9, 13, 12).getTime());
    r.record(body, new Date(2026, 9, 13, 12, 1).getTime());
    const text = readFileSync(join(dir, '2026-10-13.jsonl'), 'utf8');
    const lines = parseSession(text);
    expect(lines).toHaveLength(2);
    for (const s of ['Игрок', 'Чужой ник', '76561190000000001', '39734273', TOKEN, 'provider', 'steamid', 'accountid']) expect(text).not.toContain(s);
    expect((lines[0]!.body as any).hero.name).toBe('npc_dota_hero_nevermore');
    expect((lines[0]!.body as any).player.gold).toBe(1335);
    expect(sanitizeGsiBody({ provider: { name: 'Dota 2' }, map: { name: 'start' } })).toEqual({ map: { name: 'start' } });

    for (let d = 1; d <= 25; d++) r.record(body, new Date(2026, 10, d, 12).getTime());
    const files = readdirSync(dir).sort();
    expect(files).toHaveLength(KEEP_FILES);
    expect(files.at(-1)).toBe('2026-11-25.jsonl');
    expect(existsSync(join(dir, '2026-10-13.jsonl'))).toBe(false);
  });
});

describe('запись сессий: общий предел размера', () => {
  it('предел по умолчанию — 500 МБ', () => {
    expect(MAX_TOTAL_BYTES).toBe(500 * 1024 * 1024);
  });

  it('сверх предела удаляются самые старые дни; файл текущего дня — никогда', () => {
    const dir = tmp();
    const day = (d: number) => `2026-10-${String(d).padStart(2, '0')}.jsonl`;
    for (let d = 1; d <= 5; d++) writeFileSync(join(dir, day(d)), 'x'.repeat(400));
    writeFileSync(join(dir, 'чужой.txt'), 'y'.repeat(5000)); // посторонние файлы не трогаются и не считаются
    // Предел 1500 байт; текущий день — 13 октября
    const r = new SessionRecorder(dir, () => undefined, 1500);
    r.record({ map: { name: 'start' } }, new Date(2026, 9, 13, 12).getTime());
    const left = readdirSync(dir).sort();
    // 5 × 400 + текущий > 1500: удаляются 01, 02 (остаются 03, 04, 05 и текущий: 1200 + ~40 ≤ 1500)
    expect(left).toEqual([day(3), day(4), day(5), day(13), 'чужой.txt']);
    // Текущий день сам больше предела — не удаляется, удаляется всё более старое
    writeFileSync(join(dir, day(13)), 'z'.repeat(3000));
    r.prune();
    expect(readdirSync(dir).sort()).toEqual([day(13), 'чужой.txt']);
  });

  it('предел проверяется и в течение одного дня (без смены файла)', () => {
    const dir = tmp();
    writeFileSync(join(dir, '2026-10-01.jsonl'), 'x'.repeat(2000));
    const r = new SessionRecorder(dir, () => undefined, 1_000_000);
    const t = new Date(2026, 9, 13, 12).getTime();
    r.record({ map: { name: 'start' } }, t);
    expect(existsSync(join(dir, '2026-10-01.jsonl'))).toBe(true);
    // Предел 30 КБ: при открытии файла дня всё ещё в пределе, за 1000 записей текущий день его превышает —
    // старый день удаляется сам, без смены файла
    const small = new SessionRecorder(dir, () => undefined, 30_000);
    small.record({ map: { name: 'start' } }, t);
    expect(existsSync(join(dir, '2026-10-01.jsonl'))).toBe(true);
    for (let i = 0; i < 1000; i++) small.record({ map: { name: 'start', i } }, t + i);
    expect(existsSync(join(dir, '2026-10-01.jsonl'))).toBe(false);
    expect(existsSync(join(dir, '2026-10-13.jsonl'))).toBe(true);
  });
});

describe('перезапуск приёмника по одному', () => {
  /** Поддельный приёмник: «слушает» между start и stop; start и stop занимают время */
  function fakes() {
    const listening = new Set<number>();
    const log: string[] = [];
    let seq = 0;
    const tick = () => new Promise((r) => setTimeout(r, 5));
    const create = (port: number) => {
      const id = ++seq;
      return {
        id,
        port,
        async start() {
          await tick();
          listening.add(id);
          log.push(`start ${port}`);
        },
        async stop() {
          await tick();
          listening.delete(id);
          log.push(`stop ${port}`);
        },
      };
    };
    return { listening, log, r: new SerialRestarter(create, (s) => s.start()) };
  }

  it('несколько смен порта подряд — слушает один приёмник, на последнем порту', async () => {
    const { listening, log, r } = fakes();
    await r.restart(53790);
    const a = r.restart(53791);
    const b = r.restart(53792);
    const c = r.restart(53793);
    await Promise.all([a, b, c]);
    expect(listening.size).toBe(1);
    expect(r.server?.port).toBe(53793);
    // Прежний всегда остановлен до запуска следующего
    for (let i = 1; i < log.length; i++) if (log[i]!.startsWith('start')) expect(log[i - 1]!.startsWith('stop') || i === 0).toBe(true);
    expect(log[0]).toBe('start 53790');
  });

  it('stop во время перезапуска — ничего не слушает', async () => {
    const { listening, r } = fakes();
    void r.restart(53790);
    void r.restart(53791);
    await r.stop();
    expect(listening.size).toBe(0);
    expect(r.server).toBeNull();
  });

  it('с настоящим приёмником: два перезапуска подряд не оставляют второй сервер', async () => {
    const created: GsiServer[] = [];
    const r = new SerialRestarter(
      (port) => {
        const s = new GsiServer({ port, token: TOKEN, onBody: () => undefined });
        created.push(s);
        servers.push(s);
        return s;
      },
      (s) => s.start(),
    );
    await Promise.all([r.restart(0), r.restart(0), r.restart(0)]);
    expect(created.filter((s) => s.boundPort !== null)).toHaveLength(1);
    expect(r.server?.status.state).toBe('listening');
    await r.stop();
    expect(created.every((s) => s.boundPort === null)).toBe(true);
  });
});

describe('путь Steam из реестра', () => {
  it('вывод PowerShell (UTF-8): кириллица, пробелы, прямые слеши и BOM', () => {
    expect(parsePowershellSteamPath('\uFEFFD:/Игры/Steam Library\r\n')).toBe('D:\\Игры\\Steam Library');
    expect(parsePowershellSteamPath('\r\nc:/program files (x86)/steam\r\n')).toBe('c:\\program files (x86)\\steam');
    expect(parsePowershellSteamPath('')).toBeNull();
    expect(parsePowershellSteamPath('\r\n  \r\n')).toBeNull();
  });

  it('вывод reg query (запасной путь)', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    d:/Игры/Steam Library\r\n\r\n';
    expect(parseRegSteamPath(out)).toBe('d:\\Игры\\Steam Library');
    expect(parseRegSteamPath('ERROR: The system was unable to find the specified registry key or value.')).toBeNull();
  });

  it('кириллица, искажённая кодировкой («????»), — «не прочитано», а не путь', () => {
    const out = '\r\nHKEY_CURRENT_USER\\Software\\Valve\\Steam\r\n    SteamPath    REG_SZ    D:\\????\\Steam Library\r\n\r\n';
    expect(parseRegSteamPath(out)).toBeNull();
    expect(parsePowershellSteamPath('D:\\\uFFFD\uFFFD\\Steam')).toBeNull();
    expect(parsePowershellSteamPath('D:\\Игры\\Steam Library')).toBe('D:\\Игры\\Steam Library');
  });

  // Только в CI на Windows: пишем временный ключ HKCU и читаем его так же, как коуч читает ключ Steam
  it.skipIf(process.platform !== 'win32' || !process.env.CI)('Windows: путь с кириллицей и пробелами читается без искажений', async () => {
    const key = 'HKCU\\Software\\DotaCoachTest';
    const value = 'D:\\Игры\\Steam Library';
    execFileSync('reg', ['add', key, '/v', 'SteamPath', '/t', 'REG_SZ', '/d', value, '/f'], { windowsHide: true });
    try {
      expect(await steamPathFromRegistry(key)).toBe(value);
    } finally {
      execFileSync('reg', ['delete', key, '/f'], { windowsHide: true });
    }
  }, 45_000);
});

describe('npm run gsi:replay', () => {
  it('отправляет записанную сессию в приёмник в реальном времени и с токеном', async () => {
    const got: any[] = [];
    const { port } = await server((b) => got.push(b));
    const entries = parseSession(readFileSync(join(FIX, 'session.jsonl'), 'utf8'));
    expect(entries).toHaveLength(20);
    const t0 = Date.now();
    const r = await replaySession(entries, { url: `http://127.0.0.1:${port}/`, token: TOKEN, speed: 4 });
    const took = Date.now() - t0;
    expect(r).toEqual({ sent: 20, failed: 0 });
    expect(got).toHaveLength(20);
    expect(got.at(-1).player.gold).toBe(1335 + 19 * 2);
    // 1.9 с записи при скорости 4 — не меньше ~0.47 с
    expect(took).toBeGreaterThanOrEqual(400);
    // Неверный токен — все отклонены
    expect(await replaySession(entries.slice(0, 2), { url: `http://127.0.0.1:${port}/`, token: 'c'.repeat(64), speed: 100 })).toEqual({ sent: 0, failed: 2 });
  });

  it('порт и секрет берутся из settings.json коуча', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'settings.json'), JSON.stringify({ gsi: { port: 54000, token: TOKEN } }));
    expect(readCoachSettings(dir)).toEqual({ port: 54000, token: TOKEN });
    expect(readCoachSettings(tmp())).toEqual({ port: null, token: null });
  });
});

describe('настройки GSI', () => {
  it('порт по умолчанию 53790, запись включена; секрет из интерфейса не меняется', () => {
    const d = defaultSettings();
    expect(d.gsi).toEqual({ port: 53790, token: '', record: true, dotaDir: null });
    expect(settingsPatchSchema.safeParse({ gsi: { port: 54000 } }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ gsi: { port: 80 } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ gsi: { token: TOKEN } }).success).toBe(false);
    expect(settingsPatchSchema.safeParse({ gsi: { dotaDir: 'C:\\x' } }).success).toBe(false);
    expect(applyInternalGsi(d, { token: TOKEN }).gsi.token).toBe(TOKEN);
    // Испорченный секрет в файле — сбрасывается (создастся новый)
    expect(settingsSchema.parse({ gsi: { token: 'короткий', port: 54000 } }).gsi).toMatchObject({ token: '', port: 54000 });
  });
});
