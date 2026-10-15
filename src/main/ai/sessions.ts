// Записанные сессии GSI (<данные>/gsi-sessions/<день>.jsonl) для «Разбора матча»: список матчей и чтения одного матча.
// Ники и steamid в файлах уже вырезаны (recorder.ts). Только чтение — файлы не меняются.
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mapGsi, type GsiReading } from '@core/gsi/map.ts';
import type { GsiSessionInfo, GsiSessionMatch } from '@shared/ipc';
import itemTemplatesJson from '../../data/item-templates.json';
import heroNamesJson from '../../data/hero-names.json';

const FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
/** Чтения матча не чаще, чем раз в столько секунд игрового времени */
const STEP_SEC = 2;
/** Матч короче этого (секунд игрового времени) в списке не показываем */
const MIN_MATCH_SEC = 60;

const itemNames = new Map<string, string>();
for (const it of (itemTemplatesJson as unknown as { items: { key: string; name: string }[] }).items) itemNames.set(it.key, it.name);
const heroes = new Map<string, { id: number; name: string }>();
for (const h of heroNamesJson.names as { id: number; key: string; name: string }[]) heroes.set(h.key, { id: h.id, name: h.name });

export function readGsiBody(body: unknown): GsiReading | null {
  return mapGsi(
    body,
    (k) => itemNames.get(k),
    (k) => heroes.get(k),
  );
}

interface Scan {
  info: GsiSessionInfo;
  readings: GsiReading[];
}

/** Проходит файл и делит его на матчи (по matchid; без matchid — по сбросу часов назад) */
async function scanFile(file: string, day: string, keepReadings: boolean): Promise<Scan[]> {
  const out: Scan[] = [];
  let cur: (Scan & { key: string; lastClock: number | null; firstClock: number | null }) | null = null;
  const rl = createInterface({ input: createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    let rec: { t?: unknown; body?: unknown };
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof rec.t !== 'number') continue;
    const r = readGsiBody(rec.body);
    if (!r || r.clock === null || r.phase !== 'in-progress') continue;
    const key = r.matchId ?? 'nomatch';
    const restarted = cur && cur.key === key && cur.lastClock !== null && r.clock < cur.lastClock - 30;
    if (!cur || cur.key !== key || restarted) {
      cur = {
        key,
        info: { id: '', day, matchId: r.matchId, hero: r.hero.name ?? r.hero.key, startedAt: rec.t, durationSec: null },
        readings: [],
        lastClock: null,
        firstClock: r.clock,
      };
      out.push(cur);
    }
    if (cur.lastClock === null || r.clock >= cur.lastClock + STEP_SEC) {
      if (keepReadings) cur.readings.push(r);
      cur.lastClock = r.clock;
    }
    cur.info.durationSec = Math.max(0, Math.round(r.clock));
  }
  const kept = out.filter((m) => (m.info.durationSec ?? 0) >= MIN_MATCH_SEC);
  kept.forEach((m, i) => (m.info.id = `${day}#${i}`));
  return kept;
}

const cache = new Map<string, { mtimeMs: number; size: number; infos: GsiSessionInfo[] }>();

export async function listSessions(dataDir: string): Promise<GsiSessionInfo[]> {
  const dir = join(dataDir, 'gsi-sessions');
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => FILE_RE.test(f)).sort().reverse();
  const all: GsiSessionInfo[] = [];
  for (const f of files) {
    const path = join(dir, f);
    const st = statSync(path);
    let c = cache.get(path);
    if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
      const scans = await scanFile(path, FILE_RE.exec(f)![1]!, false);
      c = { mtimeMs: st.mtimeMs, size: st.size, infos: scans.map((s) => s.info) };
      cache.set(path, c);
    }
    all.push(...[...c.infos].reverse());
  }
  return all;
}

export async function readSessionMatch(dataDir: string, id: string): Promise<GsiSessionMatch | { error: string }> {
  const m = /^(\d{4}-\d{2}-\d{2})#(\d{1,4})$/.exec(id);
  if (!m) return { error: 'Неверный номер записи' };
  const path = join(dataDir, 'gsi-sessions', `${m[1]}.jsonl`);
  if (!existsSync(path)) return { error: 'Запись не найдена' };
  const scans = await scanFile(path, m[1]!, true);
  const s = scans[Number(m[2])];
  return s ? { info: s.info, readings: s.readings } : { error: 'Матч в записи не найден' };
}
