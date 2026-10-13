// Повтор записанной сессии GSI в работающий коуч — в реальном времени, без Dota.
//   npm run gsi:replay -- <файл.jsonl> [--speed 2] [--port 53790] [--token <секрет>] [--data-dir <папка данных>]
// Порт и секрет по умолчанию берутся из settings.json коуча (папка данных: --data-dir, DOTACOACH_DATA_DIR
// или стандартная %APPDATA%\Dota AI Coach). Файл — из <папка данных>/gsi-sessions или tests/fixtures/gsi/session.jsonl.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Строки записи: {t, body}; пустые и битые строки пропускаются */
export function parseSession(text) {
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const x = JSON.parse(line);
      if (x && typeof x.t === 'number' && x.body && typeof x.body === 'object') out.push(x);
    } catch {
      /* битая строка */
    }
  }
  return out;
}

export function defaultDataDir() {
  if (process.env.DOTACOACH_DATA_DIR) return process.env.DOTACOACH_DATA_DIR;
  const base = process.platform === 'win32' ? (process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')) : process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support') : (process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'));
  return join(base, 'Dota AI Coach');
}

/** Порт и секрет из settings.json коуча */
export function readCoachSettings(dataDir) {
  const file = join(dataDir, 'settings.json');
  if (!existsSync(file)) return { port: null, token: null };
  try {
    const s = JSON.parse(readFileSync(file, 'utf8'));
    return { port: Number(s?.gsi?.port) || null, token: typeof s?.gsi?.token === 'string' && s.gsi.token ? s.gsi.token : null };
  } catch {
    return { port: null, token: null };
  }
}

/**
 * Отправляет записи по порядку, выдерживая паузы между ними (делённые на speed).
 * post(body) → код ответа. Возвращает число отправленных и отклонённых запросов.
 */
export async function replaySession(entries, { url, token, speed = 1, post = defaultPost, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onSent } = {}) {
  let sent = 0, failed = 0;
  const t0 = entries[0]?.t ?? 0;
  const start = Date.now();
  for (const e of entries) {
    const due = (e.t - t0) / speed - (Date.now() - start);
    if (due > 0) await sleep(due);
    const code = await post(url, { ...e.body, auth: { token } });
    if (code === 200) sent++;
    else failed++;
    onSent?.(code, sent + failed, entries.length);
  }
  return { sent, failed };
}

async function defaultPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await res.arrayBuffer();
  return res.status;
}

function arg(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
  if (!file) {
    console.error('Укажите файл: npm run gsi:replay -- <файл.jsonl> [--speed 2] [--port N] [--token T] [--data-dir D]');
    process.exit(2);
  }
  const dataDir = arg(args, '--data-dir') ?? defaultDataDir();
  const fromSettings = readCoachSettings(dataDir);
  const port = Number(arg(args, '--port') ?? fromSettings.port ?? 53790);
  const token = arg(args, '--token') ?? fromSettings.token;
  const speed = Number(arg(args, '--speed') ?? 1);
  if (!token) {
    console.error(`Секрет GSI не найден в ${join(dataDir, 'settings.json')}. Запустите коуч хотя бы раз или передайте --token.`);
    process.exit(2);
  }
  const entries = parseSession(readFileSync(resolve(file), 'utf8'));
  if (entries.length === 0) {
    console.error('В файле нет записей');
    process.exit(2);
  }
  const url = `http://127.0.0.1:${port}/`;
  const secs = ((entries.at(-1).t - entries[0].t) / 1000 / speed).toFixed(1);
  console.log(`Отправляю ${entries.length} запросов в ${url} (≈ ${secs} с)…`);
  try {
    const r = await replaySession(entries, { url, token, speed });
    console.log(`Готово: принято ${r.sent}, отклонено ${r.failed}`);
    process.exit(r.failed ? 1 : 0);
  } catch (err) {
    console.error(`Коуч не отвечает на ${url}: ${err.cause?.code ?? err.message}. Он запущен?`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
