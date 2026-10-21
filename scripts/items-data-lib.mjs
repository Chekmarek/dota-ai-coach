// Общее для докачки матчей «для предметов» (scripts/fetch-items-matches.mjs) и пересчёта (build-item-situations.mjs):
// какие матчи нельзя брать в обучение, компактная запись матча, очередь «сначала редкие герои», продолжение после
// обрыва. Чистые функции — проверяются тестами (tests/unit/items-fetch.test.ts).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Матчи, которые НЕ попадают в обучающие данные: экзамены (.tmp/exam*), режим тени (.tmp/shadow), свои матчи
 * владельца (.tmp/danger-own). Возвращает множество id строкой.
 */
export function forbiddenIds(root) {
  const tmp = join(root, '.tmp');
  const out = new Set();
  if (!existsSync(tmp)) return out;
  for (const d of readdirSync(tmp, { withFileTypes: true })) {
    if (!d.isDirectory() || !(/^exam/.test(d.name) || d.name === 'shadow' || d.name === 'danger-own')) continue;
    for (const f of readdirSync(join(tmp, d.name))) {
      const m = /^(\d+)\.json(\.gz)?$/.exec(f);
      if (m) out.add(m[1]);
    }
  }
  return out;
}

/** id матчей, уже лежащих в папке (<id>.json.gz) */
export function idsIn(dir) {
  return existsSync(dir) ? new Set(readdirSync(dir).filter((f) => f.endsWith('.json.gz')).map((f) => f.slice(0, -8))) : new Set();
}

/**
 * Компактная запись матча STRATZ: только то, что нужно для предметов — герой, сторона, победа, позиция, ранг
 * игрока (seasonRank, без ников и id), покупки [минута*60, itemId], моменты убийств. Ники и аккаунты не хранятся.
 */
export function compactMatch(m) {
  return {
    id: m.id,
    dur: m.durationSeconds,
    ver: m.gameVersionId,
    mode: m.gameMode,
    rank: m.rank ?? null,
    bracket: m.bracket ?? null,
    radiantWin: m.didRadiantWin ?? null,
    players: m.players.map((p) => ({
      hero: p.heroId,
      radiant: p.isRadiant,
      win: p.isVictory,
      pos: String(p.position ?? '').replace('POSITION_', '') || null,
      rank: p.steamAccount?.seasonRank ?? null,
      buys: (p.stats?.itemPurchases ?? []).map((b) => [b.time, b.itemId]),
      kills: (p.stats?.killEvents ?? []).map((k) => k.time),
    })),
  };
}

/** Матч годится: разобран, нужный патч, 10 игроков, у всех позиция и покупки */
export function usable(m, patchId) {
  return !!(m && m.parsedDateTime && m.gameVersionId === patchId && m.players?.length === 10 && m.players.every((p) => p.position && p.stats?.itemPurchases?.length));
}

/**
 * Очередь «сначала редкие герои»: у каждого матча из списка OpenDota (известны 10 героев, позиции — нет) приоритет —
 * сумма недобора по его героям до цели (цель − уже есть, не меньше 0). Матчи без недобора не берутся.
 */
export function prioritize(rows, heroCounts, target) {
  return rows
    .map((r) => ({ id: r.match_id, need: [...(r.radiant_team ?? []), ...(r.dire_team ?? [])].reduce((a, h) => a + Math.max(0, target - (heroCounts[h] ?? 0)), 0) }))
    .filter((x) => x.need > 0)
    .sort((a, b) => b.need - a.need);
}

/**
 * Запрос упал с ошибкой: id возвращается в конец очереди, не больше 3 попыток на матч; потом — «отклонён».
 * Вызывать в обработчике ошибки шага (и при старте: обрыв посреди запроса оставляет inFlight).
 */
export function retryFailed(state, reason = 'ошибка') {
  const id = state.inFlight;
  if (id === undefined) return;
  delete state.inFlight;
  state.retries ??= {};
  state.retries[id] = (state.retries[id] ?? 0) + 1;
  if (state.retries[id] >= 3) state.rejected[id] = `${reason} (3 попытки)`;
  else state.queue.push({ id, need: 0 });
}

/** Сутки по UTC — для счёта запросов к STRATZ */
export const utcDay = (ms) => new Date(ms).toISOString().slice(0, 10);

/**
 * Один шаг докачки (чистая логика, ввод-вывод — снаружи): берёт следующий id из очереди, пропускает уже скачанные,
 * запрещённые и отклонённые, иначе качает. Состояние меняется на месте и сохраняется вызывающим после каждого шага,
 * так что обрыв в любом месте не даёт ни дублей, ни потерь (кроме одного запроса).
 * io: { fetchMatch(id) → матч | null, store(id, compact), has(id) → bool, forbidden: Set }.
 * Возвращает 'empty' (очередь пуста), 'skip', 'saved', 'rejected'.
 */
export async function step(state, io, patchId) {
  const next = state.queue.shift();
  if (next === undefined) return 'empty';
  const id = String(next.id ?? next);
  if (io.has(id) || io.forbidden.has(id) || state.rejected[id]) return 'skip';
  // На время запроса id запомнен: ошибка (сеть, сбой STRATZ) — вернуть в очередь (retryFailed), а не потерять
  state.inFlight = id;
  state.requests = (state.requests ?? 0) + 1;
  const m = await io.fetchMatch(id);
  delete state.inFlight;
  if (!usable(m, patchId)) {
    state.rejected[id] = !m ? 'нет матча' : !m.parsedDateTime ? 'не разобран' : m.gameVersionId !== patchId ? 'другой патч' : 'нет данных';
    return 'rejected';
  }
  const c = compactMatch(m);
  io.store(id, c);
  for (const p of c.players) if (p.hero) state.heroCounts[p.hero] = (state.heroCounts[p.hero] ?? 0) + 1;
  return 'saved';
}

// --- Статистика для «сборки от положения» (build-item-situations.mjs) ---

/** z двух долей x1/n1 против x2/n2 (нормальное приближение) и сами доли */
export function z2(x1, n1, x2, n2) {
  if (!n1 || !n2) return { z: 0, p1: 0, p2: 0 };
  const p1 = x1 / n1;
  const p2 = x2 / n2;
  const pp = (x1 + x2) / (n1 + n2);
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  return { z: se ? (p1 - p2) / se : 0, p1, p2 };
}

function erfc(x) {
  // Абрамовиц — Стиган 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x);
  return x >= 0 ? y : 2 - y;
}
/** Односторонний p для z */
export const pOne = (z) => 0.5 * erfc(z / Math.SQRT2);

/**
 * Строгий отбор: поправка Бенджамини — Хохберга (доля ложных находок ≤ fdr) по всем проверкам сразу и z ≥ zMin.
 * tests: [{ z, ... }] → прошедшие.
 */
export function bhSelect(tests, fdr = 0.05, zMin = 3) {
  const withP = tests.map((t) => ({ ...t, p: pOne(t.z) })).sort((a, b) => a.p - b.p);
  const m = Math.max(1, withP.length);
  let cut = -1;
  withP.forEach((x, i) => {
    if (x.p <= ((i + 1) / m) * fdr) cut = i;
  });
  return withP.slice(0, cut + 1).filter((x) => x.z >= zMin);
}

/**
 * Подтверждение на отложенных матчах: та же сторона разницы, z ≥ zHold и разница не меньше половины найденной.
 * found: [{ p1, p2, ... }], hold(x) → { z, p1, p2 } | null. Не подтвердилось — не используется.
 */
export function confirmOnHoldout(found, hold, zHold = 1.645) {
  const out = [];
  for (const f of found) {
    const r = hold(f);
    if (r && r.z >= zHold && r.p1 - r.p2 >= (f.p1 - f.p2) / 2) out.push({ ...f, hold: r });
  }
  return out;
}
