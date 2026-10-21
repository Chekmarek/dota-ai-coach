// Докачка матчей «для предметов» (scripts/fetch-items-matches.mjs → items-data-lib.mjs): продолжение после обрыва без
// дублей, запрет экзаменов, режима тени и своих матчей, очередь «сначала редкие герои».
import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
// @ts-expect-error — .mjs без типов (скрипт разработчика)
import { forbiddenIds, prioritize, retryFailed, step } from '../../scripts/items-data-lib.mjs';

type State = { queue: (number | { id: number; need: number })[]; rejected: Record<string, string>; heroCounts: Record<number, number>; inFlight?: string; requests?: number; retries?: Record<string, number> };
const PATCH = 190;
const match = (id: number) => ({
  id,
  durationSeconds: 2400,
  gameVersionId: PATCH,
  parsedDateTime: 1,
  gameMode: 'ALL_PICK_RANKED',
  players: Array.from({ length: 10 }, (_, i) => ({ heroId: i + 1, isRadiant: i < 5, isVictory: i < 5, position: `POSITION_${(i % 5) + 1}`, steamAccount: { seasonRank: 75 }, stats: { itemPurchases: [{ time: 60, itemId: 1 }], killEvents: [] } })),
});

function harness(crashOn?: { id: string; when: 'fetch' | 'after-store' }) {
  const store = new Map<string, unknown>();
  const stored: string[] = [];
  const fetched: string[] = [];
  let crashed = false;
  const io = {
    forbidden: new Set<string>(),
    has: (id: string) => store.has(id),
    store: (id: string, c: unknown) => {
      store.set(id, c);
      stored.push(id);
      if (!crashed && crashOn?.when === 'after-store' && crashOn.id === id) {
        crashed = true;
        throw new Error('обрыв после записи');
      }
    },
    fetchMatch: async (id: string) => {
      fetched.push(id);
      if (!crashed && crashOn?.when === 'fetch' && crashOn.id === id) {
        crashed = true;
        throw new Error('обрыв посреди запроса');
      }
      return match(Number(id));
    },
  };
  return { io, store, stored, fetched };
}

/** Прогон до конца очереди; состояние «на диске» — копия после каждого успешного шага; обрыв — перезапуск с копии */
async function runWithRestart(h: ReturnType<typeof harness>, initial: State) {
  let disk = JSON.stringify(initial);
  for (let attempt = 0; attempt < 3; attempt++) {
    const s = JSON.parse(disk) as State;
    retryFailed(s, 'обрыв');
    try {
      for (;;) {
        const r = await step(s, h.io, PATCH);
        disk = JSON.stringify(s);
        if (r === 'empty') return JSON.parse(disk) as State;
      }
    } catch {
      // процесс «упал»: что успело сохраниться на диск, то и есть
    }
  }
  throw new Error('не закончил');
}

describe('докачка: продолжение после обрыва', () => {
  const fresh = (): State => ({ queue: [1, 2, 3, 4, 5, 6], rejected: {}, heroCounts: {} });
  it('докачка оборвалась посреди запроса → продолжает с того же матча, без дублей', async () => {
    const h = harness({ id: '3', when: 'fetch' });
    await runWithRestart(h, fresh());
    expect(h.stored).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(new Set(h.stored).size).toBe(h.stored.length);
  });
  it('обрыв сразу после записи матча → при перезапуске он пропускается, не качается заново', async () => {
    const h = harness({ id: '4', when: 'after-store' });
    await runWithRestart(h, fresh());
    expect(h.stored).toEqual(['1', '2', '3', '4', '5', '6']);
    expect(h.fetched.filter((x) => x === '4')).toHaveLength(1);
  });
  it('ошибка запроса 3 раза → матч отклонён, очередь идёт дальше', () => {
    const s: State = { queue: [], rejected: {}, heroCounts: {} };
    for (let i = 0; i < 3; i++) {
      s.inFlight = '9';
      retryFailed(s, 'сбой');
    }
    expect(s.rejected['9']).toMatch(/3 попытки/);
    expect(s.queue).toHaveLength(2);
  });
});

describe('докачка: что нельзя брать в обучение', () => {
  it('экзаменационный матч, матч режима тени и свой матч не попадают в обучающие данные', async () => {
    const root = mkdtempSync(join(tmpdir(), 'items-'));
    for (const [d, f] of [['exam5-ap', '111.json.gz'], ['exam9-turbo', '112.json.gz'], ['shadow', '113.json'], ['danger-own', '114.json.gz'], ['danger', '115.json.gz']]) {
      mkdirSync(join(root, '.tmp', d!), { recursive: true });
      writeFileSync(join(root, '.tmp', d!, f!), '');
    }
    const forbidden = forbiddenIds(root) as Set<string>;
    expect([...forbidden].sort()).toEqual(['111', '112', '113', '114']);
    const h = harness();
    h.io.forbidden = forbidden;
    const s: State = { queue: [111, 113, 116], rejected: {}, heroCounts: {} };
    while ((await step(s, h.io, PATCH)) !== 'empty');
    expect(h.fetched).toEqual(['116']);
  });
  it('очередь: сначала матчи с героями, которых меньше всего', () => {
    const q = prioritize(
      [
        { match_id: 1, radiant_team: [1, 2, 3, 4, 5], dire_team: [6, 7, 8, 9, 10] },
        { match_id: 2, radiant_team: [11, 2, 3, 4, 5], dire_team: [6, 7, 8, 9, 10] },
      ],
      { 1: 500, 2: 500, 3: 500, 4: 500, 5: 500, 6: 500, 7: 500, 8: 500, 9: 500, 10: 500, 11: 3 },
      500,
    ) as { id: number }[];
    expect(q.map((x) => x.id)).toEqual([2]);
  });
});
