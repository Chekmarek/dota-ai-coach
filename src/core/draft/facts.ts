// Факты драфта для ИИ: только то, что посчитали правила (suggestHeroes, угрозы), в виде коротких строк.
// Модель пересказывает их и не может добавить ни героя, ни числа: проверка ответа (src/core/ai/grounding.ts)
// сверяет числа именно с этими строками.
import { pctRu, type DraftCandidate } from './suggest.ts';
import type { ThreatReport } from './threats.ts';

export interface DraftFactsInput {
  candidates: readonly DraftCandidate[];
  /** Имя героя по ключу (база знаний) */
  name: (key: string) => string;
  enemies: readonly string[];
  allies: readonly string[];
  position: number | null;
  patch: string | null;
  /** Дата статистики (ISO) */
  statsAt: string | null;
  threats?: readonly ThreatReport[];
  /** Название предмета по ключу */
  itemName?: (key: string) => string;
  /** Сколько кандидатов отдать модели */
  top?: number;
  /**
   * Коротко (для уведомления при выборе героев): у кандидата не больше 3 самых сильных причин, без угроз.
   * Модель читает факты дольше, чем пишет ответ (8B: ~900 токенов фактов — 9 с из 16), поэтому их меньше
   */
  compact?: boolean;
  /** Чья статистика: Турбо — так и пишется в источнике (ИИ называет только этот режим); нет поля — обычные матчи */
  mode?: 'normal' | 'turbo';
}

const POS_RU = ['керри (1)', 'мид (2)', 'оффлейн (3)', 'частичная поддержка (4)', 'полная поддержка (5)'];
/** «1 игра», «1 902 игры», «13 200 игр» */
export function gamesRu(n: number): string {
  const m10 = n % 10, m100 = n % 100;
  const w = m10 === 1 && m100 !== 11 ? 'игра' : m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14) ? 'игры' : 'игр';
  return `${n.toLocaleString('ru-RU')} ${w}`;
}
const games = gamesRu;

export function draftFacts(i: DraftFactsInput): string[] {
  const out: string[] = [];
  const what = i.mode === 'turbo' ? 'статистика публичных матчей Турбо (режим игры — Турбо), OpenDota' : 'статистика публичных матчей OpenDota';
  out.push(`Источник: ${what}, патч ${i.patch ?? 'неизвестен'}${i.statsAt ? `, от ${i.statsAt.slice(0, 10)}` : ''}. Проценты — оценка изменения шанса победы, не гарантия.`);
  if (i.enemies.length) out.push(`Враги: ${i.enemies.map(i.name).join(', ')}.`);
  if (i.allies.length) out.push(`Союзники: ${i.allies.map(i.name).join(', ')}.`);
  if (i.position) out.push(`Позиция игрока: ${POS_RU[i.position - 1]}.`);
  i.candidates.slice(0, i.top ?? 3).forEach((c, n) => {
    let parts: { w: number; s: string }[] = [];
    for (const v of c.vsEnemies.filter((x) => Math.abs(x.delta) >= 0.001)) parts.push({ w: Math.abs(v.delta), s: `против ${i.name(v.hero)} ${pctRu(v.delta)} (${games(v.games)})` });
    for (const v of c.withAllies.filter((x) => Math.abs(x.delta) >= 0.001)) parts.push({ w: Math.abs(v.delta), s: `в связке с ${i.name(v.hero)} ${pctRu(v.delta)} (${games(v.games)})` });
    if (Math.abs(c.meta) >= 0.001) parts.push({ w: Math.abs(c.meta), s: `сила в патче ${pctRu(c.meta)}` });
    if (i.compact) parts = [...parts].sort((a, b) => b.w - a.w).slice(0, 3);
    out.push(`Кандидат ${n + 1}: ${c.name}, итог ${pctRu(c.score)}${parts.length ? `: ${parts.map((p) => p.s).join('; ')}` : ''}.`);
  });
  for (const t of i.compact ? [] : (i.threats ?? [])) {
    const items = i.itemName ? t.threat.items.map((x) => i.itemName!(x.key)).join(', ') : '';
    out.push(`Угроза врагов — ${t.threat.nameRu} (${t.heroes.map(i.name).join(', ')}): ${t.threat.whyRu}${items ? `; против неё: ${items}` : ''}.`);
  }
  return out;
}

/**
 * Уведомление при выборе героев без ИИ — сразу, за миллисекунды: кого брать и почему, по расчёту правил.
 * Если последний пик врага известен — совет против него («Враг взял Bristleback → …»). Числа — те же, что в фактах.
 */
export function draftNotice(i: { candidates: readonly DraftCandidate[]; name: (key: string) => string; lastEnemy?: string | null }): string | null {
  const [top, ...rest] = i.candidates;
  if (!top) return null;
  const vs = (i.lastEnemy && top.vsEnemies.find((v) => v.hero === i.lastEnemy)) || [...top.vsEnemies].sort((a, b) => b.delta - a.delta)[0];
  const ally = [...top.withAllies].sort((a, b) => b.delta - a.delta)[0];
  const why = [
    vs && vs.delta >= 0.001 ? `против ${i.name(vs.hero)} ${pctRu(vs.delta)} (${gamesRu(vs.games)})` : null,
    ally && ally.delta >= 0.001 ? `с ${i.name(ally.hero)} ${pctRu(ally.delta)} (${gamesRu(ally.games)})` : null,
  ].filter(Boolean);
  const head = i.lastEnemy ? `Враг взял ${i.name(i.lastEnemy)} → берите ${top.name}` : `Берите ${top.name}`;
  const more = rest.length ? ` Ещё: ${rest.slice(0, 2).map((c) => c.name).join(', ')}.` : '';
  return `${head}${why.length ? `: ${why.join(', ')}` : ` (итог ${pctRu(top.score)})`}.${more}`;
}
