// Чистая логика сторожа автопродолжения (scripts/after-items-fetch.mjs, DECISIONS.md п. 85): закончена ли докачка,
// разбор вывода пересчёта, сравнение режима тени до/после и текст отчёта. Без ввода-вывода — проверяется тестами
// (tests/unit/after-items-fetch.test.ts).

/** Цели докачки по умолчанию (как MODES в scripts/fetch-items-matches.mjs); точное значение читается из items-progress.txt */
export const DEFAULT_TARGETS = { ap: 900, turbo: 500 };

/** Цели из строк items-progress.txt («All Pick: … героев с ≥ 900 матчами …», «Турбо: … с ≥ 500 …») */
export function targetsFromProgress(text) {
  const out = { ...DEFAULT_TARGETS };
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /с ≥ (\d+) матчами/.exec(line);
    if (!m) continue;
    if (line.startsWith('All Pick')) out.ap = Number(m[1]);
    else if (line.startsWith('Турбо')) out.turbo = Number(m[1]);
  }
  return out;
}

/**
 * Закончен ли режим докачки — то же условие, что в fetch-items-matches.mjs: матчи патча кончились и очередь пуста,
 * или у всех героев не меньше цели. state — содержимое state.json режима.
 */
export function modeDone(state, target) {
  if (!state || !state.heroCounts) return false;
  const counts = Object.values(state.heroCounts);
  return (state.exhausted === true && !(state.queue ?? []).length) || (counts.length > 0 && counts.every((n) => n >= target));
}

/**
 * Состояние докачки для сторожа: 'done' — оба режима закончены и процесс докачки не работает; 'running' — идёт;
 * 'stopped' — процесса нет, но цель не набрана (выключили ПК, ещё не запустилась) — ждать дальше.
 */
export function fetchStatus({ ap, turbo, targets, fetcherAlive }) {
  const done = modeDone(ap, targets.ap) && modeDone(turbo, targets.turbo);
  if (fetcherAlive) return 'running';
  return done ? 'done' : 'stopped';
}

/** Итоги build-item-situations.mjs из его вывода (числа строк «Матчей …», «Пар …», «Проверок …») */
export function parseSituations(out) {
  const s = String(out ?? '');
  const num = (re) => {
    const m = re.exec(s);
    return m ? Number(m[1]) : null;
  };
  return {
    matches: num(/Матчей: (\d+)/),
    used: num(/не короче \d+ мин: (\d+)/),
    pairs40: num(/матчами в каждом положении \(поиск\): (\d+)/),
    pairs300: num(/; с ≥ 300: (\d+)/),
    tests: num(/Проверок: (\d+)/),
    found: num(/\(FDR [\d.]+%\): (\d+)/),
    confirmed: num(/подтвердилось на отложенных: (\d+)/),
    confirmedLines: s.split(/\r?\n/).filter((l) => /^\s{2}\S+\|\d (отстаём|ведём): /.test(l)).map((l) => l.trim()),
  };
}

/** Итоги build-item-timings.mjs: какой ранг выбран для сборок Турбо и сколько пар */
export function parseTimings(out) {
  const s = String(out ?? '');
  const ranked = /Сборки Турбо — по рангу игрока (\S+) \((\d+) пар/.exec(s);
  return {
    turboRank: ranked ? ranked[1] : null,
    turboRankPairs: ranked ? Number(ranked[2]) : null,
    publicPairs: (() => {
      const m = /из них ≥ 40 матчей: (\d+)/.exec(s);
      return m ? Number(m[1]) : null;
    })(),
    rankLines: s.split(/\r?\n/).filter((l) => l.startsWith('Турбо по рангу игрока')),
  };
}

/** Сводка shadow-results.json (tests/unit/shadow.test.ts) для сравнения до/после */
export function shadowSummary(r) {
  if (!r) return null;
  const c = r.checks ?? {};
  return {
    total: c.total ?? null,
    perMin: r.perMin ?? null,
    deaths: c.deaths ?? null,
    deathsWarned: c.deathsWarned ?? null,
    farmInFight: c.farmInFight ?? null,
    itemAdvice: Array.isArray(r.itemAdvice) ? r.itemAdvice.length : null,
    byRule: r.byRule ?? {},
  };
}

/** Строки «правило: было → стало» для правил, у которых число советов изменилось (сначала самые большие изменения) */
export function shadowDiff(before, after, limit = 15) {
  const a = shadowSummary(before);
  const b = shadowSummary(after);
  if (!a || !b) return { lines: [], changed: 0 };
  const keys = new Set([...Object.keys(a.byRule), ...Object.keys(b.byRule)]);
  const rows = [...keys]
    .map((k) => ({ k, x: a.byRule[k] ?? 0, y: b.byRule[k] ?? 0 }))
    .filter((r) => r.x !== r.y)
    .sort((p, q) => Math.abs(q.y - q.x) - Math.abs(p.y - p.x));
  return { lines: rows.slice(0, limit).map((r) => `${r.k}: ${r.x} → ${r.y}`), changed: rows.length };
}

const n = (x) => (x === null || x === undefined ? '—' : String(x));

/**
 * Отчёт сторожа (Markdown). info: { finishedAt, branch, base, worktree, progress, heroes: {ap:{reached,total,target},turbo:…},
 * timings, situations, checks: [{name, ok, summary}], shadow: {ap:{before,after}, turbo:{before,after}}, commit, notes: [] }
 */
export function buildReport(info) {
  const L = [];
  L.push('# Пересчёт после докачки STRATZ', '');
  L.push(`Закончено: ${info.finishedAt}. Ветка \`${info.branch}\` от \`${info.base}\` (рабочая папка \`${info.worktree}\`), коммит ${info.commit ?? 'не сделан'}.`);
  L.push('Не влито, версия не поднята, ничего не опубликовано.', '');
  L.push('## Докачка', '', '```', String(info.progress ?? '').trim(), '```', '');
  for (const [k, label] of [['ap', 'All Pick'], ['turbo', 'Турбо']]) {
    const h = info.heroes?.[k];
    if (h) L.push(`- ${label}: героев с ≥ ${h.target} матчами — ${h.reached} из ${h.total}.`);
  }
  const s = info.situations ?? {};
  L.push('', '## Сборка от положения (All Pick, build-item-situations.mjs)', '');
  L.push(`- Матчей: ${n(s.matches)}, из них не короче 35 мин: ${n(s.used)}.`);
  L.push(`- Пар «герой — позиция» с ≥ 40 матчами в каждом положении (поиск, 70%): ${n(s.pairs40)}; с ≥ 300: ${n(s.pairs300)}.`);
  L.push(`- Проверок: ${n(s.tests)}; прошли отбор (z ≥ 3 и поправка Бенджамини — Хохберга): ${n(s.found)}; подтвердились на отложенных 30%: **${n(s.confirmed)}**.`);
  for (const l of s.confirmedLines ?? []) L.push(`  - ${l}`);
  const t = info.timings ?? {};
  L.push('', '## Сборки Турбо по рангу игрока (build-item-timings.mjs)', '');
  for (const l of t.rankLines ?? []) L.push(`- ${l}`);
  L.push(t.turboRank ? `- Выбрано: **${t.turboRank}** (${t.turboRankPairs} пар с ≥ 40 матчами; у публичных — ${n(t.publicPairs)}).` : `- Данных мало — сборки Турбо остаются публичными (${n(t.publicPairs)} пар с ≥ 40 матчами).`);
  L.push('', '## Проверки', '');
  for (const c of info.checks ?? []) L.push(`- ${c.ok ? '✅' : '❌'} ${c.name}${c.summary ? ` — ${c.summary}` : ''}`);
  L.push('', '## Режим тени: до → после', '');
  for (const [k, label] of [['ap', 'All Pick (про-матчи)'], ['turbo', 'Турбо']]) {
    const sh = info.shadow?.[k];
    const a = shadowSummary(sh?.before);
    const b = shadowSummary(sh?.after);
    if (!a || !b) {
      L.push(`- ${label}: нет данных`);
      continue;
    }
    L.push(`- ${label}: советов ${n(a.total)} → ${n(b.total)} (${n(a.perMin)} → ${n(b.perMin)} в мин), о предметах ${n(a.itemAdvice)} → ${n(b.itemAdvice)}, смертей с предупреждением ${n(a.deathsWarned)}/${n(a.deaths)} → ${n(b.deathsWarned)}/${n(b.deaths)}, фарм в драке ${n(a.farmInFight)} → ${n(b.farmInFight)}.`);
    const d = shadowDiff(sh.before, sh.after);
    if (d.changed) for (const l of d.lines) L.push(`  - ${l}`);
    else L.push('  - по правилам без изменений');
  }
  if (info.notes?.length) {
    L.push('', '## Заметки', '');
    for (const x of info.notes) L.push(`- ${x}`);
  }
  L.push('', 'Логи шагов — `.tmp/after-fetch/logs/`. Следующий шаг — `.tmp/after-fetch-task.md` (запускает владелец).', '');
  return L.join('\n');
}
